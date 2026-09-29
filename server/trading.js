'use strict';
// Trading routes + settlement engine.
// POST /api/trade/place  — place an up/down bet on a live asset price.
// GET  /api/trade/open   — the user's open trades.
// GET  /api/trade/history — the user's settled trades.
// startSettler(db, feed) — 500ms loop settling expired trades server-side.
//   Win profit is capped by max_win_bet per bet and max_win_daily per user per UTC day.
//   Stale feed (or missing price) at expiry => trade is VOID and the stake is refunded.
//   An exact tie (settle == entry) => PUSH, stake refunded.
const express = require('express');

const TIMEFRAMES = { 30: 'payout_30', 60: 'payout_60', 300: 'payout_300' };

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

function factory(db, H, feed) {
  const router = express.Router();
  const needAuth = H.authRequired(db);

  router.post('/place', needAuth, (req, res) => {
    const asset = String(req.body.asset || '').toUpperCase();
    const direction = String(req.body.direction || '').toLowerCase();
    const timeframe = Number(req.body.timeframe);
    const amount = H.r2(req.body.amount);

    const a = db
      .prepare('SELECT symbol, enabled, payout_30, payout_60, payout_300 FROM assets WHERE symbol = ?')
      .get(asset);
    if (!a) return res.status(400).json({ error: 'Unknown asset' });
    if (!a.enabled) return res.status(400).json({ error: 'Asset is disabled' });
    if (direction !== 'up' && direction !== 'down')
      return res.status(400).json({ error: 'direction must be up or down' });
    if (!TIMEFRAMES[timeframe])
      return res.status(400).json({ error: 'timeframe must be 30, 60 or 300 seconds' });
    if (!(amount > 0)) return res.status(400).json({ error: 'Amount must be greater than 0' });

    const payoutMult = Number(a[TIMEFRAMES[timeframe]]);
    if (!(payoutMult >= 1.01))
      return res.status(500).json({ error: 'Asset payout is not configured' });

    if (feed.isStale()) return res.status(503).json({ error: 'feed_stale' });
    const px = feed.getPrice(asset);
    if (!px) return res.status(503).json({ error: 'feed_stale' });

    // Atomic debit so concurrent requests can't double-spend.
    const debit = db
      .prepare('UPDATE users SET balance = ROUND(balance - ?, 2) WHERE id = ? AND ROUND(balance, 2) >= ?')
      .run(amount, req.user.id, amount);
    if (debit.changes === 0) return res.status(400).json({ error: 'Insufficient balance' });

    const entryPrice = px.price;
    const entryTime = Date.now();
    const r = db
      .prepare(
        `INSERT INTO trades (user_id, asset, direction, amount, entry_price, entry_time, expiry_time,
                              timeframe, payout_mult, status)
         VALUES (?,?,?,?,?,?,?,?,?,'open')`
      )
      .run(req.user.id, asset, direction, amount, entryPrice, entryTime, entryTime + timeframe * 1000, timeframe, payoutMult);
    db.prepare(
      `INSERT INTO transactions (user_id, kind, amount, status, method, meta)
       VALUES (?, 'bet', ?, 'settled', 'trade', ?)`
    ).run(req.user.id, amount, JSON.stringify({ trade_id: r.lastInsertRowid, asset, direction, timeframe }));

    const trade = db.prepare('SELECT * FROM trades WHERE id = ?').get(r.lastInsertRowid);
    res.json({ trade });
  });

  router.get('/open', needAuth, (req, res) => {
    const rows = db
      .prepare("SELECT * FROM trades WHERE user_id = ? AND status = 'open' ORDER BY id DESC")
      .all(req.user.id);
    res.json({ trades: rows });
  });

  router.get('/history', needAuth, (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = db
      .prepare("SELECT * FROM trades WHERE user_id = ? AND status != 'open' ORDER BY id DESC LIMIT ?")
      .all(req.user.id, limit);
    res.json({ trades: rows });
  });

  return router;
}

// Settle one expired trade. Everything for a single trade runs in one
// explicit sqlite transaction (node:sqlite has no db.transaction()).
function settleOne(db, H, feed, t) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const px = feed.getPrice(t.asset);

    // Stale feed or no price => void the trade, refund the stake.
    if (!px || feed.isAssetStale(t.asset)) {
      db.prepare("UPDATE trades SET status = 'void', pnl = 0 WHERE id = ?").run(t.id);
      db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(t.amount, t.user_id);
      db.prepare(
        `INSERT INTO transactions (user_id, kind, amount, status, method, meta)
         VALUES (?, 'refund', ?, 'settled', 'trade', ?)`
      ).run(t.user_id, t.amount, JSON.stringify({ trade_id: t.id, reason: 'feed_stale' }));
      db.exec('COMMIT');
      return;
    }

    const settlePrice = px.price;
    let status, pnl, credit, kind;

    if (settlePrice === t.entry_price) {
      // Tie => push, stake refunded.
      status = 'push';
      pnl = 0;
      credit = t.amount;
      kind = 'refund';
    } else {
      const wonTrade =
        (t.direction === 'up' && settlePrice > t.entry_price) ||
        (t.direction === 'down' && settlePrice < t.entry_price);
      if (wonTrade) {
        const profit = H.r2(t.amount * (t.payout_mult - 1));
        const cap1 = Number(getSetting(db, 'max_win_bet') || 1000);
        const cap2raw = Number(getSetting(db, 'max_win_daily') || 5000);
        const daily = Number(
          db
            .prepare(
              "SELECT COALESCE(SUM(pnl),0) AS s FROM trades WHERE user_id = ? AND status = 'won' AND created_at >= datetime('now','start of day')"
            )
            .get(t.user_id).s
        );
        const cap2 = Math.max(0, cap2raw - daily);
        const allowed = H.r2(Math.min(profit, cap1, cap2));
        status = 'won';
        pnl = allowed;
        credit = H.r2(t.amount + allowed);
        kind = 'win';
      } else {
        status = 'lost';
        pnl = H.r2(-t.amount);
        credit = 0;
        kind = null;
      }
    }

    db.prepare('UPDATE trades SET status = ?, settle_price = ?, pnl = ? WHERE id = ?').run(
      status,
      settlePrice,
      pnl,
      t.id
    );
    if (kind) {
      db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(credit, t.user_id);
      db.prepare(
        `INSERT INTO transactions (user_id, kind, amount, status, method, meta)
         VALUES (?, ?, ?, 'settled', 'trade', ?)`
      ).run(t.user_id, kind, credit, JSON.stringify({ trade_id: t.id, status }));
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch (_) {}
    console.error('[settler] trade', t.id, 'failed:', e.message);
  }
}

function startSettler(db, feed) {
  const H = require('./helpers');
  setInterval(() => {
    try {
      const due = db
        .prepare("SELECT * FROM trades WHERE status = 'open' AND expiry_time <= ? ORDER BY id")
        .all(Date.now());
      for (const t of due) settleOne(db, H, feed, t);
    } catch (e) {
      console.error('[settler] loop error:', e.message);
    }
  }, 500);
  console.log('[settler] started (500ms loop)');
}

factory.startSettler = startSettler;
module.exports = factory;
