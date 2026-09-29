'use strict';
// Price feed abstraction for TradeX.
// Providers: 'binance' | 'coinbase' | 'simulated' (default).
//   - binance: combined miniTicker WS stream, parses d.data.s + d.data.c
//   - coinbase: WS ticker channel, maps product_id (BTC-USD/ETH-USD/BNB-USD) -> SYMBOL
//   - simulated: random-walk ticks every 700ms (Binance is geo-blocked from the sandbox)
// The feed_ws_url setting overrides the provider's default WS URL.
// Maintains latest prices, a 5-second candle ring buffer per asset (last 400),
// staleness tracking, tick listeners (for SSE), and hot-switching.
const WebSocket = require('ws');

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
const SEEDS = { BTCUSDT: 97500, ETHUSDT: 3420, BNBUSDT: 695 };
const VOLS = { BTCUSDT: 0.0004, ETHUSDT: 0.0006, BNBUSDT: 0.0008 };
const COINBASE_MAP = { 'BTC-USD': 'BTCUSDT', 'ETH-USD': 'ETHUSDT', 'BNB-USD': 'BNBUSDT' };
const CANDLE_MS = 5000;
const MAX_CANDLES = 400;
const STALE_MS = 10000;

let dbRef = null;
let provider = 'simulated';
let ws = null;
let simTimer = null;
let reconnectTimer = null;
let backoffMs = 1000;
const latest = {}; // symbol -> { price, ts }
const candles = {}; // symbol -> [{ t, o, h, l, c }]
const tickListeners = new Set();

const r2 = (n) => Math.round(Number(n) * 100) / 100;

function getSetting(key) {
  const r = dbRef.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function providerUrl(name) {
  const override = (getSetting('feed_ws_url') || '').trim();
  if (override) return override;
  if (name === 'binance')
    return 'wss://stream.binance.com:9443/stream?streams=btcusdt@miniTicker/ethusdt@miniTicker/bnbusdt@miniTicker';
  if (name === 'coinbase') return 'wss://ws-feed.exchange.coinbase.com';
  return null;
}

function pushTick(symbol, price) {
  price = Number(price);
  if (!SYMBOLS.includes(symbol) || !Number.isFinite(price) || price <= 0) return;
  const ts = Date.now();
  latest[symbol] = { price, ts };
  const bucket = Math.floor(ts / CANDLE_MS) * CANDLE_MS;
  const buf = candles[symbol] || (candles[symbol] = []);
  const lastC = buf[buf.length - 1];
  if (!lastC || lastC.t !== bucket) {
    buf.push({ t: bucket, o: price, h: price, l: price, c: price });
    if (buf.length > MAX_CANDLES) buf.splice(0, buf.length - MAX_CANDLES);
  } else {
    lastC.h = Math.max(lastC.h, price);
    lastC.l = Math.min(lastC.l, price);
    lastC.c = price;
  }
  for (const fn of tickListeners) {
    try {
      fn(symbol, price, ts);
    } catch (e) {
      /* listener errors must not break the feed */
    }
  }
}

function changePct(symbol) {
  const buf = candles[symbol];
  if (!buf || buf.length < 2) return 0;
  return r2(((buf[buf.length - 1].c - buf[0].o) / buf[0].o) * 100);
}

function stopCurrent() {
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.close();
    } catch (e) {}
    ws = null;
  }
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const wait = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 30000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
  console.log(`[feed] ${provider} disconnected, reconnecting in ${wait}ms`);
}

function connectBinance(url) {
  ws = new WebSocket(url);
  ws.on('open', () => {
    backoffMs = 1000;
    console.log('[feed] binance connected');
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      const d = msg.data || msg; // combined stream wraps in {stream, data}
      const sym = String(d.s || '').toUpperCase();
      const price = parseFloat(d.c);
      if (sym && Number.isFinite(price)) pushTick(sym, price);
    } catch (e) {}
  });
  ws.on('close', scheduleReconnect);
  ws.on('error', () => {
    try {
      ws.close();
    } catch (e) {}
  });
}

