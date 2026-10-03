'use strict';
/* TradeX SPA — binary-style trading frontend. Vanilla JS, no build step, no CDNs.
 * Views: #/trade #/history #/wallet #/profile #/login #/register #/admin
 * Live data: GET /api/prices once, then SSE /api/feed/stream ticks -> chart + tabs.
 * Two modes: REAL (every trade requires a logged-in user with real balance) and
 * DEMO (client-side paper trading with fake credits, clearly labeled, no login
 * required, never touches /api/trade/*). Toggle via the REAL/DEMO segmented
 * control in the topbar.
 */

const TX_TOKEN = 'tx_token';
const DEMO_PAYOUT = 1.90; // UI fallback before server payout config loads; also demo payout fallback
const TF_LABEL = {30: '30s', 60: '1m', 300: '5m'};
const TF_OPTS = [30, 60, 300];

/* ---------------- helpers ---------------- */
const r2 = n => Math.round(Number(n) * 100) / 100;
const fmt = n => Number(n).toFixed(2);
const getToken = () => localStorage.getItem(TX_TOKEN);

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function fmtDate(d){
  if(!d) return '';
  const dt = new Date(d);
  return isNaN(dt) ? String(d) : dt.toLocaleString();
}
function fmtMMSS(ms){
  if(ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}
function shortSym(sym){ return String(sym || '').replace(/USDT$/i, ''); }

/* Coin badge icon for asset tabs / ticker cards / panel headers.
 * Purely decorative — no behavior hooks. */
function coinBadge(sym){
  const s = String(sym || '').toUpperCase();
  if(s.indexOf('BTC') === 0) return '<span class="coin-badge cb-btc">\u20BF</span>';
  if(s.indexOf('ETH') === 0) return '<span class="coin-badge cb-eth">\u039E</span>';
  if(s.indexOf('BNB') === 0) return '<span class="coin-badge cb-bnb">B</span>';
  const ch = shortSym(sym).charAt(0).toUpperCase() || '?';
  return '<span class="coin-badge cb-def">' + esc(ch) + '</span>';
}

let toastTimer;
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

async function api(method, path, body, opts){
  opts = opts || {};
  const headers = {'Content-Type': 'application/json'};
  const t = getToken();
  if(t && !opts.noAuth) headers['Authorization'] = 'Bearer ' + t;
  const r = await fetch(path, {method, headers, body: body ? JSON.stringify(body) : undefined});
  let data = null;
  try{ data = await r.json(); }catch(e){ /* non-JSON */ }
  if(!r.ok){
    const msg = (data && (data.message || data.error)) || ('Request failed (' + r.status + ')');
    const err = new Error(msg);
    err.status = r.status;
    err.data = data;
    throw err;
  }
  return data || {};
}

/* ---------------- auth state ---------------- */
let me = null; // {username, balance, is_admin}

async function refreshMe(){
  me = null;
  const t = getToken();
  if(!t) return null;
  try{
    const d = await api('GET', '/api/auth/me');
    me = d.user || null;
  }catch(e){
    if(e.status === 401){ localStorage.removeItem(TX_TOKEN); }
  }
  return me;
}
function logout(){
  localStorage.removeItem(TX_TOKEN);
  me = null;
  initHeader();
  location.hash = '#/home';
  toast('Logged out');
}

/* ---------------- modal ---------------- */
function openModal(html){
  const root = document.getElementById('modal-root');
  root.innerHTML = '<div class="modal-scrim"><div class="modal">' + html + '</div></div>';
  root.querySelector('.modal-scrim').addEventListener('click', e => {
    if(e.target.classList.contains('modal-scrim')) closeModal();
  });
  return root.querySelector('.modal');
}
function closeModal(){ document.getElementById('modal-root').innerHTML = ''; }

/* ---------------- price feed engine ---------------- */
const feed = {
  assets: new Map(),   // symbol -> {symbol,label,enabled,price,ts,change24h}
  serverStale: false,
  silent: false,
  lastTick: 0,
  sse: null,
};
const payouts = {}; // "SYM_TF" -> payout multiplier, default 1.90
function payoutFor(sym, tf){ return payouts[sym + '_' + tf] || DEMO_PAYOUT; }

/* Candle cache is the source of truth; every TradeChart instance is hydrated
 * from it, so re-rendering the trade view never loses history. */
const candleCache = {}; // symbol -> [{t,o,h,l,c}]
function ingestCandleTick(sym, price, ts){
  price = Number(price); ts = Number(ts);
  if(!(price > 0) || !(ts > 0)) return;
  let arr = candleCache[sym];
  if(!arr || !arr.length){
    const b = ts - (ts % 5000);
    candleCache[sym] = [{t: b, o: price, h: price, l: price, c: price}];
  } else {
    const last = arr[arr.length - 1];
    const bucket = ts - (ts % 5000);
    if(bucket > last.t){
      let t = last.t + 5000;
      while(t < bucket){
        arr.push({t, o: last.c, h: last.c, l: last.c, c: last.c});
        t += 5000;
      }
      arr.push({t: bucket, o: last.c, h: price, l: price, c: price});
      if(arr.length > 600) arr.splice(0, arr.length - 600);
    } else {
      last.c = price;
      if(price > last.h) last.h = price;
      if(price < last.l) last.l = price;
    }
  }
}
function hydrateChart(){
  if(!chart) return;
  Object.keys(candleCache).forEach(sym => chart.setCandles(sym, candleCache[sym]));
}

let selectedAsset = 'BTCUSDT';
let timeframe = 60;
let amountVal = 10;
let chart = null;

function isStale(){ return feed.serverStale || feed.silent; }

function setStaleBanner(){
  const b = document.getElementById('stale-banner');
  b.hidden = !isStale();
  updateTradeButtons();
}

function assetEnabled(sym){
  const a = feed.assets.get(sym);
  return a ? !!a.enabled : true;
}

async function loadPrices(){
  try{
    const d = await api('GET', '/api/prices', null, {noAuth: true});
    ingestSnapshot(Object.assign({type: 'snapshot'}, d));
    if(chart) chart.setSymbol(selectedAsset);
  }catch(e){
    // backend may still be starting; SSE/watchdog will mark stale
  }
}

function ingestSnapshot(d){
  // d is the backend snapshot: {assets:[...], candles:{SYM:[...]}, stale:bool}
  // (also tolerates the legacy {prices:{SYM:{price,ts}}} shape)
  feed.lastTick = Date.now();
  feed.silent = false;
  if(typeof d.stale === 'boolean' && d.stale !== feed.serverStale){
    feed.serverStale = d.stale;
  }
  let structureSig = '';
  (d.assets || []).forEach(a => {
    const cur = feed.assets.get(a.symbol);
    const price = Number(a.price);
    feed.assets.set(a.symbol, {
      symbol: a.symbol, label: a.label || shortSym(a.symbol),
      enabled: a.enabled !== false,
      price: price > 0 ? price : (cur && cur.price > 0 ? cur.price : 0),
      ts: Number(a.ts) || (cur ? cur.ts : 0),
      change24h: Number(a.change24h) || 0
    });
  });
  // legacy contract shape fallback
  Object.keys(d.prices || {}).forEach(sym => {
    const p = d.prices[sym];
    const cur = feed.assets.get(sym);
    feed.assets.set(sym, {
      symbol: sym, label: cur ? cur.label : shortSym(sym), enabled: cur ? cur.enabled : true,
      price: Number(p.price) || (cur ? cur.price : 0),
      ts: Number(p.ts) || Date.now(), change24h: cur ? cur.change24h : 0
    });
  });
  Object.keys(d.candles || {}).forEach(sym => {
    candleCache[sym] = (d.candles[sym] || []).slice(-600).map(c => ({
      t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c)
    }));
  });
  feed.assets.forEach(a => { structureSig += a.symbol + (a.enabled ? '1' : '0') + ';'; });
  if(structureSig !== ingestSnapshot._sig){
    ingestSnapshot._sig = structureSig;
    renderAssetTabs();
    if(!feed.assets.has(selectedAsset) && feed.assets.size){
      selectedAsset = feed.assets.keys().next().value;
    }
  }
  hydrateChart();
  const av = feed.assets.get(selectedAsset);
  if(chart && av && av.price > 0) chart.livePrice = av.price;
  updateAssetTabPrices();
  updateTradeButtons();
  setStaleBanner();
  throttledPositionsTick();
}

