/**
 * proxy.js — Shah Jee Trading Bot
 * Fixed: Weex spot + futures balance with correct API format
 */

require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const https   = require("https");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 4000;
app.use(cors({ origin: "*" }));
app.use(express.json());

// ── HTTPS helper ───────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Parse error: " + data.slice(0,100))); }
      });
    }).on("error", reject);
  });
}

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { reject(new Error("Parse error: " + data.slice(0,200))); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Weex Signature ─────────────────────────────────────────────────────────────
// Weex uses: HMAC-SHA256( timestamp + "GET" + path + queryString )
// or for POST: HMAC-SHA256( timestamp + "POST" + path + body )
function weexSign(secret, timestamp, method, path, payload = "") {
  const prehash = timestamp + method.toUpperCase() + path + payload;
  return crypto.createHmac("sha256", secret).update(prehash).digest("hex");
}

// ── GET /health ────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// ── GET /prices ────────────────────────────────────────────────────────────────
app.get("/prices", async (_, res) => {
  // Binance (most reliable)
  try {
    const [a, b, c] = await Promise.all([
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT"),
    ]);
    const btc = parseFloat(a.price), eth = parseFloat(b.price), sol = parseFloat(c.price);
    if (btc > 0 && eth > 0 && sol > 0) {
      console.log(`[Prices] Binance ✅ BTC=$${btc} ETH=$${eth} SOL=$${sol}`);
      return res.json({ BTC: btc, ETH: eth, SOL: sol, source: "Binance" });
    }
  } catch(e) { console.warn("[Prices] Binance failed:", e.message); }

  // CoinGecko fallback
  try {
    const d = await httpsGet("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd");
    const btc = d?.bitcoin?.usd, eth = d?.ethereum?.usd, sol = d?.solana?.usd;
    if (btc > 0 && eth > 0 && sol > 0) {
      console.log(`[Prices] CoinGecko ✅ BTC=$${btc}`);
      return res.json({ BTC: btc, ETH: eth, SOL: sol, source: "CoinGecko" });
    }
  } catch(e) { console.warn("[Prices] CoinGecko failed:", e.message); }

  res.status(500).json({ error: "All price sources failed" });
});

// ── POST /ai/analyze ───────────────────────────────────────────────────────────
app.post("/ai/analyze", async (req, res) => {
  const { prompt, pair } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  const KEY = process.env.ANTHROPIC_API_KEY || "";
  if (!KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not in .env" });

  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
  });

  try {
    const result = await httpsRequest({
      hostname: "api.anthropic.com",
      path:     "/v1/messages",
      method:   "POST",
      headers: {
        "Content-Type":      "application/json",
        "Content-Length":    Buffer.byteLength(body),
        "x-api-key":         KEY,
        "anthropic-version": "2023-06-01",
      },
    }, body);

    const d = result.data;
    if (d.error) throw new Error(d.error.message);
    const txt   = (d.content || []).map(b => b.text || "").join("").trim();
    const match = txt.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("No JSON in response");
    const sig = JSON.parse(match[0]);
    console.log(`[AI] ${pair} ✅ ${sig.signal} ${sig.confidence}%`);
    res.json(sig);
  } catch(e) {
    console.error("[AI] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /weex/balance — try all domains + endpoints ─────────────────────────
app.post("/weex/balance", async (req, res) => {
  const { key, secret } = req.body;
  if (!key || !secret) return res.status(400).json({ error: "Missing credentials" });

  const result = { spot: {}, futures: {}, debug: [] };

  // All possible spot endpoint + domain combinations
  const spotCombos = [
    { domain: "api.weex.com",      path: "/api/v1/account/balance" },
    { domain: "api.weex.com",      path: "/api/v1/account/assets" },
    { domain: "api.weex.com",      path: "/api/spot/v1/account/balance" },
    { domain: "openapi.weex.com",  path: "/api/v1/account/balance" },
    { domain: "openapi.weex.com",  path: "/spot/v1/account/balance" },
    { domain: "api.weexapi.com",   path: "/api/v1/account/balance" },
  ];

  let spotDone = false;
  for (const { domain, path } of spotCombos) {
    if (spotDone) break;
    try {
      const ts  = Date.now().toString();
      const sig = weexSign(secret, ts, "GET", path);
      const r   = await httpsRequest({
        hostname: domain,
        path,
        method:   "GET",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY":    key,
          "X-TIMESTAMP":  ts,
          "X-SIGNATURE":  sig,
          "User-Agent":   "Mozilla/5.0",
        },
      });

      const log = `[Spot] ${domain}${path} → HTTP${r.status} code=${r.data?.code} msg=${r.data?.msg||"ok"}`;
      console.log(log, JSON.stringify(r.data).slice(0, 400));
      result.debug.push(log);

      const d = r.data;
      const success = d.code === "00000" || d.code === 0 || d.code === "0" || d.success === true || r.status === 200 && !d.code;

      if (success) {
        // Parse every possible balance format Weex might return
        let list = [];
        if (Array.isArray(d.data))              list = d.data;
        else if (Array.isArray(d.result))       list = d.result;
        else if (Array.isArray(d.balances))     list = d.balances;
        else if (Array.isArray(d.list))         list = d.list;
        else if (Array.isArray(d.assets))       list = d.assets;
        else if (d.data && typeof d.data === "object") {
          // Sometimes data is {USDT: {available: ...}, BTC: {...}}
          list = Object.entries(d.data).map(([k, v]) => ({ coinName: k, ...v }));
        }

        for (const a of list) {
          const sym = (a.coinName || a.currency || a.asset || a.coin || a.symbol || "").toUpperCase();
          if (["USDT","BTC","ETH","SOL","BNB","USDC"].includes(sym)) {
            result.spot[sym] = {
              available: parseFloat(a.available || a.availableBalance || a.free || a.balance || a.amount || 0).toFixed(sym==="USDT"?2:8),
              locked:    parseFloat(a.locked    || a.freeze || a.used || a.frozenBalance || a.hold || 0).toFixed(sym==="USDT"?2:8),
            };
          }
        }
        console.log("[Spot] ✅ Parsed:", result.spot);
        spotDone = true;
      }
    } catch(e) {
      const log = `[Spot] ${domain} ERROR: ${e.message}`;
      console.warn(log);
      result.debug.push(log);
    }
  }

  // Futures endpoints
  const futuresCombos = [
    { domain: "api.weex.com",     path: "/api/v1/contract/account/balance" },
    { domain: "api.weex.com",     path: "/api/mix/v1/account/accounts?productType=umcbl" },
    { domain: "api.weex.com",     path: "/api/v1/future/account" },
    { domain: "openapi.weex.com", path: "/api/v1/contract/account/balance" },
    { domain: "openapi.weex.com", path: "/mix/v1/account/accounts?productType=umcbl" },
  ];

  let futuresDone = false;
  for (const { domain, path } of futuresCombos) {
    if (futuresDone) break;
    try {
      const ts  = Date.now().toString();
      const sig = weexSign(secret, ts, "GET", path);
      const r   = await httpsRequest({
        hostname: domain,
        path,
        method:   "GET",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY":    key,
          "X-TIMESTAMP":  ts,
          "X-SIGNATURE":  sig,
          "User-Agent":   "Mozilla/5.0",
        },
      });

      const log = `[Futures] ${domain}${path} → HTTP${r.status} code=${r.data?.code} msg=${r.data?.msg||"ok"}`;
      console.log(log, JSON.stringify(r.data).slice(0, 400));
      result.debug.push(log);

      const d = r.data;
      const success = d.code === "00000" || d.code === 0 || d.success === true || r.status === 200 && !d.code;

      if (success) {
        let list = [];
        if (Array.isArray(d.data))          list = d.data;
        else if (Array.isArray(d.result))   list = d.result;
        else if (d.data && typeof d.data === "object") list = [d.data];

        for (const a of list) {
          const sym = (a.coinName || a.currency || a.marginCoin || a.asset || "USDT").toUpperCase();
          result.futures[sym] = {
            available:  parseFloat(a.available || a.availableBalance || a.crossMaxAvailable || 0).toFixed(2),
            unrealized: parseFloat(a.unrealizedPnl || a.unrealizedProfit || a.usdtEquity || 0).toFixed(2),
            margin:     parseFloat(a.margin || a.positionMargin || 0).toFixed(2),
          };
        }
        console.log("[Futures] ✅ Parsed:", result.futures);
        futuresDone = true;
      }
    } catch(e) {
      const log = `[Futures] ERROR: ${e.message}`;
      console.warn(log);
      result.debug.push(log);
    }
  }

  if (!spotDone)    result.spotError    = "No working endpoint found — check debug array";
  if (!futuresDone) result.futuresError = "No futures endpoint found";

  res.json(result);
});

// ── POST /weex/order ───────────────────────────────────────────────────────────
app.post("/weex/order", async (req, res) => {
  const { key, secret, pair, side, qty } = req.body;
  if (!key || !secret || !pair || !side || !qty) {
    return res.status(400).json({ error: "Missing params" });
  }

  const symbol  = pair.replace("/", "");
  const ts      = Date.now().toString();
  const path    = "/api/v1/order";
  const bodyStr = JSON.stringify({
    symbol,
    side:     side.toUpperCase(),
    type:     "MARKET",
    quantity: qty.toString(),
  });
  const sig = weexSign(secret, ts, "POST", path, bodyStr);

  try {
    const r = await httpsRequest({
      hostname: "api.weex.com",
      path,
      method:   "POST",
      headers: {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(bodyStr),
        "X-API-KEY":      key,
        "X-TIMESTAMP":    ts,
        "X-SIGNATURE":    sig,
      },
    }, bodyStr);

    const d = r.data;
    if (d.code && d.code !== "00000" && d.code !== 0) throw new Error(d.msg || JSON.stringify(d));
    const orderId = d.data?.orderId || d.orderId || "ok_" + Date.now();
    console.log(`[Weex Order] ✅ ${side} ${qty} ${symbol} → ${orderId}`);
    res.json({ success: true, orderId, symbol, side, qty });
  } catch(e) {
    console.error("[Weex Order]", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /weex/cancel ──────────────────────────────────────────────────────────
app.post("/weex/cancel", async (req, res) => {
  const { key, secret, orderId } = req.body;
  if (!key || !secret || !orderId) return res.status(400).json({ error: "Missing params" });

  const ts   = Date.now().toString();
  const path = `/api/v1/order/${orderId}`;
  const sig  = weexSign(secret, ts, "DELETE", path);

  try {
    const r = await httpsRequest({
      hostname: "api.weex.com",
      path,
      method:   "DELETE",
      headers: {
        "Content-Type": "application/json",
        "X-API-KEY":    key,
        "X-TIMESTAMP":  ts,
        "X-SIGNATURE":  sig,
      },
    });
    res.json({ success: true, raw: r.data });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║      Shah Jee Trading Bot — Proxy Running         ║
║      http://localhost:${PORT}                        ║
╠═══════════════════════════════════════════════════╣
║  GET  /health             status check            ║
║  GET  /prices             BTC / ETH / SOL         ║
║  POST /ai/analyze         Claude AI signal        ║
║  POST /weex/balance       spot + futures          ║
║  POST /weex/order         place order             ║
║  POST /weex/cancel        cancel order            ║
╚═══════════════════════════════════════════════════╝

Anthropic API Key: ${process.env.ANTHROPIC_API_KEY ? "✅ Loaded" : "❌ Missing — add to .env"}
  `);
});
app.get("/weex/dns-test", async (_, res) => {
  const dns = require("dns").promises;
  const domains = [
    "api.weex.com","openapi.weex.com","www.weex.com",
    "api.weexgo.com","trade.weex.com","global.weex.com",
    "api2.weex.com","api-v2.weex.com","api.weex.io"
  ];
  const results = {};
  for (const d of domains) {
    try { results[d] = await dns.lookup(d); }
    catch(e) { results[d] = "FAILED: " + e.message; }
  }
  res.json(results);
});