function connectCoinbase(url) {
  ws = new WebSocket(url);
  ws.on('open', () => {
    backoffMs = 1000;
    ws.send(
      JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD', 'ETH-USD', 'BNB-USD'],
        channels: ['ticker'],
      })
    );
    console.log('[feed] coinbase connected, ticker subscribed');
  });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type !== 'ticker') return;
      const sym = COINBASE_MAP[msg.product_id];
      const price = parseFloat(msg.price);
      if (sym && Number.isFinite(price)) pushTick(sym, price);
    } catch (e) {}
  });
  ws.on('close', scheduleReconnect);
  ws.on('error', () => {
    try {
      ws.close();
    } catch (e) {}
  });
}

function connectSimulated() {
  // Seed the first candle immediately so prices are never null.
  for (const s of SYMBOLS) if (!latest[s]) pushTick(s, SEEDS[s]);
  simTimer = setInterval(() => {
    for (const s of SYMBOLS) {
      const prev = latest[s] ? latest[s].price : SEEDS[s];
      const next = r2(prev * (1 + VOLS[s] * (Math.random() * 2 - 1)));
      pushTick(s, next);
    }
  }, 700);
  console.log('[feed] simulated feed started (700ms random walk)');
}

function connect() {
  stopCurrent();
  if (provider === 'binance') return connectBinance(providerUrl('binance'));
  if (provider === 'coinbase') return connectCoinbase(providerUrl('coinbase'));
  return connectSimulated();
}

// Hot-switch the provider. persist=false when re-applying an already-saved setting.
function setProvider(name, persist = true) {
  const allowed = ['binance', 'coinbase', 'simulated'];
  if (!allowed.includes(name)) throw new Error('Provider must be binance, coinbase or simulated');
  if (persist && dbRef) {
    dbRef
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run('feed_provider', name);
  }
  if (name === provider) return;
  provider = name;
  backoffMs = 1000;
  connect();
}

function applySettings() {
  const name = (getSetting('feed_provider') || 'simulated').trim() || 'simulated';
  if (name !== provider) setProvider(name, false);
  else connect(); // re-connect so a feed_ws_url override takes effect
}

function start(db) {
  dbRef = db;
  provider = (getSetting('feed_provider') || 'simulated').trim() || 'simulated';
  connect();
}

function stop() {
  stopCurrent();
}

function getPrice(symbol) {
  return latest[symbol] || null;
}

function isAssetStale(symbol) {
  const l = latest[symbol];
  return !l || Date.now() - l.ts > STALE_MS;
}

function enabledSymbols() {
  try {
    return dbRef
      .prepare('SELECT symbol FROM assets WHERE enabled = 1')
      .all()
      .map((r) => r.symbol);
  } catch (e) {
    return SYMBOLS.slice();
  }
}

function isStale() {
  return enabledSymbols().some((s) => isAssetStale(s));
}

function getSnapshot() {
  let rows = [];
  try {
    rows = dbRef.prepare('SELECT symbol, label, enabled FROM assets ORDER BY symbol').all();
  } catch (e) {}
  const assets = rows.map((r) => ({
    symbol: r.symbol,
    label: r.label,
    enabled: !!r.enabled,
    price: latest[r.symbol] ? latest[r.symbol].price : null,
    ts: latest[r.symbol] ? latest[r.symbol].ts : null,
    change24h: changePct(r.symbol),
  }));
  const candleMap = {};
  for (const s of SYMBOLS) candleMap[s] = candles[s] || [];
  return { assets, stale: isStale(), candles: candleMap };
}

function onTick(fn) {
  tickListeners.add(fn);
  return () => tickListeners.delete(fn);
}

module.exports = {
  start,
  stop,
  setProvider,
  applySettings,
  getSnapshot,
  getPrice,
  isStale,
  isAssetStale,
  onTick,
};