function connectSSE(){
  if(feed.sse){ try{ feed.sse.close(); }catch(e){} }
  let es;
  try{ es = new EventSource('/api/feed/stream'); }
  catch(e){ feed.silent = true; setStaleBanner(); return; }
  feed.sse = es;
  const onData = d => {
    if(!d || typeof d !== 'object') return;
    if(d.type === 'tick' || d.type === 'snapshot') ingestSnapshot(d);
    else if(d.type === 'stale'){ feed.serverStale = !!d.stale; setStaleBanner(); }
  };
  es.onmessage = ev => { try{ onData(JSON.parse(ev.data)); }catch(e){} };
  es.addEventListener('tick', ev => { try{ onData(JSON.parse(ev.data)); }catch(e){} });
  es.addEventListener('snapshot', ev => { try{ onData(JSON.parse(ev.data)); }catch(e){} });
  es.addEventListener('stale', ev => {
    try{ feed.serverStale = !!JSON.parse(ev.data).stale; setStaleBanner(); }catch(e){}
  });
  es.onerror = () => { /* browser auto-retries; watchdog flags silence */ };
  // silence watchdog
  setInterval(() => {
    if(feed.lastTick && Date.now() - feed.lastTick > 20000){
      if(!feed.silent){ feed.silent = true; setStaleBanner(); }
    }
  }, 5000);
}

/* ---------------- header / tabs / balance ---------------- */
function renderAssetTabs(){
  const nav = document.getElementById('asset-tabs');
  nav.innerHTML = '';
  feed.assets.forEach(a => {
    const b = document.createElement('button');
    b.className = 'asset-tab' + (a.symbol === selectedAsset ? ' active' : '') + (a.enabled ? '' : ' off');
    b.dataset.sym = a.symbol;
    const chg = Number(a.change24h) || 0;
    b.innerHTML =
      coinBadge(a.symbol) +
      '<div><div class="sym">' + esc(a.label || shortSym(a.symbol)) + '/USDT</div>' +
      '<div class="px num">' + esc(fmt(a.price)) + '</div>' +
      '<div class="chg num ' + (chg >= 0 ? 'pos' : 'neg') + '">' + (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%</div></div>';
    b.addEventListener('click', () => selectAsset(a.symbol));
    nav.appendChild(b);
  });
}
function updateAssetTabPrices(){
  document.querySelectorAll('#asset-tabs .asset-tab').forEach(b => {
    const a = feed.assets.get(b.dataset.sym);
    if(!a) return;
    const px = b.querySelector('.px');
    if(px) px.textContent = fmt(a.price);
    const chg = b.querySelector('.chg');
    if(chg){
      const c = Number(a.change24h) || 0;
      chg.textContent = (c >= 0 ? '+' : '') + c.toFixed(2) + '%';
      chg.className = 'chg num ' + (c >= 0 ? 'pos' : 'neg');
    }
  });
}
function selectAsset(sym){
  selectedAsset = sym;
  if(chart) chart.setSymbol(sym);
  renderAssetTabs();
  syncChartPositions();
  updateTradeButtons();
  renderPositions();
}

async function refreshBalance(){
  const pill = document.getElementById('bal-pill');
  if(isDemo()){
    pill.className = 'demo';
    pill.hidden = false;
    pill.textContent = fmt(demoBal) + ' DEMO';
    return demoBal;
  }
  pill.className = '';
  const t = getToken();
  if(!t){ pill.hidden = true; return 0; }
  try{
    const m = await refreshMe();
    if(m){
      pill.hidden = false;
      pill.textContent = fmt(m.balance) + ' USDT';
      return m.balance;
    }
  }catch(e){}
  pill.hidden = true;
  return 0;
}

function initHeader(){
  const area = document.getElementById('auth-area');
  const t = getToken();
  if(!t){
    area.innerHTML = '<a href="#/login">Login</a><a href="#/register" class="btn btn-small btn-green">Register</a>';
  } else {
    area.innerHTML = '<span class="username">' + esc(me ? me.username : '') + '</span>' +
      '<a href="#/profile">Profile</a>' +
      (me && me.is_admin ? '<a href="#/admin" style="color:var(--gold)">Admin</a>' : '');
  }
  refreshBalance();
  renderDrawer();
  syncModeUI(); // show/hide REAL/DEMO toggle with login state
}

function renderDrawer(){
  const d = document.getElementById('drawer');
  const logged = !!getToken();
  d.innerHTML =
    '<div class="drawer-scrim"></div>' +
    '<div class="drawer-panel">' +
    '<div class="drawer-head">Trade<b>X</b></div>' +
    '<a href="#/trade">Trade</a>' +
    '<a href="#/history">History</a>' +
    '<a href="#/wallet">Wallet</a>' +
    (logged ? '<a href="#/profile">Profile</a>' : '<a href="#/login">Login</a><a href="#/register">Register</a>') +
    (me && me.is_admin ? '<a href="#/admin">Admin panel</a>' : '') +
    '</div>';
  d.querySelector('.drawer-scrim').addEventListener('click', closeDrawer);
  d.querySelectorAll('a[href^="#/"]').forEach(a => a.addEventListener('click', closeDrawer));
}
function openDrawer(){ document.getElementById('drawer').hidden = false; }
function closeDrawer(){ document.getElementById('drawer').hidden = true; }

function initDlBanner(){
  const b = document.getElementById('dlbanner');
  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  if(!isMobile) return;
  if(localStorage.getItem('tx_dlhide') === '1') return;
  b.hidden = false;
  document.getElementById('dlbanner-x').addEventListener('click', () => {
    b.hidden = true;
    localStorage.setItem('tx_dlhide', '1');
  });
}

/* ---------------- demo paper-trading engine ----------------
 * Client-side only: fake credits in localStorage, settled locally against the
 * live price feed. Never touches /api/trade/*. Always labeled DEMO. */
const DEMO_KEY = 'tx_demo_state';
const DEMO_START_BAL = 1000;
let demoMode = false;
let demoBal = DEMO_START_BAL;
let demoOpen = [];    // {id,asset,direction,timeframe,amount,entry_price,entry_time,expiry_time,payout}
let demoHistory = []; // settled, newest first

function loadDemo(){
  try{
    const s = JSON.parse(localStorage.getItem(DEMO_KEY) || '{}');
    if(typeof s.demoMode === 'boolean') demoMode = s.demoMode;
    if(typeof s.demoBal === 'number' && s.demoBal >= 0) demoBal = s.demoBal;
    if(Array.isArray(s.demoOpen)) demoOpen = s.demoOpen.filter(t => t && t.expiry_time > Date.now() - 86400000);
    if(Array.isArray(s.demoHistory)) demoHistory = s.demoHistory.slice(0, 200);
  }catch(e){ /* corrupted state -> defaults */ }
}
function saveDemo(){
  try{
    localStorage.setItem(DEMO_KEY, JSON.stringify({
      demoMode, demoBal, demoOpen, demoHistory: demoHistory.slice(0, 200)
    }));
  }catch(e){ /* storage blocked/full */ }
}
function isDemo(){ return demoMode; }

function setDemo(b){
  if(b && !getToken()){ toast('Please login to use Demo mode'); return; }
  demoMode = !!b;
  saveDemo();
  syncModeUI();
  refreshBalance();
  updateTradeButtons();
  syncChartPositions();
  render(); // re-render current view (positions/history/wallet/profile demo branches)
}

function syncModeUI(){
  const logged = !!getToken();
  if(!logged && demoMode){ demoMode = false; saveDemo(); } // no demo for logged-out visitors
  const seg = document.getElementById('mode-seg');
  if(seg){
    seg.hidden = !logged; // REAL/DEMO toggle only inside the logged-in account
    seg.querySelectorAll('button').forEach(x =>
      x.classList.toggle('active', (x.dataset.mode === 'demo') === demoMode));
  }
  const db = document.getElementById('demo-banner');
  if(db) db.hidden = !demoMode;
  if(document.body && document.body.classList) document.body.classList.toggle('demo-on', demoMode);
}

function initDemoEngine(){
  loadDemo();
  const seg = document.getElementById('mode-seg');
  if(seg) seg.querySelectorAll('button').forEach(x =>
    x.addEventListener('click', () => setDemo(x.dataset.mode === 'demo')));
  syncModeUI();
  setInterval(settleDemo, 1000);
}

function demoPlace(direction){
  const amt = r2(amountVal);
  if(!(amt > 0)){ toast('Enter a valid amount'); return; }
  if(amt > demoBal){ toast('Insufficient demo balance'); return; }
  if(isStale()){ toast('Price feed stale — betting paused'); return; }
  if(!assetEnabled(selectedAsset)){ toast('This asset is currently disabled'); return; }
  const a = feed.assets.get(selectedAsset);
  const px = a && a.price > 0 ? a.price : 0;
  if(!(px > 0)){ toast('No live price for this asset yet'); return; }
  const now = Date.now();
  const t = {
    id: 'demo-' + now.toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36),
    asset: selectedAsset, direction, timeframe, amount: amt,
    entry_price: px, entry_time: now, expiry_time: now + timeframe * 1000,
    payout: payoutFor(selectedAsset, timeframe)
  };
  demoBal = r2(demoBal - amt);
  demoOpen.push(t);
  saveDemo();
  if(chart) chart.addPositionMarker({
    id: t.id, asset: t.asset, direction: t.direction,
    entry_price: t.entry_price, expiry_time: t.expiry_time, demo: true
  });
  refreshBalance();
  renderPositions();
  toast((direction === 'up' ? '▲ UP' : '▼ DOWN') + ' ' + shortSym(t.asset) + ' @ ' + fmt(t.entry_price) + ' — DEMO');
}

