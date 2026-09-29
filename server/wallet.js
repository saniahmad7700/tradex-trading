'use strict';
// Wallet routes: USDT deposit info (address + QR), manual deposit (tx hash),
// withdraw with balance hold, history. Admin approves/rejects in admin.js.
const express = require('express');
const QRCode = require('qrcode');

module.exports = (db, H) => {
  const router = express.Router();
  const needAuth = H.authRequired(db);

  let qrCache = { text: null, qr: null };

  router.get('/info', async (req, res) => {
    const wallet = H.getSetting(db, 'usdt_wallet') || '';
    const qrText = H.getSetting(db, 'usdt_qr_text') || wallet;
    try {
      if (qrCache.text !== qrText) {
        qrCache = { text: qrText, qr: await QRCode.toDataURL(qrText || ' ', { width: 220, margin: 1 }) };
      }
      res.json({
        wallet,
        qr: qrCache.qr,
        min_deposit: Number(H.getSetting(db, 'min_deposit') || 10),
        min_withdraw: Number(H.getSetting(db, 'min_withdraw') || 20),
      });
    } catch (e) {
      res.status(500).json({ error: 'Could not generate QR code' });
    }
  });

  router.post('/deposit', needAuth, (req, res) => {
    const amount = H.r2(req.body.amount);
    const txHash = String(req.body.tx_hash || '').trim();
    const minDep = Number(H.getSetting(db, 'min_deposit') || 10);

    if (!(amount >= minDep)) return res.status(400).json({ error: `Minimum deposit is ${minDep} USDT` });
    if (txHash.length < 5) return res.status(400).json({ error: 'Transaction hash is required' });

    // Prevent the same on-chain hash from being credited twice.
    const dup = db
      .prepare(
        "SELECT id FROM transactions WHERE kind = 'deposit' AND tx_hash = ? AND status IN ('pending','done')"
      )
      .get(txHash);
    if (dup) return res.status(400).json({ error: 'This transaction hash was already submitted' });

    const r = db
      .prepare(
        "INSERT INTO transactions (user_id, kind, amount, status, tx_hash, method) VALUES (?, 'deposit', ?, 'pending', ?, 'usdt')"
      )
      .run(req.user.id, amount, txHash);
    res.json({ tx: { id: r.lastInsertRowid, status: 'pending' } });
  });

  router.post('/withdraw', needAuth, (req, res) => {
    const address = String(req.body.address || '').trim();
    const amount = H.r2(req.body.amount);
    const minWd = Number(H.getSetting(db, 'min_withdraw') || 20);

    if (!(amount >= minWd)) return res.status(400).json({ error: `Minimum withdrawal is ${minWd} USDT` });
    if (address.length < 5) return res.status(400).json({ error: 'Withdrawal address is required' });

    // Atomically hold the funds so concurrent requests can't double-spend.
    const hold = db
      .prepare('UPDATE users SET balance = ROUND(balance - ?, 2) WHERE id = ? AND ROUND(balance, 2) >= ?')
      .run(amount, req.user.id, amount);
    if (hold.changes === 0) return res.status(400).json({ error: 'Insufficient balance' });

    const r = db
      .prepare(
        "INSERT INTO transactions (user_id, kind, amount, status, tx_hash, method) VALUES (?, 'withdraw', ?, 'pending', ?, 'usdt')"
      )
      .run(req.user.id, amount, address);
    res.json({ tx: { id: r.lastInsertRowid, status: 'pending' } });
  });

  router.get('/history', needAuth, (req, res) => {
    const rows = db
      .prepare(
        'SELECT id, kind, method, amount, status, tx_hash, meta, created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100'
      )
      .all(req.user.id);
    res.json({ history: rows });
  });

  return router;
};
