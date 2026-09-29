'use strict';
// Auth routes: POST /api/auth/register, POST /api/auth/login, GET /api/auth/me
const express = require('express');
const bcrypt = require('bcryptjs');

module.exports = (db, H) => {
  const router = express.Router();

  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    balance: H.r2(u.balance),
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  });

  router.post('/register', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (!/^[A-Za-z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: 'Username must be 3-20 chars (letters, numbers, _)' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (exists) return res.status(400).json({ error: 'Username already taken' });

    const hash = bcrypt.hashSync(password, 10);
    const r = db
      .prepare('INSERT INTO users (username, pass_hash, balance) VALUES (?,?,0)')
      .run(username, hash);

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    res.json({ token: H.signToken(db, user.id), user: publicUser(user) });
  });

  router.post('/login', (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.pass_hash))
      return res.status(401).json({ error: 'Invalid username or password' });
    if (user.banned) return res.status(403).json({ error: 'Account is banned' });
    res.json({ token: H.signToken(db, user.id), user: publicUser(user) });
  });

  router.get('/me', H.authRequired(db), (req, res) => {
    res.json({ user: publicUser(req.user) });
  });

  return router;
};