function settleDemo(){
  const now = Date.now();
  let changed = false;
  demoOpen = demoOpen.filter(t => {
    if(t.expiry_time > now) return true;
    const a = feed.assets.get(t.asset);
    const settle = a && a.price > 0 ? a.price : t.entry_price;
    let result;
    if(settle > t.entry_price) result = t.direction === 'up' ? 'won' : 'lost';
    else if(settle < t.entry_price) result = t.direction === 'down' ? 'won' : 'lost';
    else result = 'push';
    const mult = t.payout || DEMO_PAYOUT;
    let pnl;
    if(result === 'won'){ demoBal = r2(demoBal + t.amount * mult); pnl = r2(t.amount * (mult - 1)); }
    else if(result === 'lost'){ pnl = r2(-t.amount); }
    else { demoBal = r2(demoBal + t.amount); pnl = 0; }
    demoHistory.unshift({
      id: t.id, asset: t.asset, direction: t.direction, timeframe: t.timeframe,
      amount: t.amount, entry_price: t.entry_price, settle_price: settle,
      result, pnl, settled_at: now
    });
    demoHistory = demoHistory.slice(0, 200);
    if(chart) chart.removePositionMarker(t.id);
    changed = true;
    return false;
  });
  if(changed){
    saveDemo();
    refreshBalance();
    renderPositions();
  }
}

function resetDemo(){
  demoBal = DEMO_START_BAL;
  demoOpen = [];
  demoHistory = [];
  saveDemo();
  syncChartPositions();
  refreshBalance();
  renderPositions();
  toast('Demo balance reset to ' + DEMO_START_BAL);
}

/* ---------------- real trade flow ---------------- */
let realOpen = []; // open real trades from server
let openPollTimer = null;

async function refreshRealOpen(){
  if(!getToken()){ realOpen = []; return; }
  try{
    const d = await api('GET', '/api/trade/open');
    const prev = new Set(realOpen.map(t => t.id));
    realOpen = d.trades || [];
    if(!isDemo()){
      const now = new Set(realOpen.map(t => t.id));
      prev.forEach(id => { if(!now.has(id) && chart) chart.removePositionMarker(id); });
      realOpen.forEach(t => {
        if(chart && t.status === 'open'){
          chart.addPositionMarker({
            id: t.id, asset: t.asset, direction: t.direction,
            entry_price: Number(t.entry_price), expiry_time: Number(t.expiry_time)
          });
          payouts[t.asset + '_' + t.timeframe] = Number(t.payout_mult) || DEMO_PAYOUT;
        }
      });
    }
    renderPositions();
  }catch(e){ /* keep old list */ }
}

async function placeReal(direction){
  const amt = r2(amountVal);
  if(!(amt > 0)){ toast('Enter a valid amount'); return; }
  setTradeBusy(true);
  try{
    const d = await api('POST', '/api/trade/place', {
      asset: selectedAsset, direction, timeframe, amount: amt
    });
    const t = d.trade;
    payouts[t.asset + '_' + t.timeframe] = Number(t.payout_mult) || DEMO_PAYOUT;
    if(chart) chart.addPositionMarker({
      id: t.id, asset: t.asset, direction: t.direction,
      entry_price: Number(t.entry_price), expiry_time: Number(t.expiry_time)
    });
    await refreshBalance();
    await refreshRealOpen();
    toast((direction === 'up' ? 'UP' : 'DOWN') + ' ' + shortSym(t.asset) + ' @ ' + fmt(t.entry_price));
  }catch(e){
    if(e.status === 503 || /stale/i.test(e.message)){
      feed.serverStale = true; setStaleBanner();
      toast('Price feed stale — betting paused');
    } else toast(e.message);
  }
  setTradeBusy(false);
}

function placeTrade(direction){
  if(isDemo()){ demoPlace(direction); return; }
  if(!getToken()){ location.hash = '#/login'; toast('Login to trade with real funds'); return; }
  placeReal(direction);
}

function setTradeBusy(b){
  ['trade-up', 'trade-down'].forEach(id => {
    const el = document.getElementById(id);
    if(el && !b) updateTradeButtons();
    else if(el) el.disabled = b;
  });
}

function updateTradeButtons(){
  const up = document.getElementById('trade-up');
  const dn = document.getElementById('trade-down');
  if(!up || !dn) return;
  const logged = !!getToken();
  const demo = isDemo();
  const can = demo || logged;
  const stale = isStale();
  const en = assetEnabled(selectedAsset);
  const dis = !can || stale || !en;
  up.disabled = dn.disabled = dis;
  let reason = '';
  if(!can) reason = 'Login to trade';
  else if(stale) reason = 'Price feed stale — betting paused';
  else if(!en) reason = 'This asset is currently disabled';
  else if(demo) reason = 'Demo mode — paper trading with fake credits';
  up.title = dn.title = reason;
  const hint = document.getElementById('login-hint');
  if(hint){
    hint.innerHTML = demo
      ? '<span class="demo-tag">DEMO</span> <span class="muted">Paper trading with fake credits — no login needed.</span>'
      : (!logged ? '<a href="#/login">Log in</a> to trade with real funds.' : '');
  }
}

/* ---------------- trade view ---------------- */
function syncChartPositions(){
  if(!chart) return;
  chart.clearPositions();
  if(isDemo()){
    demoOpen.forEach(t => chart.addPositionMarker({
      id: t.id, asset: t.asset, direction: t.direction,
      entry_price: t.entry_price, expiry_time: t.expiry_time, demo: true
    }));
  } else {
    realOpen.forEach(t => {
      if(t.status === 'open') chart.addPositionMarker({
        id: t.id, asset: t.asset, direction: t.direction,
        entry_price: Number(t.entry_price), expiry_time: Number(t.expiry_time)
      });
    });
  }
}

function allOpenPositions(){
  const list = [];
  if(isDemo()){
    demoOpen.forEach(t => list.push({
      id: t.id, asset: t.asset, direction: t.direction, amount: Number(t.amount),
      entry_price: Number(t.entry_price), entry_time: Number(t.entry_time),
      expiry_time: Number(t.expiry_time), timeframe: t.timeframe,
      payout: Number(t.payout) || payoutFor(t.asset, t.timeframe), demo: true
    }));
  } else {
    realOpen.forEach(t => list.push({
      id: t.id, asset: t.asset, direction: t.direction, amount: Number(t.amount),
      entry_price: Number(t.entry_price), entry_time: Number(t.entry_time),
      expiry_time: Number(t.expiry_time), timeframe: t.timeframe,
      payout: Number(t.payout_mult) || payoutFor(t.asset, t.timeframe)
    }));
  }
  list.sort((a, b) => a.expiry_time - b.expiry_time);
  return list;
}

function posLivePnl(p){
  const a = feed.assets.get(p.asset);
  const cur = a && a.price > 0 ? a.price : p.entry_price;
  let win;
  if(cur > p.entry_price) win = p.direction === 'up';
  else if(cur < p.entry_price) win = p.direction === 'down';
  else return {pnl: 0, state: 'push', cur};
  const mult = p.payout || payoutFor(p.asset, p.timeframe) || DEMO_PAYOUT;
  return win
    ? {pnl: r2(p.amount * (mult - 1)), state: 'win', cur}
    : {pnl: r2(-p.amount), state: 'lose', cur};
}

