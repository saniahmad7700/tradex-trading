'use strict';
// Shared helpers: money rounding, JWT auth middleware, settings access.
// The JWT secret lives in the settings table (random on first boot);
// env JWT_SECRET overrides it when set (e.g. before delivery).
const jwt = require('jsonwebtoken');

const r2 = (n) => Math.round(Number(n) * 100) / 100;

function getJwtSecret(db) {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  try {
    const r = db.prepare('SELECT value FROM settings WHERE key = ?').get('jwt_secret');
    if (r && r.value) return r.value;
  } catch (e) {
    /* settings not seeded yet */
  }
  return 'dev-secret-change-me';
}

function getDbUser(db, id) {
  const u = db
    .prepare('SELECT id, username, balance, is_admin, banned, created_at FROM users WHERE id = ?')
    .get(id);
  if (u) {
    u.balance = r2(u.balance);
    u.is_admin = !!u.is_admin;
    u.banned = !!u.banned;
  }
  return u;
}

function signToken(db, id) {
  return jwt.sign({ id }, getJwtSecret(db), { expiresIn: '7d' });
}

function authOptional(db) {
  return (req, res, next) => {
    req.user = null;
    req.banned = false;
    const h = req.headers.authorization || '';
    const m = h.match(/^Bearer (.+)$/);
    if (m) {
      try {
        const p = jwt.verify(m[1], getJwtSecret(db));
        const u = getDbUser(db, p.id);
        if (u && !u.banned) req.user = u;
        else if (u) req.banned = true; // valid token, but the account is banned
      } catch (e) {
        /* invalid token -> anonymous */
      }
    }
    next();
  };
}

function authRequired(db) {
  const opt = authOptional(db);
  return (req, res, next) => {
    opt(req, res, () => {
      if (req.banned) return res.status(403).json({ error: 'Account is banned' });
      if (!req.user) return res.status(401).json({ error: 'Login required' });
      next();
    });
  };
}

function adminRequired(db) {
  const reqd = authRequired(db);
  return (req, res, next) => {
    reqd(req, res, () => {
      if (!req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
      next();
    });
  };
}

function getSetting(db, key) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return r ? r.value : null;
}

module.exports = { r2, authOptional, authRequired, adminRequired, getSetting, signToken };
