'use strict';
// TradeX database: SQLite schema + seeds (admin, assets, settings).
// Uses Node 24 built-in node:sqlite (DatabaseSync). Never better-sqlite3.
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const db = new DatabaseSync(path.join(__dirname, '..', 'data.sqlite'));
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  balance REAL DEFAULT 0,
  is_admin INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS transactions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'pending',
  tx_hash TEXT,
  method TEXT,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS assets(
  symbol TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  payout_30 REAL DEFAULT 1.90,
  payout_60 REAL DEFAULT 1.90,
  payout_300 REAL DEFAULT 1.90
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS trades(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  asset TEXT NOT NULL,
  direction TEXT NOT NULL,
  amount REAL NOT NULL,
  entry_price REAL NOT NULL,
  entry_time INTEGER NOT NULL,
  expiry_time INTEGER NOT NULL,
  timeframe INTEGER NOT NULL,
  payout_mult REAL NOT NULL,
  status TEXT DEFAULT 'open',
  settle_price REAL,
  pnl REAL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Seed settings (INSERT OR IGNORE so existing values survive reboots).
const jwtRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('jwt_secret');
if (!jwtRow) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(
    'jwt_secret',
    crypto.randomBytes(32).toString('hex')
  );
  console.log('[db] generated jwt_secret on first boot');
}
const SETTINGS = {
  max_win_bet: '1000',
  max_win_daily: '5000',
  feed_provider: 'simulated',
  feed_ws_url: '',
  usdt_wallet: 'TXXXXPLACEHOLDER',
  usdt_qr_text: 'TXXXXPLACEHOLDER',
  min_deposit: '10',
  min_withdraw: '20',
};
const sIns = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(SETTINGS)) sIns.run(k, v);

// Seed assets
const ASSETS = [
  ['BTCUSDT', 'Bitcoin', 1, 1.9, 1.9, 1.9],
  ['ETHUSDT', 'Ethereum', 1, 1.9, 1.9, 1.9],
  ['BNBUSDT', 'BNB', 1, 1.9, 1.9, 1.9],
];
const aIns = db.prepare(
  'INSERT OR IGNORE INTO assets (symbol, label, enabled, payout_30, payout_60, payout_300) VALUES (?,?,?,?,?,?)'
);
for (const a of ASSETS) aIns.run(...a);

// Seed admin account (username 'admin'; password from ADMIN_PASSWORD env when set)
const adminRow = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminRow) {
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  const hash = bcrypt.hashSync(adminPw, 10);
  db.prepare('INSERT INTO users (username, pass_hash, balance, is_admin) VALUES (?,?,0,1)').run(
    'admin',
    hash
  );
  console.log('[db] seeded admin account: admin');
}

module.exports = db;
