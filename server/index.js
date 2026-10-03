'use strict';
// TradeX server entry point. Serves the JSON API + static frontend.
// Run:  node server/index.js   (from the project root)
const path = require('path');
const express = require('express');
const db = require('./db');
const H = require('./helpers');
const feed = require('./feed');
const trading = require('./trading');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => res.json({ ok: true, app: 'tradex', phase: 1 }));

app.use('/api/auth', require('./auth')(db, H));
app.use('/api/wallet', require('./wallet')(db, H));
app.use('/api/trade', trading(db, H, feed));
// Admin router is mounted at /api but scoped to /admin inside (so unmatched
// /api/* requests fall through instead of 401ing in adminRequired).
app.use('/api', require('./admin')(db, H, feed));
app.use('/api', require('./chat')());

// Public price snapshot
app.get('/api/prices', (req, res) => res.json(feed.getSnapshot()));

// SSE price stream: snapshot on connect, throttled tick pushes, stale changes, heartbeat.
app.get('/api/feed/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ type: 'snapshot', ...feed.getSnapshot() });

  let lastTick = 0;
  let lastStale = feed.isStale();
  const hb = setInterval(() => res.write(': heartbeat\n\n'), 20000);
  const off = feed.onTick(() => {
    const t = Date.now();
    if (t - lastTick < 500) return;
    lastTick = t;
    const stale = feed.isStale();
    if (stale !== lastStale) {
      lastStale = stale;
      send({ type: 'stale', stale });
    }
    send({ type: 'tick', ...feed.getSnapshot() });
  });

  req.on('close', () => {
    clearInterval(hb);
    off();
  });
});

// Static frontend (includes /app.apk placeholder for the mobile download banner)
// HTML is never cached so deploys take effect immediately; versioned assets cache normally.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  }
}));

feed.start(db);
trading.startSettler(db, feed);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[tradex] listening on http://localhost:${PORT}`);
});
