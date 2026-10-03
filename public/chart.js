'use strict';
/* TradeX candlestick chart — canvas, requestAnimationFrame, no dependencies.
 * Owns a data model (candles per symbol + position markers) and redraws the
 * whole canvas every frame, so ticks never flicker. devicePixelRatio-aware.
 *
 *   const c = new TradeChart(document.getElementById('chart'));
 *   c.setSymbol('BTCUSDT');
 *   c.setCandles('BTCUSDT', [{t,o,h,l,c}, ...]);   // 5s candles
 *   c.onTick('BTCUSDT', price, ts);                // updates live candle
 *   c.addPositionMarker({id, asset, direction, entry_price, expiry_time});
 *   c.removePositionMarker(id);
 *   c.start(); c.stop();
 */

const CANDLE_MS = 5000;

function decFor(p){
  if(p == null || isNaN(p)) return 2;
  return Math.abs(p) >= 1 ? 2 : 4;
}
function fmtP(p){
  if(p == null || isNaN(p)) return '--';
  return Number(p).toFixed(decFor(p));
}
function fmtClock(t){
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes());
}
function fmtMMSS(ms){
  if(ms < 0) ms = 0;
  const s = Math.ceil(ms / 1000);
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
}

class TradeChart {
  constructor(canvas, opts){
    opts = opts || {};
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.candles = {};          // symbol -> [{t,o,h,l,c}]
    this.symbol = null;
    this.livePrice = null;
    this.positions = new Map(); // id -> {id,asset,direction,entry_price,expiry_time}
    this.viewCount = opts.viewCount || 90;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.running = false;
    this.hover = null;
    this.padR = 68; this.padB = 24; this.padT = 14;
    this.up = '#22c55e'; this.down = '#f6465d';
    this.bg = '#060b14'; this.grid = 'rgba(120,150,200,0.10)'; this.axisText = '#8a94a8';

    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      this.hover = {x: e.clientX - r.left, y: e.clientY - r.top};
    });
    canvas.addEventListener('mouseleave', () => { this.hover = null; });
    window.addEventListener('resize', () => {
      this.dpr = Math.max(1, window.devicePixelRatio || 1);
    });
  }

  setSymbol(sym){ this.symbol = sym; this.livePrice = null; }
  setViewCount(n){ this.viewCount = n; }

  setCandles(sym, data){
    if(!Array.isArray(data)) data = [];
    this.candles[sym] = data.slice(-600).map(c => ({
      t: Number(c.t), o: Number(c.o), h: Number(c.h), l: Number(c.l), c: Number(c.c)
    }));
  }

  onTick(sym, price, ts){
    price = Number(price); ts = Number(ts);
    if(!(price > 0) || !(ts > 0)) return;
    let arr = this.candles[sym];
    if(!arr || !arr.length){
      const b = ts - (ts % CANDLE_MS);
      this.candles[sym] = [{t: b, o: price, h: price, l: price, c: price}];
    } else {
      const last = arr[arr.length - 1];
      const bucket = ts - (ts % CANDLE_MS);
      if(bucket > last.t){
        let t = last.t + CANDLE_MS;
        while(t < bucket){
          arr.push({t, o: last.c, h: last.c, l: last.c, c: last.c});
          t += CANDLE_MS;
        }
        arr.push({t: bucket, o: last.c, h: price, l: price, c: price});
        if(arr.length > 600) arr.splice(0, arr.length - 600);
      } else {
        last.c = price;
        if(price > last.h) last.h = price;
        if(price < last.l) last.l = price;
      }
    }
    if(sym === this.symbol) this.livePrice = price;
  }

  addPositionMarker(p){ this.positions.set(p.id, p); }
  removePositionMarker(id){ this.positions.delete(id); }
  clearPositions(){ this.positions.clear(); }

  start(){
    if(this.running) return;
    this.running = true;
    const loop = () => {
      if(!this.running) return;
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  stop(){ this.running = false; }

  _visible(){
    const arr = this.candles[this.symbol] || [];
    return arr.slice(-this.viewCount);
  }

  render(){
    const canvas = this.canvas, ctx = this.ctx;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if(!w || !h) return;
    const dpr = this.dpr;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if(canvas.width !== W || canvas.height !== H){ canvas.width = W; canvas.height = H; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, w, h);

    const data = this._visible();
    const plotW = w - this.padR, plotH = h - this.padT - this.padB;
    const volH = Math.max(18, Math.round(plotH * 0.13));
    const priceTop = this.padT, priceH = plotH - volH - 6;
    const volTop = priceTop + priceH + 6;

    if(!data.length){
      ctx.fillStyle = this.axisText;
      ctx.font = '12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for price data…', w / 2, h / 2);
      return;
    }

    // ---- range ----
    let lo = Infinity, hi = -Infinity;
    data.forEach(c => { if(c.l < lo) lo = c.l; if(c.h > hi) hi = c.h; });
    this.positions.forEach(p => {
      if(p.asset !== this.symbol) return;
      if(p.entry_price < lo) lo = p.entry_price;
      if(p.entry_price > hi) hi = p.entry_price;
    });
    if(this.livePrice != null){
      if(this.livePrice < lo) lo = this.livePrice;
      if(this.livePrice > hi) hi = this.livePrice;
    }
    if(!(hi > lo)){ hi = lo + 1; }
    const spanPad = (hi - lo) * 0.12 || 1;
    hi += spanPad; lo -= spanPad;
    const y = p => priceTop + (1 - (p - lo) / (hi - lo)) * priceH;
    const py = p => this.padT + (1 - (p - lo) / (hi - lo)) * priceH;

    // ---- grid + price axis ----
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const rows = 5;
    for(let i = 0; i <= rows; i++){
      const p = lo + (hi - lo) * (i / rows);
      const yy = Math.round(py(p)) + 0.5;
      ctx.strokeStyle = this.grid;
      ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke();
      ctx.fillStyle = this.axisText;
      ctx.fillText(fmtP(p), plotW + 6, yy);
    }

    // ---- time axis ----
    ctx.textAlign = 'center';
    const step = 15;
    for(let i = 0; i < data.length; i += step){
      const xx = Math.round((i + 0.5) * (plotW / data.length)) + 0.5;
      ctx.strokeStyle = this.grid;
      ctx.beginPath(); ctx.moveTo(xx, priceTop); ctx.lineTo(xx, priceTop + priceH); ctx.stroke();
      ctx.fillStyle = this.axisText;
      ctx.fillText(fmtClock(data[i].t), xx, h - this.padB / 2);
    }

    // ---- volume bars (pseudo-volume from candle range) ----
    let vMax = 0;
    data.forEach(c => { const v = c.h - c.l; if(v > vMax) vMax = v; });
    if(vMax <= 0) vMax = 1;
    const cw = plotW / data.length;
    const bw = Math.max(1, Math.floor(cw * 0.6));
    data.forEach((c, i) => {
      const v = (c.h - c.l) / vMax;
      const bh = Math.max(1, v * volH);
      const xx = Math.round((i + 0.5) * cw - bw / 2);
      ctx.fillStyle = c.c >= c.o ? 'rgba(34,197,94,0.25)' : 'rgba(246,70,93,0.25)';
      ctx.fillRect(xx, volTop + volH - bh, bw, bh);
    });

    // ---- candles ----
    data.forEach((c, i) => {
      const cx = (i + 0.5) * cw;
      const col = c.c >= c.o ? this.up : this.down;
      ctx.strokeStyle = col; ctx.fillStyle = col;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(cx) + 0.5, Math.round(y(c.h)));
      ctx.lineTo(Math.round(cx) + 0.5, Math.round(y(c.l)));
      ctx.stroke();
      const yo = y(c.o), yc = y(c.c);
      const top = Math.min(yo, yc);
      const bh = Math.max(1, Math.abs(yc - yo));
      const bx = Math.round(cx - bw / 2);
      ctx.fillRect(bx, Math.round(top), bw, Math.round(bh));
    });

    // ---- last price dashed line + tag ----
    const lp = this.livePrice != null ? this.livePrice : data[data.length - 1].c;
    const ly = Math.round(py(lp)) + 0.5;
    const lastUp = lp >= data[data.length - 1].o;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = lastUp ? this.up : this.down;
    ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke();
    ctx.restore();
    const tag = fmtP(lp);
    ctx.font = 'bold 11px system-ui, sans-serif';
    const tw = ctx.measureText(tag).width + 12;
    ctx.fillStyle = lastUp ? this.up : this.down;
    const tagY = Math.min(Math.max(ly - 9, 2), h - this.padB - 18);
    ctx.fillRect(plotW + 2, tagY, this.padR - 6, 18);
    ctx.fillStyle = '#06121f';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(tag, plotW + 8, tagY + 9);

    // ---- open position markers ----
    const now = Date.now();
    this.positions.forEach(p => {
      if(p.asset !== this.symbol) return;
      const ey = Math.round(py(p.entry_price)) + 0.5;
      const clampedY = Math.min(Math.max(ey, priceTop + 2), priceTop + priceH - 2);
      const cur = this.livePrice != null ? this.livePrice : lp;
      let state; // 'win' | 'lose' | 'push'
      if(cur > p.entry_price) state = p.direction === 'up' ? 'win' : 'lose';
      else if(cur < p.entry_price) state = p.direction === 'down' ? 'win' : 'lose';
      else state = 'push';
      const col = state === 'win' ? this.up : state === 'lose' ? this.down : '#8a93a6';

      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, clampedY); ctx.lineTo(plotW, clampedY); ctx.stroke();
      ctx.restore();

      // badge: direction arrow + countdown (+ DEMO tag for paper trades)
      const arrow = p.direction === 'up' ? '▲' : '▼';
      const cd = fmtMMSS(p.expiry_time - now);
      const label = p.demo ? arrow + ' DEMO ' + cd : arrow + ' ' + cd;
      ctx.font = 'bold 10px system-ui, sans-serif';
      const lw = ctx.measureText(label).width + 12;
      const bx = plotW - lw - 4;
      const by = Math.min(Math.max(clampedY - 22, 2), priceTop + priceH - 20);
      ctx.fillStyle = 'rgba(10,14,20,0.92)';
      ctx.strokeStyle = col; ctx.lineWidth = 1;
      if(ctx.roundRect){ ctx.beginPath(); ctx.roundRect(bx, by, lw, 16, 4); ctx.fill(); ctx.stroke(); }
      else { ctx.fillRect(bx, by, lw, 16); ctx.strokeRect(bx, by, lw, 16); }
      ctx.fillStyle = col;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + 6, by + 8.5);
    });

    // ---- crosshair ----
    if(this.hover && this.hover.x < plotW && this.hover.y > priceTop && this.hover.y < priceTop + priceH){
      const hx = Math.round(this.hover.x) + 0.5, hy = Math.round(this.hover.y) + 0.5;
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(150,165,190,0.5)';
      ctx.beginPath(); ctx.moveTo(hx, priceTop); ctx.lineTo(hx, priceTop + priceH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, hy); ctx.lineTo(plotW, hy); ctx.stroke();
      ctx.restore();
      const hp = lo + (hi - lo) * (1 - (this.hover.y - priceTop) / priceH);
      const htag = fmtP(hp);
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#3a4356';
      ctx.fillRect(plotW + 2, hy - 9, this.padR - 6, 18);
      ctx.fillStyle = '#dfe5f0';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(htag, plotW + 8, hy);
      const idx = Math.min(data.length - 1, Math.max(0, Math.floor(this.hover.x / cw)));
      const ttag = fmtClock(data[idx].t);
      const ttw = ctx.measureText(ttag).width + 12;
      ctx.fillStyle = '#3a4356';
      ctx.fillRect(hx - ttw / 2, h - this.padB + 3, ttw, 16);
      ctx.fillStyle = '#dfe5f0';
      ctx.textAlign = 'center';
      ctx.fillText(ttag, hx, h - this.padB + 11);
    }
  }
}