function renderPositions(){
  const box = document.getElementById('positions-list');
  if(!box) return;
  const list = allOpenPositions();
  if(!list.length){
    box.innerHTML = '<div class="empty">No open positions. Place a trade above.</div>';
    return;
  }
  const now = Date.now();
  box.innerHTML = list.map(p => {
    const live = posLivePnl(p);
    const total = p.expiry_time - p.entry_time;
    const left = Math.max(0, p.expiry_time - now);
    const pct = total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 0;
    const dirCls = p.direction === 'up' ? 'dir-up-t' : 'dir-down-t';
    const pnlCls = live.state === 'win' ? 'win' : live.state === 'lose' ? 'lose' : 'push';
    const pnlTxt = live.state === 'push' ? '0.00' : (live.pnl >= 0 ? '+' : '') + fmt(live.pnl);
    return '<div class="pos-card">' +
      '<div class="pos-head"><span class="' + dirCls + '">' + (p.direction === 'up' ? '▲ UP' : '▼ DOWN') +
      ' ' + esc(shortSym(p.asset)) + '</span>' + (p.demo ? '<span class="demo-tag">DEMO</span>' : '') +
      '<span class="pos-pnl ' + pnlCls + ' num">' + pnlTxt + ' USDT</span></div>' +
      '<div class="pos-meta"><span>Amount <b class="num">' + fmt(p.amount) + '</b></span>' +
      '<span>Entry <b class="num">' + fmt(p.entry_price) + '</b></span>' +
      '<span>Live <b class="num">' + fmt(live.cur) + '</b></span>' +
      '<span>Payout <b class="num">' + (p.payout || payoutFor(p.asset, p.timeframe)).toFixed(2) + 'x</b></span></div>' +
      '<div class="pos-bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
      '<div class="pos-cd num">' + fmtMMSS(left) + ' left</div>' +
      '</div>';
  }).join('');
}

let posTickLast = 0;
function throttledPositionsTick(){
  const now = Date.now();
  if(now - posTickLast < 1000) return;
  posTickLast = now;
  if(parseHash().view === 'trade') renderPositions();
}

function updatePayoutLine(){
  const el = document.getElementById('payout-line');
  if(!el) return;
  const mult = payoutFor(selectedAsset, timeframe);
  const win = r2(amountVal * mult);
  el.innerHTML = '<span>Payout <b>' + mult.toFixed(2) + 'x</b> · ' + esc(TF_LABEL[timeframe]) + '</span>' +
    '<span class="win num">win ' + fmt(win) + ' USDT</span>';
}

async function viewTrade(el){
  const a = feed.assets.get(selectedAsset);
  const aLabel = a ? (a.label || shortSym(selectedAsset)) : shortSym(selectedAsset);
  el.innerHTML =
    '<div class="trade-layout">' +
    '<div class="chart-wrap"><div class="chart-head"><span class="chart-sym">' + esc(aLabel) + '/USDT</span><span class="chart-live num" id="chart-live"></span></div><canvas id="chart"></canvas></div>' +
    '<aside class="trade-panel">' +
      '<div class="tp-head">' + coinBadge(selectedAsset) +
        '<div class="tp-title"><h3>' + esc(aLabel) + '/USDT</h3><span class="muted num" id="panel-price"></span></div>' +
        '<span class="live-dot sm"></span>' +
      '</div>' +
      '<div class="tp-label">Contract length</div>' +
      '<div class="tf-row">' + TF_OPTS.map(tf =>
        '<button class="tf-pill' + (tf === timeframe ? ' active' : '') + '" data-tf="' + tf + '">' + TF_LABEL[tf] + '</button>'
      ).join('') + '</div>' +
      '<div class="tp-label">Stake amount (USDT)</div>' +
      '<div class="amt-row">' +
        '<input class="amt-input num" id="trade-amount" type="number" min="1" step="1" value="' + amountVal + '" inputmode="decimal">' +
        [10, 25, 50, 100].map(v => '<button class="chip" data-amt="' + v + '">' + v + '</button>').join('') +
      '</div>' +
      '<div class="payout-line" id="payout-line"></div>' +
      '<div class="dir-row">' +
        '<button class="dir-btn dir-up" id="trade-up"><span class="arr">▲</span>UP<small id="up-sub"></small></button>' +
        '<button class="dir-btn dir-down" id="trade-down"><span class="arr">▼</span>DOWN<small id="dn-sub"></small></button>' +
      '</div>' +
      '<div class="login-hint" id="login-hint"></div>' +
    '</aside>' +
    '</div>' +
    '<section class="positions" id="positions"><h3>Open positions</h3><div id="positions-list"></div></section>';

  // chart
  const cv = document.getElementById('chart');
  if(chart) chart.stop();
  chart = new TradeChart(cv);
  chart.setSymbol(selectedAsset);
  hydrateChart();
  const _av = feed.assets.get(selectedAsset);
  if(_av && _av.price > 0) chart.livePrice = _av.price;
  chart.start();
  await loadPrices();
  syncChartPositions();

  // live panel price ticker
  const priceTick = setInterval(() => {
    const pe = document.getElementById('panel-price');
    const av = feed.assets.get(selectedAsset);
    if(pe && av) pe.textContent = fmt(av.price) + ' USDT';
    const ce = document.getElementById('chart-live');
    if(ce && av && av.price > 0){
      const chg = Number(av.change24h) || 0;
      ce.innerHTML = fmt(av.price) + ' &nbsp;<span class="' + (chg >= 0 ? 'tk-up' : 'tk-dn') + '">' +
        (chg >= 0 ? '\u25B2 +' : '\u25BC ') + chg.toFixed(2) + '%</span>';
    }
  }, 500);
  el._cleanup = () => clearInterval(priceTick);

  // panel events
  el.querySelectorAll('.tf-pill').forEach(b => b.addEventListener('click', () => {
    timeframe = Number(b.dataset.tf);
    el.querySelectorAll('.tf-pill').forEach(x => x.classList.toggle('active', x === b));
    updatePayoutLine();
  }));
  el.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => {
    amountVal = Number(b.dataset.amt);
    document.getElementById('trade-amount').value = amountVal;
    updatePayoutLine();
  }));
  document.getElementById('trade-amount').addEventListener('input', e => {
    amountVal = parseFloat(e.target.value) || 0;
    updatePayoutLine();
  });
  document.getElementById('trade-up').addEventListener('click', () => placeTrade('up'));
  document.getElementById('trade-down').addEventListener('click', () => placeTrade('down'));

  updatePayoutLine();
  updateTradeButtons();
  renderPositions();
  await refreshRealOpen();

  // poll real open trades while on this view
  clearInterval(openPollTimer);
  openPollTimer = setInterval(() => {
    if(parseHash().view === 'trade') refreshRealOpen();
  }, 8000);

  if(window._scrollToPositions){
    window._scrollToPositions = false;
    setTimeout(() => {
      const s = document.getElementById('positions');
      if(s) s.scrollIntoView({behavior: 'smooth'});
    }, 150);
  }
}

/* ---------------- history view ---------------- */
function resultCls(s){
  s = String(s || '').toLowerCase();
  if(s === 'won') return 'st-won';
  if(s === 'lost') return 'st-lost';
  if(s === 'push') return 'st-push';
  if(s === 'void') return 'st-void';
  return 'st-open';
}
async function viewHistory(el){
  el.innerHTML = '<h2>Trade history</h2><div id="hist-body"><p class="loading">Loading…</p></div>';
  const box = document.getElementById('hist-body');
  let real = [];
  if(getToken()){
    try{
      const d = await api('GET', '/api/trade/history?limit=50');
      real = d.trades || [];
    }catch(e){ /* history requires login */ }
  }
  const rows = [];
  real.forEach(t => rows.push({
    time: t.settled_at || t.expiry_time || t.entry_time,
    asset: t.asset, dir: t.direction, tf: t.timeframe,
    amount: Number(t.amount), entry: Number(t.entry_price),
    settle: Number(t.settle_price), result: t.status,
    pnl: Number(t.pnl)
  }));
  if(isDemo()){
    demoHistory.forEach(t => rows.push({
      time: t.settled_at, asset: t.asset, dir: t.direction, tf: t.timeframe,
      amount: Number(t.amount), entry: Number(t.entry_price),
      settle: Number(t.settle_price), result: t.result,
      pnl: Number(t.pnl), demo: true
    }));
  }
  rows.sort((a, b) => (b.time || 0) - (a.time || 0));
  if(!rows.length){
    box.innerHTML = '<div class="empty">No settled trades yet.</div>';
    return;
  }
  let s = '<div class="table-wrap"><table class="tbl"><tr><th>Time</th><th>Asset</th><th>Dir</th><th>TF</th>' +
    '<th>Amount</th><th>Entry</th><th>Settle</th><th>Result</th><th>PnL</th></tr>';
  rows.slice(0, 80).forEach(t => {
    const pnlCls = t.pnl > 0 ? 'pnl-win' : t.pnl < 0 ? 'pnl-lose' : '';
    s += '<tr><td>' + esc(fmtDate(t.time)) + '</td>' +
      '<td>' + esc(shortSym(t.asset)) + (t.demo ? ' <span class="demo-tag">DEMO</span>' : '') + '</td>' +
      '<td>' + (t.dir === 'up' ? '<span class="positive">▲ UP</span>' : '<span class="negative">▼ DOWN</span>') + '</td>' +
      '<td>' + esc(TF_LABEL[t.tf] || (t.tf + 's')) + '</td>' +
      '<td class="num">' + fmt(t.amount) + '</td>' +
      '<td class="num">' + fmt(t.entry) + '</td>' +
      '<td class="num">' + (t.settle ? fmt(t.settle) : '--') + '</td>' +
      '<td class="' + resultCls(t.result) + '">' + esc(String(t.result).toUpperCase()) + '</td>' +
      '<td class="num ' + pnlCls + '">' + (t.pnl > 0 ? '+' : '') + fmt(t.pnl || 0) + '</td></tr>';
  });
  box.innerHTML = s + '</table></div>';
}

