# TradeX — client binary-style trading betting platform (web + APK-ready)

Price up/down betting on live crypto prices with server-side settlement and
house-edge profit caps. This is betting against the house — NOT real broker trading.
Built to FEEL like a real broker (Pocket Option / Binance style UI); only the
invisible part differs (settlement happens on our server with house edge).

## Run
```bash
cd ~/workspace/client-trading-platform
npm install --no-audit --no-fund   # once (pure JS deps; node:sqlite is built into Node 24)
node server/index.js               # API + frontend on http://localhost:3000
```
For a clean database: `rm -f data.sqlite*` before starting (auto-seeds admin + assets + settings).
Port note: if :3000 is taken (e.g. by the gaming platform dev server), use `PORT=3101 node server/index.js` — the frontend uses relative /api paths and is port-agnostic.

## Admin login
- Username: `admin` / Password: `admin123` — **CHANGE BEFORE DELIVERY** (also set `JWT_SECRET` env var; the DB-seeded `jwt_secret` is random per fresh DB).

## What works (backend)
- Auth: register / login / me (JWT Bearer, 7-day expiry). Banned users get 403 on all authed routes.
- Wallet: public USDT deposit info (address + QR data URL), manual deposit via tx hash (duplicate hashes rejected), withdraw with atomic balance hold; admin approve/reject (deposit approve credits, withdraw approve marks done, withdraw reject refunds the hold).
- Feed (`server/feed.js`): providers `binance` / `coinbase` / `simulated` (default — Binance is geo-blocked from the sandbox). Simulated = 700ms random walk (BTC 97500 / ETH 3420 / BNB 695 seeds). Live latest prices, 5s candle ring buffer (last 400 per asset), stale detection (>10s without a tick), WS reconnect with 1s→30s backoff, `feed_ws_url` setting overrides the provider URL. Hot-switch via admin settings (verified binance→stale→simulated→live).
- Trading: `POST /api/trade/place` {asset, direction, timeframe∈{30,60,300}, amount} — entry price = latest server price, payout from assets table, 503 `feed_stale` when feed is stale, atomic balance debit. `GET /api/trade/open`, `GET /api/trade/history?limit=50`.
- Settler (500ms loop, one sqlite transaction per trade): win pays `amount + profit` where profit is capped by `max_win_bet` per bet (default 1000) and `max_win_daily` per user per UTC day (default 5000); loss loses the stake; exact tie = push (stake refunded); stale feed at expiry = void (stake refunded, `kind=refund` tx).
- Admin (all under `/api/admin`, adminRequired scoped so unmatched `/api/*` fall through instead of 401ing): overview (users, deposits, withdraws, open trades, GGR overall + per asset), user search / balance adjust / ban, transaction list + approve/reject, asset enable + payout editor (1.01–5), settings editor (allowlisted keys incl. feed_provider, feed_ws_url, win caps, usdt_wallet, min amounts — changing feed keys hot-switches the feed).
- `GET /api/prices` snapshot; `GET /api/feed/stream` SSE (snapshot on connect, ticks throttled to 500ms, stale-change events, 20s heartbeat).
- `public/`: stub `index.html` ("frontend pending" — the frontend agent overwrites it) + empty `public/app.apk` placeholder.

