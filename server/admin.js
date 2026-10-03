'use strict';
// Admin routes (is_admin=1 only).
const express = require('express');

module.exports = (db, H, feed) => {
  const router = express.Router();
  // Scoped to /admin so unmatched /api/* requests fall through instead of 401ing here.
  router.use('/admin', H.adminRequired(db));

  const sumTx = (kind, status) => {
    const r = db
      .prepare('SELECT COALESCE(SUM(amount),0) AS s FROM transactions WHERE kind = ? AND status = ?')
      .get(kind, status);
    return H.r2(r.s);
  };

  // GGR = -(SUM(pnl)) over settled real trades: lost stakes minus capped win profits.
  // Push/void trades are refunded, so their pnl is 0 and they add nothing.
  router.get('/admin/overview', (req, res) => {
    const users = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
    const openTrades = db.prepare("SELECT COUNT(*) AS c FROM trades WHERE status = 'open'").get().c;
    const rows = db
      .prepare(
        `SELECT asset, COUNT(*) AS trades,
           COALESCE(SUM(CASE WHEN status IN ('won','lost') THEN -pnl ELSE 0 END), 0) AS ggr
         FROM trades WHERE status IN ('won','lost','push','void')
         GROUP BY asset ORDER BY asset`
      )
      .all()
      .map((r) => ({ asset: r.asset, trades: r.trades, ggr: H.r2(r.ggr) }));
    const ggr = H.r2(rows.reduce((a, r) => a + r.ggr, 0));
    res.json({
      users,
      totalDeposits: sumTx('deposit', 'done'),
      totalWithdraws: sumTx('withdraw', 'done'),
      openTrades,
      ggr,
      ggrByAsset: rows,
    });
  });

  router.get('/admin/users', (req, res) => {
    const q = String(req.query.q || '').trim();
    let rows;
    if (q) {
      rows = db
        .prepare(
          'SELECT id, username, balance, is_admin, banned, created_at FROM users WHERE username LIKE ? ORDER BY id DESC LIMIT 200'
        )
        .all(`%${q}%`);
    } else {
      rows = db
        .prepare('SELECT id, username, balance, is_admin, banned, created_at FROM users ORDER BY id DESC LIMIT 500')
        .all();
    }
    res.json({
      users: rows.map((u) => ({ ...u, is_admin: !!u.is_admin, banned: !!u.banned })),
    });
  });

  router.post('/admin/users/:id/adjust', (req, res) => {
    const id = Number(req.params.id);
    const amount = H.r2(req.body.amount);
    if (!Number.isFinite(amount) || amount === 0)
      return res.status(400).json({ error: 'Amount must be a non-zero number' });
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(amount, id);
      db.prepare(
        `INSERT INTO transactions (user_id, kind, amount, status, method, meta)
         VALUES (?, 'adjust', ?, 'done', 'admin', ?)`
      ).run(id, amount, `admin:${req.user.username}`);
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}
      return res.status(500).json({ error: 'Adjustment failed' });
    }
    res.json({
      user: db.prepare('SELECT id, username, balance, is_admin, banned FROM users WHERE id = ?').get(id),
    });
  });

  router.post('/admin/users/:id/ban', (req, res) => {
    const id = Number(req.params.id);
    const banned = Number(req.body.banned);
    if (banned !== 0 && banned !== 1)
      return res.status(400).json({ error: 'banned must be 0 or 1' });
    if (id === req.user.id) return res.status(400).json({ error: 'You cannot ban yourself' });
    const u = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    db.prepare('UPDATE users SET banned = ? WHERE id = ?').run(banned, id);
    res.json({ user: db.prepare('SELECT id, username, banned FROM users WHERE id = ?').get(id) });
  });

  // Per-user detail: profile + last 50 trades + last 50 transactions.
  router.get('/admin/users/:id/detail', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });
    const u = db
      .prepare('SELECT id, username, balance, is_admin, banned, created_at FROM users WHERE id = ?')
      .get(id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    const trades = db
      .prepare('SELECT * FROM trades WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .all(id);
    const transactions = db
      .prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 50')
      .all(id);
    res.json({
      user: { ...u, is_admin: !!u.is_admin, banned: !!u.banned },
      trades,
      transactions,
    });
  });

  router.get('/admin/transactions', (req, res) => {
    const { status, kind } = req.query;
    const where = [];
    const params = [];
    if (status) {
      where.push('t.status = ?');
      params.push(String(status));
    }
    if (kind) {
      where.push('t.kind = ?');
      params.push(String(kind));
    }
    const rows = db
      .prepare(
        `SELECT t.id, t.user_id, u.username, t.kind, t.method, t.amount, t.status, t.tx_hash, t.meta, t.created_at
         FROM transactions t JOIN users u ON u.id = t.user_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY t.id DESC LIMIT 200`
      )
      .all(...params);
    res.json({ transactions: rows });
  });

  // All-users trade history: id, username (JOIN), asset, direction, timeframe, amount,
  // entry/settle prices, payout_mult, status, pnl. Filters: ?status= & ?user_id=
  router.get('/admin/trades', (req, res) => {
    const where = [];
    const params = [];
    if (req.query.status) {
      where.push('t.status = ?');
      params.push(String(req.query.status));
    }
    if (req.query.user_id) {
      const uid = Number(req.query.user_id);
      if (!Number.isFinite(uid)) return res.status(400).json({ error: 'Invalid user_id' });
      where.push('t.user_id = ?');
      params.push(uid);
    }
    const rows = db
      .prepare(
        `SELECT t.id, t.user_id, u.username, t.asset, t.direction, t.timeframe, t.amount,
                t.entry_price, t.settle_price, t.payout_mult, t.status, t.pnl, t.created_at
         FROM trades t JOIN users u ON u.id = t.user_id
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY t.id DESC LIMIT 200`
      )
      .all(...params);
    res.json({ trades: rows });
  });

  // Atomic approve/reject via explicit transaction (node:sqlite has no db.transaction()).
  function settleTx(tx, approve) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (tx.kind === 'deposit') {
        if (approve) {
          db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(tx.amount, tx.user_id);
          db.prepare("UPDATE transactions SET status = 'done' WHERE id = ?").run(tx.id);
        } else {
          db.prepare("UPDATE transactions SET status = 'rejected' WHERE id = ?").run(tx.id);
        }
      } else if (tx.kind === 'withdraw') {
        if (approve) {
          // Funds were already held at request time; admin pays out manually.
          db.prepare("UPDATE transactions SET status = 'done' WHERE id = ?").run(tx.id);
        } else {
          // Refund the held funds.
          db.prepare('UPDATE users SET balance = ROUND(balance + ?, 2) WHERE id = ?').run(tx.amount, tx.user_id);
          db.prepare("UPDATE transactions SET status = 'rejected' WHERE id = ?").run(tx.id);
        }
      } else {
        throw new Error('Only deposit/withdraw transactions can be approved');
      }
      db.exec('COMMIT');
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {}
      throw e;
    }
  }

  const loadTx = (req, res, next) => {
    const tx = db.prepare('SELECT * FROM transactions WHERE id = ?').get(Number(req.params.id));
    if (!tx) return res.status(404).json({ error: 'Transaction not found' });
    if (tx.status !== 'pending') return res.status(400).json({ error: 'Transaction is not pending' });
    req.tx = tx;
    next();
  };

  router.post('/admin/transactions/:id/approve', loadTx, (req, res) => {
    try {
      settleTx(req.tx, true);
      res.json({ tx: db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.tx.id) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/admin/transactions/:id/reject', loadTx, (req, res) => {
    try {
      settleTx(req.tx, false);
      res.json({ tx: db.prepare('SELECT * FROM transactions WHERE id = ?').get(req.tx.id) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/admin/assets', (req, res) => {
    const rows = db
      .prepare('SELECT symbol, label, enabled, payout_30, payout_60, payout_300 FROM assets ORDER BY symbol')
      .all();
    res.json({
      assets: rows.map((r) => ({
        symbol: r.symbol,
        label: r.label,
        enabled: !!r.enabled,
        payout_30: r.payout_30,
        payout_60: r.payout_60,
        payout_300: r.payout_300,
      })),
    });
  });

  router.post('/admin/assets/:symbol', (req, res) => {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const a = db.prepare('SELECT symbol FROM assets WHERE symbol = ?').get(symbol);
    if (!a) return res.status(404).json({ error: 'Asset not found' });

    const updates = {};
    if (req.body.enabled !== undefined) updates.enabled = req.body.enabled ? 1 : 0;
    for (const key of ['payout_30', 'payout_60', 'payout_300']) {
      if (req.body[key] !== undefined) {
        const v = Number(req.body[key]);
        if (!(v >= 1.01 && v <= 5))
          return res.status(400).json({ error: `${key} must be between 1.01 and 5` });
        updates[key] = v;
      }
    }
    if (Object.keys(updates).length === 0)
      return res.status(400).json({ error: 'Nothing to update' });

    const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE assets SET ${sets} WHERE symbol = ?`).run(...Object.values(updates), symbol);
    res.json({
      asset: db.prepare('SELECT symbol, label, enabled, payout_30, payout_60, payout_300 FROM assets WHERE symbol = ?').get(symbol),
    });
  });

  const SETTING_ALLOWLIST = new Set([
    'feed_provider',
    'feed_ws_url',
    'max_win_bet',
    'max_win_daily',
    'usdt_wallet',
    'usdt_qr_text',
    'min_deposit',
    'min_withdraw',
  ]);

  router.get('/admin/settings', (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json({ settings });
  });

  router.post('/admin/settings', (req, res) => {
    const upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    );
    const pairs = {};
    if (req.body.key) {
      pairs[String(req.body.key)] = req.body.value;
    } else if (req.body.settings && typeof req.body.settings === 'object') {
      for (const [k, v] of Object.entries(req.body.settings)) pairs[String(k)] = v;
    } else {
      return res.status(400).json({ error: 'Provide {key, value} or {settings: {...}}' });
    }
    let feedChanged = false;
    for (const [k, v] of Object.entries(pairs)) {
      if (!SETTING_ALLOWLIST.has(k)) return res.status(400).json({ error: `Setting '${k}' is not editable` });
      if (k === 'feed_provider' && !['binance', 'coinbase', 'simulated'].includes(String(v)))
        return res.status(400).json({ error: 'feed_provider must be binance, coinbase or simulated' });
      if ((k === 'max_win_bet' || k === 'max_win_daily') && !(Number(v) > 0))
        return res.status(400).json({ error: `${k} must be a positive number` });
      if ((k === 'min_deposit' || k === 'min_withdraw') && !(Number(v) >= 0))
        return res.status(400).json({ error: `${k} must be a non-negative number` });
      upsert.run(k, String(v ?? ''));
      if (k === 'feed_provider' || k === 'feed_ws_url') feedChanged = true;
    }
    if (feedChanged) {
      try {
        feed.applySettings();
      } catch (e) {
        console.error('[admin] feed applySettings failed:', e.message);
      }
    }
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    res.json({ settings });
  });

  return router;
};