/* ---------------- wallet view ---------------- */
async function viewWallet(el){
  el.innerHTML = '<h2>Wallet</h2><div id="wallet-body"><p class="loading">Loading…</p></div>';
  const box = document.getElementById('wallet-body');
  if(isDemo()){
    box.innerHTML =
      '<div class="card"><h3>Demo balance <span class="demo-tag">DEMO</span></h3>' +
      '<div class="big-bal num">' + fmt(demoBal) + ' credits</div>' +
      '<p class="muted">Paper trading with fake credits — no real money involved.</p>' +
      '<p><button class="btn btn-small btn-gold" id="demo-reset">Reset demo balance (1,000)</button></p>' +
      '<p class="muted">' + (getToken()
        ? 'Switch to <b>Real</b> mode above to deposit or withdraw real funds.'
        : '<a href="#/login">Log in</a> and switch to <b>Real</b> mode to deposit real funds.') + '</p></div>';
    document.getElementById('demo-reset').addEventListener('click', () => { resetDemo(); viewWallet(el); });
    return;
  }
  if(!getToken()){ location.hash = '#/login'; return; }
  try{
    const info = await api('GET', '/api/wallet/info');
    const hist = await api('GET', '/api/wallet/history').catch(() => ({txs: []}));
    const txs = hist.txs || hist.transactions || [];
    box.innerHTML =
      '<div class="card"><h3>Balance</h3>' +
      '<div class="big-bal num">' + fmt(me ? me.balance : 0) + ' USDT</div>' +
      '<p class="muted">Min deposit ' + esc(info.min_deposit != null ? fmt(info.min_deposit) : '--') +
      ' USDT · Min withdraw ' + esc(info.min_withdraw != null ? fmt(info.min_withdraw) : '--') + ' USDT</p></div>' +

      '<div class="card"><h3>Deposit USDT</h3>' +
      (info.qr ? '<img class="qr" src="' + esc(info.qr) + '" alt="Deposit QR">' : '') +
      '<div class="wallet-row"><code>' + esc(info.wallet || '') + '</code>' +
      '<button class="btn btn-small" id="copy-wallet">Copy</button></div>' +
      '<p class="muted">Send USDT to the address above, then submit the transaction hash below.</p>' +
      '<div class="form">' +
      '<label>Transaction hash<input type="text" id="dep-hash" autocomplete="off" placeholder="0x…"></label>' +
      '<label>Amount (USDT)<input type="number" id="dep-amt" step="0.01" min="0" inputmode="decimal"></label>' +
      '<button class="btn btn-green" id="dep-submit">Submit deposit</button>' +
      '<p class="muted" id="dep-note"></p>' +
      '</div></div>' +

      '<div class="card"><h3>Withdraw USDT</h3>' +
      '<div class="form">' +
      '<label>Amount (USDT)<input type="number" id="wd-amt" step="0.01" min="0" inputmode="decimal"></label>' +
      '<label>Your USDT address<input type="text" id="wd-addr" autocomplete="off"></label>' +
      '<button class="btn btn-gold" id="wd-submit">Request withdrawal</button>' +
      '<p class="muted" id="wd-note"></p>' +
      '</div></div>' +

      '<div class="card"><h3>Transaction history</h3><div id="tx-hist">' +
      (txs.length ? txTable(txs) : '<p class="muted">No transactions yet.</p>') + '</div></div>';

    document.getElementById('copy-wallet').addEventListener('click', async () => {
      try{ await navigator.clipboard.writeText(info.wallet || ''); toast('Address copied'); }
      catch(e){ toast('Copy failed — select the address manually'); }
    });
    document.getElementById('dep-submit').addEventListener('click', async ev => {
      const btn = ev.target; btn.disabled = true;
      try{
        const tx_hash = document.getElementById('dep-hash').value.trim();
        const amount = parseFloat(document.getElementById('dep-amt').value);
        if(!tx_hash) throw new Error('Enter the transaction hash');
        if(!(amount > 0)) throw new Error('Enter a valid amount');
        await api('POST', '/api/wallet/deposit', {tx_hash, amount});
        document.getElementById('dep-note').textContent =
          'Deposit submitted — pending admin approval. Balance updates after approval.';
        document.getElementById('dep-hash').value = '';
        document.getElementById('dep-amt').value = '';
        toast('Deposit submitted');
      }catch(e){ toast(e.message); }
      btn.disabled = false;
    });
    document.getElementById('wd-submit').addEventListener('click', async ev => {
      const btn = ev.target; btn.disabled = true;
      try{
        const amount = parseFloat(document.getElementById('wd-amt').value);
        const address = document.getElementById('wd-addr').value.trim();
        if(!(amount > 0)) throw new Error('Enter a valid amount');
        if(!address) throw new Error('Enter your USDT address');
        await api('POST', '/api/wallet/withdraw', {amount, address});
        document.getElementById('wd-note').textContent =
          'Withdrawal requested — pending admin approval.';
        document.getElementById('wd-amt').value = '';
        document.getElementById('wd-addr').value = '';
        toast('Withdrawal requested');
      }catch(e){ toast(e.message); }
      btn.disabled = false;
    });
  }catch(e){
    box.innerHTML = '<p class="loading">Failed to load wallet.</p>';
    toast(e.message);
  }
}
function txTable(txs){
  let s = '<div class="table-wrap"><table class="tbl"><tr><th>Date</th><th>Type</th><th>Amount</th><th>Status</th><th>Ref</th></tr>';
  txs.forEach(t => {
    const st = String(t.status || 'pending').toLowerCase();
    s += '<tr><td>' + esc(fmtDate(t.created_at || t.createdAt)) + '</td>' +
      '<td>' + esc(t.kind || t.type || '') + '</td>' +
      '<td class="num">' + fmt(t.amount) + '</td>' +
      '<td class="st-' + esc(st) + '">' + esc(st.toUpperCase()) + '</td>' +
      '<td class="ref" title="' + esc(t.tx_hash || t.address || '') + '">' + esc(t.tx_hash || t.address || '') + '</td></tr>';
  });
  return s + '</table></div>';
}

/* ---------------- profile view ---------------- */
async function viewProfile(el){
  if(isDemo()){
    await refreshMe();
    const wins = demoHistory.filter(t => t.result === 'won').length;
    el.innerHTML =
      '<h2>Profile</h2>' +
      '<div class="card"><h3>Demo account <span class="demo-tag">DEMO</span></h3>' +
      '<p class="muted">Paper-trading balance</p><div class="big-bal num">' + fmt(demoBal) + ' credits</div>' +
      '<p class="muted">Open ' + demoOpen.length + ' · Settled ' + demoHistory.length + ' · Won ' + wins + '</p>' +
      (me
        ? '<p class="muted">Logged in as <b>' + esc(me.username) + '</b></p>' +
          (me.is_admin ? '<p><a href="#/admin">Open admin panel</a></p>' : '') +
          '<p style="margin-top:16px"><button class="btn btn-danger" id="logout-btn" style="width:100%">Logout</button></p>'
        : '<p class="muted"><a href="#/login">Log in</a> to use real funds.</p>') +
      '</div>';
    const lb = document.getElementById('logout-btn');
    if(lb) lb.addEventListener('click', logout);
    return;
  }
  if(!getToken()){ location.hash = '#/login'; return; }
  await refreshMe();
  el.innerHTML =
    '<h2>Profile</h2>' +
    '<div class="card"><h3>' + esc(me ? me.username : '') + '</h3>' +
    '<p class="muted">Balance</p><div class="big-bal num">' + fmt(me ? me.balance : 0) + ' USDT</div>' +
    (me && me.is_admin ? '<p><a href="#/admin">Open admin panel</a></p>' : '') +
    '<p style="margin-top:16px"><button class="btn btn-danger" id="logout-btn" style="width:100%">Logout</button></p></div>';
  document.getElementById('logout-btn').addEventListener('click', logout);
}

