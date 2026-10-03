'use strict';
// TradeX AI chat endpoint.
// POST /api/chat  { message: string } -> { reply: string, source: 'ai'|'smart' }
//
// Two modes:
//  1. If AI_API_KEY env var is set -> forwards to an OpenAI-compatible chat
//     completions endpoint (AI_API_URL, default https://api.openai.com/v1/chat/completions,
//     model AI_MODEL default gpt-4o-mini) with a TradeX system prompt.
//  2. Otherwise -> instant smart rule-based replies (zero cost, zero delay).
// Never throws: any AI failure falls back to smart replies.

const https = require('https');

const SYSTEM_PROMPT = `You are TradeX Assistant, the helpful support bot for TradeX, a crypto trading platform website. TradeX offers: live candlestick charts for BTC, ETH, BNB; 30-second, 1-minute and 5-minute trading timeframes with Rise/Fall predictions; a demo mode with virtual credits for practice; a wallet system with deposits/withdrawals; Easypaisa, JazzCash and USDT (TRC20) payments; and an admin dashboard. Be concise, friendly, and helpful. Never give financial advice; remind users trading involves risk.`;

const RULES = [
  { k: ['demo'], r: 'Yes! TradeX has a demo mode with 1,000 virtual practice credits — toggle between DEMO and REAL at the top of the terminal and practice risk-free before trading live.' },
  { k: ['deposit', 'easypaisa', 'jazzcash', 'usdt', 'payment', 'fund'], r: 'You can deposit via Easypaisa, JazzCash, or USDT (TRC20). Open the Wallet section, choose your method, and follow the steps. Minimum deposit is 10 USDT.' },
  { k: ['withdraw'], r: 'Withdrawals are processed from the Wallet section. Minimum withdrawal is 20 USDT. Processing is usually quick!' },
  { k: ['timeframe', '30s', '30 sec', '1m', '5m', 'time frame'], r: 'TradeX supports 30-second, 1-minute, and 5-minute timeframes. Pick your timeframe, set your stake, and predict Rise or Fall!' },
  { k: ['how', 'trade', 'trading', 'start', 'begin', 'play'], r: 'Easy! 1) Pick an asset (BTC, ETH, BNB). 2) Choose a timeframe (30s/1m/5m). 3) Set your stake. 4) Predict RISE or FALL. If you are right when the timer ends, you win the payout!' },
  { k: ['payout', 'win', 'profit', 'earn', 'return'], r: 'Winning trades pay 1.9x your stake (e.g. stake $10, get back $19). Payouts are configurable per timeframe by the admin.' },
  { k: ['asset', 'coin', 'btc', 'eth', 'bnb', 'crypto'], r: 'TradeX lists BTC/USDT, ETH/USDT, and BNB/USDT with live streaming prices and candlestick charts.' },
  { k: ['admin'], r: 'The admin dashboard lets the site owner manage users, monitor trades, set profit multipliers and limits, and view analytics.' },
  { k: ['risk', 'safe', 'scam', 'legit'], r: 'TradeX is a trading platform — all trading involves risk, so try demo mode first and never trade money you cannot afford to lose.' },
  { k: ['price', 'cost', 'fee'], r: 'Trading on TradeX is commission-free — you only risk your stake per trade. There are no hidden fees.' },
  { k: ['login', 'register', 'account', 'sign up', 'signup'], r: 'Click Register at the top, choose a username and password — it takes under a minute. Then log in and start with demo mode!' },
  { k: ['hello', 'hi', 'hey', 'salam', 'aoa'], r: 'Hello! Welcome to TradeX. Ask me anything about trading, deposits, demo mode, or timeframes!' },
  { k: ['thank', 'shukriya'], r: 'You are welcome! Good luck with your trades!' },
  { k: ['free'], r: 'TradeX demo mode is free — you get 1,000 virtual practice credits to try trading risk-free!' },
  { k: ['minimum', 'min deposit', 'min withdraw'], r: 'Minimum deposit is 10 USDT and minimum withdrawal is 20 USDT.' },
  { k: ['how long', 'withdrawal time', 'payout time', 'when will'], r: 'Withdrawals are usually processed quickly — often within a few hours. Track yours in the Wallet transaction history.' },
  { k: ['pakistan', 'country', 'countries', 'available in'], r: 'TradeX works online worldwide, including Pakistan — with Easypaisa and JazzCash deposits!' },
  { k: ['app', 'apk', 'download', 'android'], r: 'Grab the TradeX Android app (APK) from the download banner on the site — or just use the mobile website, it works great on phones!' },
  { k: ['support', 'human', 'contact', 'agent', 'help me'], r: 'You are chatting with support right now! For account-specific issues, use the contact options in your profile menu.' },
  { k: ['password', 'forgot'], r: 'To reset your password, please contact support through the platform and the team will help you.' },
  { k: ['language', 'urdu', 'hindi'], r: 'The platform is in English for now. More languages may come soon!' },
];

const FALLBACKS = [
  'Great question! On TradeX you can trade BTC, ETH and BNB with 30s/1m/5m timeframes. Try demo mode first — it is free! What else would you like to know?',
  'I can help with trading how-tos, deposits (Easypaisa/JazzCash/USDT), demo mode, timeframes, and payouts. What do you need?',
  'Not sure I caught that — but I know everything about TradeX: assets, timeframes, wallet, demo mode. Ask away!',
];

function smartReply(msg) {
  const m = msg.toLowerCase();
  for (const rule of RULES) {
    if (rule.k.some(k => m.includes(k))) return rule.r;
  }
  return FALLBACKS[Math.floor(Math.random() * FALLBACKS.length)];
}

function callAI(message) {
  return new Promise((resolve) => {
    const key = process.env.AI_API_KEY;
    if (!key) return resolve(null);
    const url = new URL(process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions');
    const body = JSON.stringify({
      model: process.env.AI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message.slice(0, 2000) },
      ],
      max_tokens: 300,
      temperature: 0.7,
    });
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + key,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const txt = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          resolve(txt ? txt.trim() : null);
        } catch { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

module.exports = function chatRouter() {
  const express = require('express');
  const r = express.Router();
  r.post('/chat', async (req, res) => {
    const message = String((req.body && req.body.message) || '').slice(0, 2000);
    if (!message.trim()) return res.json({ reply: 'Please type a message!', source: 'smart' });
    let reply = null, source = 'smart';
    if (process.env.AI_API_KEY) {
      reply = await callAI(message);
      if (reply) source = 'ai';
    }
    if (!reply) reply = smartReply(message);
    res.json({ reply, source });
  });
  // Optional: let the frontend know which mode is active
  r.get('/chat/mode', (req, res) => res.json({ mode: process.env.AI_API_KEY ? 'ai' : 'smart' }));
  return r;
};