## Progress
- [x] Project scaffold + backend (auth, wallet, feed, trading, settler, admin)
- [x] Profit caps core (per-bet + per-day caps enforced at settlement, admin GGR APIs)
- [x] E2E-verified on localhost: register→login→deposit→approve→place 30s trade→settle (won/lost/push/void paths)→caps→GGR→withdraw hold/reject-refund/approve→history→dup tx-hash guard→ban→403→invalid inputs→SSE→admin 404-fallthrough
- [x] Frontend SPA — TradeX broker-style UI: canvas candlestick chart (live ticks via SSE, crosshair, position markers with countdown badges + DEMO badges in demo mode), trade panel (30s/1m/5m, UP/DOWN, payout preview), open positions with live P/L, history, wallet (USDT QR deposit + withdraw), profile, login/register, full admin panel (GGR overview, users, transactions, assets+payouts, settings incl. feed provider), REAL/DEMO segmented toggle + demo banner (demo = client-side paper trading, 1000 fake credits, no login, never touches /api/trade/*), mobile-first + APK download banner
- [x] Independent coordinator e2e (2026-09-29, 30/30 pass): register→deposit→approve→balance 100→bets on 30s+60s+300s→settlement math exact→feed hot-switch to binance→stale flagged→bet 503-blocked→switch back→fresh→withdraw hold→approve→GGR overview→asset disable blocks bets→SSE events→frontend served
- [x] Cap logic code-verified: profit=min(amount×(payout−1), max_win_bet, max_win_daily−dailyWon), tie=push refund, stale-expiry=void refund, single sqlite txn per trade with ROLLBACK
- [x] Clean-DB final boot verified (admin login, feed live); DB left in freshly-seeded state
- [ ] E2E against real browser session (chart rendering, trade flow) — needs live-browser delegation
- [ ] Delivery prep: change admin password + JWT secret, replace placeholder USDT wallet, choose production feed provider (Binance geo-blocked from sandbox AND from USA — recommend coinbase or configurable URL; verify from production host)

## Tech notes
- Node 24 `node:sqlite` (DatabaseSync, `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` manual transactions — node:sqlite has no `db.transaction()`). Never better-sqlite3 (native build can't compile in this sandbox).
- Port note (2026-09-29): the client-gaming-platform dev server occupies :3000 on this machine, so all backend verification above ran with `PORT=3100`. The code defaults to 3000 (`process.env.PORT || 3000`); it will bind :3000 cleanly when the port is free (confirmed the only startup failure was EADDRINUSE).
- JWT secret is seeded randomly on first boot into the settings table; `JWT_SECRET` env var overrides it when set.
- Test DB contained e2e data during verification — delete `data.sqlite*` for a clean start.
- Pending before delivery: (1) change admin password + JWT secret; (2) replace `TXXXXPLACEHOLDER` USDT wallet; (3) decide the real feed provider (Binance/Coinbase) and verify connectivity from the production host.

## Changelog
- 2026-09-29: **Demo mode removed per client requirement** (no demo on TradeX — trading requires registration + login). Removed: REAL/DEMO segmented toggle, demo banner, client-side paper-trading engine (demoPlace/settleDemo/initDemoEngine + localStorage demo balance/trades/history), demo branches in balance pill, positions, history, wallet and profile views, demo-tag CSS. Backend unchanged — all `/api/trade/*` endpoints already required auth (`authRequired`), verified 401 without token. `DEMO_PAYOUT` renamed to `DEFAULT_PAYOUT` (UI fallback before server payout config loads). Verified: `grep -ri demo` returns 0 matches in public/ + server/; boot OK; served HTML/JS/CSS contain no demo references.
- 2026-09-29: **Demo mode RESTORED per client correction** (demo stays in TradeX only; the gaming platform remains demo-free). Rebuilt: REAL/DEMO segmented toggle in topbar + clearly-labeled demo banner, client-side paper-trading engine (demoPlace/settleDemo/initDemoEngine/resetDemo, localStorage-backed 1000-credit demo balance/open trades/history), demo branches in balance pill, positions (DEMO tag), history (DEMO tag), wallet (demo balance card + reset, no real deposit UI) and profile (demo stats) views, demo chart-marker badges, demo CSS. `DEFAULT_PAYOUT` renamed back to `DEMO_PAYOUT` (doubles as UI payout fallback). Backend untouched — demo never calls `/api/trade/*` (verified 401 without token). Verified: `node --check` on app.js/chart.js, server boot + toggle/banner served, 33-assertion DOM-stub harness pass (toggle, place, win/loss/push settlement math exact, reset, persistence, zero real-API calls in demo, real mode still redirects to login).