/* ---------------- login / register ---------------- */
/* ---------------- landing page ---------------- */
function viewLanding(el){
  const syms = ['BTCUSDT','ETHUSDT','BNBUSDT'];
  const tickHtml = syms.map(sym => {
    const a = feed.assets.get(sym);
    const px = a && a.price > 0 ? fmt(a.price) : '—';
    const chg = a && typeof a.change24h === 'number' ? a.change24h : null;
    const cls = chg == null ? '' : (chg >= 0 ? 'tk-up' : 'tk-dn');
    return '<div class="ticker-item"><div class="tk-top">' + coinBadge(sym) +
      '<div class="tk-sym">' + esc(shortSym(sym)) + ' / USDT</div></div>' +
      '<div class="tk-px num" data-tk-px="' + sym + '">' + px + '</div>' +
      '<div class="tk-chg ' + cls + ' num" data-tk-chg="' + sym + '">' +
      (chg == null ? '&nbsp;' : (chg >= 0 ? '\u25B2 +' : '\u25BC ') + chg.toFixed(2) + '% 24h') + '</div></div>';
  }).join('');

  el.innerHTML =
  '<div class="landing">' +
    '<section class="hero">' +
      '<div class="hero-eyebrow">Market Dashboard</div>' +
      '<span class="hero-badge">Live binary trading</span>' +
      '<h1 class="hero-title">Predict the market.<br>Profit in <span class="hl-gold">30 seconds</span>.</h1>' +
      '<p class="hero-sub">Will BTC go <b class="hl-up">UP</b> or <b class="hl-dn">DOWN</b>? ' +
      'Pick a direction, set your amount, and win up to <b>1.9x</b> on every correct prediction.</p>' +
      '<div class="cta-row">' +
        '<a class="btn btn-gold btn-big" href="#/register">Get Started</a>' +
        '<a class="btn-ghost" href="#/login">Sign In</a>' +
      '</div>' +
    '</section>' +
    '<div class="ticker-strip">' + tickHtml + '</div>' +
    '<h2 class="sec-title">How it works</h2>' +
    '<div class="steps">' +
      '<div class="step-card"><span class="step-num">1</span><h4>Create your account</h4><p>Sign up in under a minute. Try the free demo with 1,000 practice credits — no deposit needed.</p></div>' +
      '<div class="step-card"><span class="step-num">2</span><h4>Pick UP or DOWN</h4><p>Choose BTC, ETH or BNB, set your amount and timeframe — 30 seconds, 1 minute or 5 minutes.</p></div>' +
      '<div class="step-card"><span class="step-num">3</span><h4>Win up to 1.9x</h4><p>If the price moves your way when time expires, you win. Payout is credited instantly to your wallet.</p></div>' +
    '</div>' +
    '<h2 class="sec-title">Why <span class="gold">TradeX</span></h2>' +
    '<div class="feat-grid">' +
      '<div class="feat-card"><div class="feat-ico">◫</div><h4>Pro live charts</h4><p>Real-time candlestick charts with a live price feed, built for fast decisions.</p></div>' +
      '<div class="feat-card"><div class="feat-ico">◈</div><h4>Free demo mode</h4><p>Practice risk-free with 1,000 demo credits inside your account before trading real.</p></div>' +
      '<div class="feat-card"><div class="feat-ico">⚡</div><h4>Fast timeframes</h4><p>30s, 1m and 5m contracts — results in seconds, winnings credited instantly.</p></div>' +
      '<div class="feat-card"><div class="feat-ico">◉</div><h4>Easy deposits</h4><p>Deposit with Easypaisa, JazzCash or crypto. Withdraw straight to your account.</p></div>' +
    '</div>' +
    '<div class="payout-strip"><div class="big">1.9x payout</div>' +
    '<p>Every correct prediction pays up to 1.9x your stake. Transparent odds on every trade.</p></div>' +
    '<p class="risk-note">Risk warning: trading involves risk and you may lose your stake. ' +
    'Only trade what you can afford to lose.</p>' +
    '<div class="landing-foot">© 2026 TradeX</div>' +
  '</div>';

  const tick = setInterval(() => {
    syms.forEach(sym => {
      const a = feed.assets.get(sym);
      if(!a) return;
      const pxEl = el.querySelector('[data-tk-px="' + sym + '"]');
      const chgEl = el.querySelector('[data-tk-chg="' + sym + '"]');
      if(pxEl && a.price > 0) pxEl.textContent = fmt(a.price);
      if(chgEl && typeof a.change24h === 'number'){
        chgEl.textContent = (a.change24h >= 0 ? '\u25B2 +' : '\u25BC ') + a.change24h.toFixed(2) + '% 24h';
        chgEl.className = 'tk-chg ' + (a.change24h >= 0 ? 'tk-up' : 'tk-dn') + ' num';
      }
    });
  }, 2000);
  el._cleanup = () => clearInterval(tick);
}

function viewLogin(el){
  if(getToken()){ location.hash = '#/trade'; return; }
  el.innerHTML =
    '<div class="auth-wrap"><div class="auth-card">' +
    '<div class="auth-brand"><span class="logo-mark">TX</span>Trade<b>X</b></div>' +
    '<h2>Welcome back</h2><p class="auth-sub">Sign in to your TradeX account</p><div class="form">' +
    '<label>Username<input type="text" id="li-user" autocomplete="username" placeholder="Your username"></label>' +
    '<label>Password<input type="password" id="li-pass" autocomplete="current-password" placeholder="Your password"></label>' +
    '<button class="btn btn-green" id="li-go">Sign In</button>' +
    '<p class="auth-swap">New to TradeX? <a href="#/register">Create an account</a></p>' +
    '</div></div></div>';
  const go = async () => {
    const btn = document.getElementById('li-go'); btn.disabled = true;
    try{
      const d = await api('POST', '/api/auth/login', {
        username: document.getElementById('li-user').value.trim(),
        password: document.getElementById('li-pass').value
      }, {noAuth: true});
      localStorage.setItem(TX_TOKEN, d.token);
      await refreshMe();
      initHeader();
      location.hash = '#/trade';
      toast('Welcome, ' + (me ? me.username : ''));
    }catch(e){ toast(e.message); btn.disabled = false; }
  };
  document.getElementById('li-go').addEventListener('click', go);
  document.getElementById('li-pass').addEventListener('keydown', e => { if(e.key === 'Enter') go(); });
}
function viewRegister(el){
  if(getToken()){ location.hash = '#/trade'; return; }
  el.innerHTML =
    '<div class="auth-wrap"><div class="auth-card">' +
    '<div class="auth-brand"><span class="logo-mark">TX</span>Trade<b>X</b></div>' +
    '<h2>Create your account</h2><p class="auth-sub">Start trading in under a minute</p><div class="form">' +
    '<label>Username<input type="text" id="rg-user" autocomplete="username" placeholder="Choose a username"></label>' +
    '<label>Password<input type="password" id="rg-pass" autocomplete="new-password" placeholder="Choose a password"></label>' +
    '<button class="btn btn-gold" id="rg-go">Get Started</button>' +
    '<p class="auth-swap">Already have an account? <a href="#/login">Sign in</a></p>' +
    '</div></div></div>';
  document.getElementById('rg-go').addEventListener('click', async () => {
    const btn = document.getElementById('rg-go'); btn.disabled = true;
    try{
      const d = await api('POST', '/api/auth/register', {
        username: document.getElementById('rg-user').value.trim(),
        password: document.getElementById('rg-pass').value
      }, {noAuth: true});
      localStorage.setItem(TX_TOKEN, d.token);
      await refreshMe();
      initHeader();
      location.hash = '#/trade';
      toast('Account created — welcome, ' + (me ? me.username : ''));
    }catch(e){ toast(e.message); btn.disabled = false; }
  });
}

/* ---------------- admin ---------------- */
async function adminOverview(box){
  box.innerHTML = '<p class="loading">Loading overview…</p>';
  try{
    const d = await api('GET', '/api/admin/overview');
    // ggrByAsset is an array: [{asset, trades, ggr}]
    const ggrRows = Array.isArray(d.ggrByAsset) ? d.ggrByAsset : [];
    const max = Math.max(1, ...ggrRows.map(r => Math.abs(Number(r.ggr) || 0)));
    box.innerHTML =
      '<div class="stat-cards">' +
      statCard('Users', d.users) +
      statCard('Total deposits', fmt(d.totalDeposits) + ' USDT') +
      statCard('Total withdrawals', fmt(d.totalWithdraws) + ' USDT') +
      statCard('Open trades', d.openTrades) +
      statCard('GGR', fmt(d.ggr) + ' USDT') +
      '</div>' +
      '<div class="card"><h3>GGR by asset</h3>' +
      (ggrRows.length ? ggrRows.map(r => {
        const v = Number(r.ggr) || 0;
        const pct = (Math.abs(v) / max * 100).toFixed(1);
        const col = v >= 0 ? 'var(--up)' : 'var(--down)';
        return '<div class="ggr-row"><span class="sym">' + esc(r.asset) + '</span>' +
          '<div class="ggr-bar"><i style="width:' + pct + '%;background:' + col + '"></i></div>' +
          '<span class="val num ' + (v >= 0 ? 'positive' : 'negative') + '">' + fmt(v) + '</span></div>';
      }).join('') : '<p class="muted">No GGR data yet.</p>') +
      '</div>';
  }catch(e){ box.innerHTML = '<p class="loading">Failed to load overview.</p>'; toast(e.message); }
}
function statCard(lbl, val){
  return '<div class="stat-card"><div class="lbl">' + esc(lbl) + '</div>' +
    '<div class="stat-num num">' + esc(String(val == null ? '--' : val)) + '</div></div>';
}

async function adminUsers(box, q){
  q = q || '';
  box.innerHTML =
    '<div class="search-row"><input type="text" id="au-q" placeholder="Search username…" value="' + esc(q) + '">' +
    '<button class="btn btn-small" id="au-go">Search</button></div>' +
    '<div id="au-list"><p class="loading">Loading users…</p></div>';
  const list = box.querySelector('#au-list');
  const load = async query => {
    list.innerHTML = '<p class="loading">Loading users…</p>';
    try{
      const d = await api('GET', '/api/admin/users' + (query ? '?q=' + encodeURIComponent(query) : ''));
      const users = d.users || [];
      if(!users.length){ list.innerHTML = '<p class="muted">No users found.</p>'; return; }
      let s = '<div class="table-wrap"><table class="tbl"><tr><th>ID</th><th>Username</th><th>Balance</th><th>Status</th><th>Actions</th></tr>';
      users.forEach(u => {
        const banned = u.banned || u.status === 'banned';
        s += '<tr><td>' + esc(u.id) + '</td><td>' + esc(u.username) + '</td>' +
          '<td class="num">' + fmt(u.balance) + '</td>' +
          '<td class="' + (banned ? 'st-banned' : 'st-active') + '">' + (banned ? 'BANNED' : 'ACTIVE') + '</td>' +
          '<td class="row-actions">' +
          '<button class="btn btn-small" data-act="adjust" data-id="' + esc(u.id) + '" data-un="' + esc(u.username) + '">Adjust</button> ' +
          '<button class="btn btn-small ' + (banned ? 'btn-green' : 'btn-danger') + '" data-act="ban" data-id="' + esc(u.id) + '" data-b="' + (banned ? 0 : 1) + '">' +
          (banned ? 'Unban' : 'Ban') + '</button></td></tr>';
      });
      list.innerHTML = s + '</table></div>';
      list.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', async () => {
        const id = b.dataset.id;
        if(b.dataset.act === 'ban'){
          b.disabled = true;
          try{
            await api('POST', '/api/admin/users/' + id + '/ban', {banned: b.dataset.b === '1'});
            toast(b.dataset.b === '1' ? 'User banned' : 'User unbanned');
            load(query);
          }catch(e){ toast(e.message); b.disabled = false; }
        } else {
          const m = openModal(
            '<h3>Adjust balance — ' + esc(b.dataset.un) + '</h3>' +
            '<div class="form"><label>Amount (+ credit / - debit)<input type="number" id="adj-amt" step="0.01" inputmode="decimal"></label>' +
            '<button class="btn btn-green" id="adj-go">Apply</button> ' +
            '<button class="btn btn-small" id="adj-x">Cancel</button></div>'
          );
          m.querySelector('#adj-x').addEventListener('click', closeModal);
          m.querySelector('#adj-go').addEventListener('click', async ev => {
            const btn2 = ev.target; btn2.disabled = true;
            try{
              const amount = parseFloat(m.querySelector('#adj-amt').value);
              if(!(amount !== 0) || isNaN(amount)) throw new Error('Enter a non-zero amount');
              await api('POST', '/api/admin/users/' + id + '/adjust', {amount});
              closeModal();
              toast('Balance adjusted');
              load(query);
            }catch(e){ toast(e.message); btn2.disabled = false; }
          });
        }
      }));
    }catch(e){ list.innerHTML = '<p class="loading">Failed to load users.</p>'; toast(e.message); }
  };
  box.querySelector('#au-go').addEventListener('click', () => load(box.querySelector('#au-q').value.trim()));
  box.querySelector('#au-q').addEventListener('keydown', e => {
    if(e.key === 'Enter') load(box.querySelector('#au-q').value.trim());
  });
  load(q);
}

async function adminTx(box){
  box.innerHTML =
    '<div class="search-row">' +
    '<select id="at-status" style="flex:1;background:#0a0e14;border:1px solid var(--border);border-radius:10px;color:var(--text);padding:11px">' +
    '<option value="">All statuses</option><option value="pending">Pending</option>' +
    '<option value="done">Done</option><option value="rejected">Rejected</option></select>' +
    '<select id="at-kind" style="flex:1;background:#0a0e14;border:1px solid var(--border);border-radius:10px;color:var(--text);padding:11px">' +
    '<option value="">All kinds</option><option value="deposit">Deposit</option><option value="withdraw">Withdraw</option></select>' +
    '<button class="btn btn-small" id="at-go">Filter</button></div>' +
    '<div id="at-list"></div>';
  const list = box.querySelector('#at-list');
  const load = async () => {
    list.innerHTML = '<p class="loading">Loading transactions…</p>';
    try{
      const st = box.querySelector('#at-status').value;
      const kind = box.querySelector('#at-kind').value;
      let path = '/api/admin/transactions';
      const qs = [];
      if(st) qs.push('status=' + encodeURIComponent(st));
      if(kind) qs.push('kind=' + encodeURIComponent(kind));
      if(qs.length) path += '?' + qs.join('&');
      const d = await api('GET', path);
      const txs = d.txs || d.transactions || [];
      if(!txs.length){ list.innerHTML = '<p class="muted">No transactions found.</p>'; return; }
      let s = '<div class="table-wrap"><table class="tbl"><tr><th>ID</th><th>User</th><th>Kind</th><th>Amount</th><th>Ref</th><th>Date</th><th>Status</th><th>Actions</th></tr>';
      txs.forEach(t => {
        const stt = String(t.status || 'pending').toLowerCase();
        s += '<tr><td>' + esc(t.id) + '</td><td>' + esc(t.username || t.user_id || '') + '</td>' +
          '<td>' + esc(t.kind || '') + '</td><td class="num">' + fmt(t.amount) + '</td>' +
          '<td class="ref" title="' + esc(t.tx_hash || t.address || '') + '">' + esc(t.tx_hash || t.address || '') + '</td>' +
          '<td>' + esc(fmtDate(t.created_at)) + '</td>' +
          '<td class="st-' + esc(stt) + '">' + esc(stt.toUpperCase()) + '</td>' +
          '<td class="row-actions">' + (stt === 'pending'
            ? '<button class="btn btn-small btn-green" data-act="approve" data-id="' + esc(t.id) + '">Approve</button> ' +
              '<button class="btn btn-small btn-danger" data-act="reject" data-id="' + esc(t.id) + '">Reject</button>'
            : '<span class="muted">—</span>') + '</td></tr>';
      });
      list.innerHTML = s + '</table></div>';
      list.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', async () => {
        b.disabled = true;
        try{
          await api('POST', '/api/admin/transactions/' + b.dataset.id + '/' + b.dataset.act, {});
          toast('Transaction ' + b.dataset.act + 'd');
          load();
        }catch(e){ toast(e.message); b.disabled = false; }
      }));
    }catch(e){ list.innerHTML = '<p class="loading">Failed to load transactions.</p>'; toast(e.message); }
  };
  box.querySelector('#at-go').addEventListener('click', load);
  load();
}

async function adminAssets(box){
  box.innerHTML = '<p class="loading">Loading assets…</p>';
  try{
    const d = await api('GET', '/api/admin/assets');
    const assets = d.assets || [];
    if(!assets.length){ box.innerHTML = '<p class="muted">No assets configured.</p>'; return; }
    box.innerHTML = '';
    assets.forEach(a => {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const on = !!a.enabled;
      row.innerHTML =
        '<span class="grow"><b>' + esc(a.symbol) + '</b> <span class="muted">' + esc(a.label || '') + '</span><br>' +
        '<span class="st-' + (on ? 'enabled' : 'disabled') + '" style="font-size:.8rem">' + (on ? 'ENABLED' : 'DISABLED') + '</span></span>' +
        TF_OPTS.map(tf =>
          '<label style="font-size:.75rem;color:var(--muted)">Payout ' + TF_LABEL[tf] + '<br>' +
          '<input class="mini-input" type="number" step="0.01" min="1" data-tf="' + tf + '" value="' + esc(a['payout_' + tf] != null ? a['payout_' + tf] : DEMO_PAYOUT) + '"></label>'
        ).join('') +
        '<button class="btn btn-small ' + (on ? 'btn-danger' : 'btn-green') + '" data-t="tgl">' + (on ? 'Disable' : 'Enable') + '</button>' +
        '<button class="btn btn-small" data-t="save">Save</button>';
      row.querySelector('[data-t="tgl"]').addEventListener('click', async ev => {
        const btn = ev.target; btn.disabled = true;
        try{
          await api('POST', '/api/admin/assets/' + encodeURIComponent(a.symbol), {enabled: !on});
          toast(a.symbol + (!on ? ' enabled' : ' disabled'));
          adminAssets(box);
          loadPrices();
        }catch(e){ toast(e.message); btn.disabled = false; }
      });
      row.querySelector('[data-t="save"]').addEventListener('click', async ev => {
        const btn = ev.target; btn.disabled = true;
        try{
          const body = {enabled: on};
          let ok = true;
          row.querySelectorAll('input[data-tf]').forEach(inp => {
            const v = parseFloat(inp.value);
            if(!(v >= 1.01 && v <= 5)){ ok = false; }
            body['payout_' + inp.dataset.tf] = v;
          });
          if(!ok) throw new Error('Payouts must be between 1.01 and 5');
          await api('POST', '/api/admin/assets/' + encodeURIComponent(a.symbol), body);
          TF_OPTS.forEach(tf => { payouts[a.symbol + '_' + tf] = body['payout_' + tf]; });
          toast(a.symbol + ' payouts saved');
        }catch(e){ toast(e.message); }
        btn.disabled = false;
      });
      box.appendChild(row);
    });
  }catch(e){ box.innerHTML = '<p class="loading">Failed to load assets.</p>'; toast(e.message); }
}

async function adminSettings(box){
  box.innerHTML = '<p class="loading">Loading settings…</p>';
  try{
    const d = await api('GET', '/api/admin/settings');
    const raw = d.settings || d || {};
    const keys = Object.keys(raw);
    if(!keys.length){ box.innerHTML = '<p class="muted">No settings found.</p>'; return; }
    box.innerHTML = '<p class="muted">Each setting saves individually via <b>POST /api/admin/settings</b> {key, value}.</p>';
    keys.forEach(k => {
      const v = raw[k];
      const row = document.createElement('div');
      row.className = 'set-row';
      let input;
      if(/feed_provider/i.test(k)){
        input = document.createElement('select');
        const opts = ['binance', 'coinbase', 'simulated'];
        if(v && !opts.includes(String(v))) opts.unshift(String(v));
        input.innerHTML = opts.map(o =>
          '<option value="' + esc(o) + '"' + (String(v) === o ? ' selected' : '') + '>' + esc(o) + '</option>'
        ).join('');
        input.style.cssText = 'width:170px;padding:8px;border-radius:8px;border:1px solid var(--border);background:#0a0e14;color:var(--text)';
      } else {
        input = document.createElement('input');
        const num = v !== '' && v != null && !isNaN(Number(v));
        input.type = num ? 'number' : 'text';
        if(num) input.step = 'any';
        input.value = v == null ? '' : v;
      }
      const keyEl = document.createElement('span');
      keyEl.className = 'key';
      keyEl.textContent = k;
      const btn = document.createElement('button');
      btn.className = 'btn btn-small';
      btn.textContent = 'Save';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try{
          let val = input.value;
          if(input.type === 'number' && val !== '') val = Number(val);
          await api('POST', '/api/admin/settings', {key: k, value: val});
          toast('Setting saved: ' + k);
        }catch(e){ toast(e.message); }
        btn.disabled = false;
      });
      row.appendChild(keyEl);
      row.appendChild(input);
      row.appendChild(btn);
      box.appendChild(row);
    });
  }catch(e){ box.innerHTML = '<p class="loading">Failed to load settings.</p>'; toast(e.message); }
}

async function viewAdmin(el){
  await refreshMe();
  if(!me){ location.hash = '#/login'; return; }
  if(!me.is_admin){ el.innerHTML = '<p class="denied">Access denied.</p>'; return; }
  const tabs = [
    ['overview', 'Overview'], ['users', 'Users'], ['tx', 'Transactions'],
    ['assets', 'Assets'], ['settings', 'Settings']
  ];
  el.innerHTML =
    '<h2>Admin panel</h2>' +
    '<div class="tabs">' + tabs.map((t, i) =>
      '<button class="tab' + (i === 0 ? ' active' : '') + '" data-tab="' + t[0] + '">' + t[1] + '</button>'
    ).join('') + '</div>' +
    '<div id="admin-body"></div>';
  const body = el.querySelector('#admin-body');
  const renderTab = tab => {
    el.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    if(tab === 'overview') adminOverview(body);
    else if(tab === 'users') adminUsers(body);
    else if(tab === 'tx') adminTx(body);
    else if(tab === 'assets') adminAssets(body);
    else adminSettings(body);
  };
  el.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => renderTab(b.dataset.tab)));
  renderTab('overview');
}

/* ---------------- router ---------------- */
function parseHash(){
  const h = location.hash || (getToken() ? '#/trade' : '#/home');
  const view = h.replace('#/', '').split('?')[0] || (getToken() ? 'trade' : 'home');
  return {view};
}
function needsAuth(v){ return v === 'wallet' || v === 'profile' || v === 'admin'; }

let currentCleanup = null;
async function render(){
  const main = document.getElementById('app');
  if(currentCleanup){ try{ currentCleanup(); }catch(e){} currentCleanup = null; }
  if(chart && parseHash().view !== 'trade'){ chart.stop(); chart = null; }
  clearInterval(openPollTimer);
  const r = parseHash();
  document.querySelectorAll('#bottomnav a').forEach(a =>
    a.classList.toggle('active', a.getAttribute('href') === '#/' + r.view));
  try{
    if(r.view === 'home'){
      if(getToken()){ location.hash = '#/trade'; return; }
      document.getElementById('bottomnav').style.display = 'none';
      viewLanding(main);
    }else{
      document.getElementById('bottomnav').style.display = '';
      if(needsAuth(r.view) && !getToken() && !isDemo()){ location.hash = '#/login'; return; }
      if(r.view === 'trade') await viewTrade(main);
      else if(r.view === 'history') await viewHistory(main);
      else if(r.view === 'wallet') await viewWallet(main);
      else if(r.view === 'profile') await viewProfile(main);
      else if(r.view === 'login') viewLogin(main);
      else if(r.view === 'register') viewRegister(main);
      else if(r.view === 'admin') await viewAdmin(main);
      else await viewTrade(main);
    }
  }catch(e){ toast(e.message); }
  if(main._cleanup){ currentCleanup = main._cleanup; main._cleanup = null; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', render);

/* ---------------- boot ---------------- */
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('hamburger').addEventListener('click', openDrawer);
  document.querySelector('#bottomnav [data-goto="positions"]').addEventListener('click', e => {
    e.preventDefault();
    window._scrollToPositions = true;
    if(parseHash().view === 'trade') render();
    else location.hash = '#/trade';
  });
  document.querySelector('#bottomnav [data-goto="menu"]').addEventListener('click', e => {
    e.preventDefault();
    openDrawer();
  });
  initDlBanner();
  initDemoEngine();
  refreshMe().then(() => initHeader());
  loadPrices();
  connectSSE();
  render();
});
