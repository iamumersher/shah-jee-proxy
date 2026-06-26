require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const https   = require("https");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
// HTTPS HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch(e) { reject(new Error("Parse: " + data.slice(0,100))); } });
    }).on("error", reject);
  });
}

function httpsReq(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: {}, raw: data.slice(0, 500) }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsRaw(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// WEEX SIGNATURE  (Base64 HMAC-SHA256)
// Format: timestamp + METHOD + path + body
// ─────────────────────────────────────────────────────────────────────────────
function sign(secret, ts, method, path, body = "") {
  const msg = ts + method.toUpperCase() + path + body;
  return crypto.createHmac("sha256", secret).update(msg).digest("base64");
}

function weexHeaders(key, secret, pass, ts, method, path, body = "") {
  return {
    "Content-Type":      "application/json",
    "ACCESS-KEY":        key,
    "ACCESS-SIGN":       sign(secret, ts, method, path, body),
    "ACCESS-TIMESTAMP":  ts,
    "ACCESS-PASSPHRASE": pass || "",
    "User-Agent":        "Mozilla/5.0",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ ok: true, ts: Date.now() }));

// ─────────────────────────────────────────────────────────────────────────────
// PRICES  (Binance → CoinGecko fallback)
// ─────────────────────────────────────────────────────────────────────────────
app.get("/prices", async (_, res) => {
  try {
    const [a, b, c] = await Promise.all([
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT"),
    ]);
    const btc = parseFloat(a.price), eth = parseFloat(b.price), sol = parseFloat(c.price);
    if (btc > 0 && eth > 0 && sol > 0) {
      console.log(`[Prices] Binance BTC=$${btc} ETH=$${eth} SOL=$${sol}`);
      return res.json({ BTC: btc, ETH: eth, SOL: sol, source: "Binance" });
    }
  } catch(e) { console.warn("[Prices] Binance failed:", e.message); }
  try {
    const d = await httpsGet("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd");
    const btc = d.bitcoin?.usd, eth = d.ethereum?.usd, sol = d.solana?.usd;
    if (btc > 0) {
      console.log(`[Prices] CoinGecko BTC=$${btc} ETH=$${eth} SOL=$${sol}`);
      return res.json({ BTC: btc, ETH: eth, SOL: sol, source: "CoinGecko" });
    }
  } catch(e) { console.warn("[Prices] CoinGecko failed:", e.message); }
  res.status(500).json({ error: "All price sources failed" });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYZE  (Claude via Anthropic API)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/ai/analyze", async (req, res) => {
  const { prompt, pair } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });
  const KEY = process.env.ANTHROPIC_API_KEY || "";
  if (!KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not set in Railway env vars" });
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 500,
    messages: [{ role: "user", content: prompt }]
  });
  try {
    const r = await httpsReq({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01"
      },
    }, body);
    const d = r.data;
    if (d.error) throw new Error(d.error.message);
    const txt = (d.content || []).map(b => b.text || "").join("").trim();
    const match = txt.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("No JSON in AI response");
    const sig = JSON.parse(match[0]);
    console.log(`[AI] ${pair || "?"} → ${sig.signal} ${sig.confidence}% | ${sig.strategy}`);
    res.json(sig);
  } catch(e) {
    console.error("[AI] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEEX BALANCE  (Spot + Futures)
// Spot:    api-spot.weex.com    GET /api/v3/account
// Futures: api-contract.weex.com GET /capi/v3/account/balance
// ─────────────────────────────────────────────────────────────────────────────
app.post("/weex/balance", async (req, res) => {
  const { key, secret, passphrase } = req.body;
  if (!key || !secret) return res.status(400).json({ error: "Missing credentials" });

  const result = { spot: {}, futures: {}, debug: [] };
  const pass   = passphrase || "";

  // ── Spot Balance ────────────────────────────────────────────────────────────
  try {
    const ts   = Date.now().toString();
    const path = "/api/v3/account";
    const r    = await httpsRaw({
      hostname: "api-spot.weex.com", path, method: "GET",
      headers: weexHeaders(key, secret, pass, ts, "GET", path),
    });
    const log = `[Spot] api-spot.weex.com${path} → HTTP${r.status} | ${r.body.slice(0, 200)}`;
    console.log(log);
    result.debug.push(log);

    if (r.status === 200) {
      const d = JSON.parse(r.body);
      const list = Array.isArray(d.balances) ? d.balances
                 : Array.isArray(d.data)     ? d.data
                 : Array.isArray(d.result)   ? d.result : [];
      for (const a of list) {
        const sym = (a.asset || a.coinName || a.currency || "").toUpperCase();
        if (["USDT","BTC","ETH","SOL"].includes(sym)) {
          result.spot[sym] = {
            available: parseFloat(a.free || a.available || a.availableBalance || 0).toFixed(sym === "USDT" ? 2 : 8),
            locked:    parseFloat(a.locked || a.freeze || 0).toFixed(sym === "USDT" ? 2 : 8),
          };
        }
      }
      if (Object.keys(result.spot).length > 0) console.log("[Spot] ✅", result.spot);
      else result.debug.push("[Spot] Parsed OK but no USDT/BTC/ETH/SOL found — spot wallet may be empty");
    }
  } catch(e) {
    result.debug.push(`[Spot] ERROR: ${e.message}`);
    result.spotError = e.message;
  }

  // ── Futures Balance (USDT-M) ─────────────────────────────────────────────────
  // Official docs: https://www.weex.com/api-doc/contract/Account_API/GetAccountBalance
  // GET /capi/v3/account/balance → returns array directly
  // Fields: asset, balance, availableBalance, frozen, unrealizePnl
  try {
    const ts   = Date.now().toString();
    const path = "/capi/v3/account/balance";
    const r    = await httpsRaw({
      hostname: "api-contract.weex.com", path, method: "GET",
      headers: weexHeaders(key, secret, pass, ts, "GET", path),
    });
    const log = `[Futures] api-contract.weex.com${path} → HTTP${r.status} | ${r.body.slice(0, 300)}`;
    console.log(log);
    result.debug.push(log);

    if (r.status === 200) {
      const body = r.body.trim();
      // Response is a direct JSON array
      if (body.startsWith("[")) {
        const list = JSON.parse(body);
        for (const a of list) {
          const sym = (a.asset || "USDT").toUpperCase();
          result.futures[sym] = {
            available:  parseFloat(a.availableBalance || 0).toFixed(2),
            total:      parseFloat(a.balance          || 0).toFixed(2),
            unrealized: parseFloat(a.unrealizePnl     || 0).toFixed(2),
            frozen:     parseFloat(a.frozen           || 0).toFixed(2),
          };
        }
        if (Object.keys(result.futures).length > 0) console.log("[Futures] ✅", result.futures);
        else result.debug.push("[Futures] Empty array — no futures balance or account not activated");
      } else {
        const d = JSON.parse(body);
        result.debug.push(`[Futures] Got object not array: code=${d.code} msg=${d.msg || ""}`);
        result.futuresError = d.msg || "Unexpected response format";
      }
    } else {
      result.futuresError = `HTTP ${r.status}: ${r.body.slice(0, 100)}`;
    }
  } catch(e) {
    result.debug.push(`[Futures] ERROR: ${e.message}`);
    result.futuresError = e.message;
  }

  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// WEEX ORDER  (Futures USDT-M)
// Official docs: https://www.weex.com/api-doc/contract/Transaction_API/PlaceOrder
// POST /capi/v3/order on api-contract.weex.com
// Required: symbol, side, positionSide, type, quantity, newClientOrderId
// Contract sizes: BTCUSDT=0.001 BTC, ETHUSDT=0.01 ETH, SOLUSDT=0.1 SOL
// ─────────────────────────────────────────────────────────────────────────────
app.post("/weex/order", async (req, res) => {
  const { key, secret, passphrase, pair, side, availableUSDT, price } = req.body;
  if (!key || !secret || !pair || !side) return res.status(400).json({ error: "Missing params" });

  const symbol   = pair.replace("/", "");
  const posSide  = side.toUpperCase() === "BUY" ? "LONG" : "SHORT";
  const pass     = passphrase || "";
  const avail    = parseFloat(availableUSDT || 0);
  const px       = parseFloat(price || 0);

  // Contract sizes per Weex spec
  const CS = { BTCUSDT: 0.001, ETHUSDT: 0.01, SOLUSDT: 0.1 };
  const cs = CS[symbol] || 0.01;

  // At 10x leverage: margin_per_contract = (cs * price) / 10
  // Use 10% of available balance per trade, minimum 1 contract
  // BUT verify we can actually afford it — Weex has minimum margin requirements
  let contracts = 0;
  if (px > 0 && avail > 0) {
    const leverage     = 10;
    const marginPerCon = (cs * px) / leverage;
    const useBalance   = avail * 0.10; // max 10% of balance per trade
    contracts = Math.floor(useBalance / marginPerCon);
    // Must be able to afford at least 1 contract
    if (contracts < 1 && avail >= marginPerCon) contracts = 1;
    if (contracts < 1) {
      // Cannot afford even 1 contract of this pair
      const needed = marginPerCon.toFixed(2);
      return res.status(400).json({ 
        error: `Insufficient balance: need $${needed} margin for 1 ${symbol} contract at 10x leverage, have $${avail.toFixed(2)} available.`,
        needsMoreFunds: true,
        marginNeeded: needed,
        symbol
      });
    }
  } else {
    contracts = 1; // fallback
  }

  const clientId = "sjbot-" + Date.now();
  const path     = "/capi/v3/order";
  const bodyObj  = {
    symbol,
    side:             side.toUpperCase(),
    positionSide:     posSide,
    type:             "MARKET",
    quantity:         contracts.toString(),
    newClientOrderId: clientId,
  };
  const bodyStr = JSON.stringify(bodyObj);
  const ts      = Date.now().toString();

  console.log(`[Order] ${side} ${contracts} contracts ${symbol} | avail=$${avail} price=$${px} margin/con=$${px>0?((cs*px)/10).toFixed(2):"?"}`);

  try {
    const r = await httpsReq({
      hostname: "api-contract.weex.com", path, method: "POST",
      headers: {
        ...weexHeaders(key, secret, pass, ts, "POST", path, bodyStr),
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, bodyStr);
    console.log(`[Order] Response HTTP${r.status}:`, JSON.stringify(r.data));
    const d = r.data;
    if (d.success === false) throw new Error(d.errorMessage || d.errorCode || JSON.stringify(d));
    if (d.code && d.code !== "00000" && d.code !== 0) throw new Error(d.msg || JSON.stringify(d));
    const orderId = d.orderId || (d.data && d.data.orderId) || "ok_" + Date.now();
    console.log(`[Order] ✅ ${side} ${contracts} contracts ${symbol} → orderId: ${orderId}`);
    res.json({ success: true, orderId, symbol, side, contracts });
  } catch(e) {
    console.error("[Order] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMERGENCY CLOSE ALL  (close every open position at market)
// Official: POST /capi/v3/positions/close-all on api-contract.weex.com
// ─────────────────────────────────────────────────────────────────────────────
app.post("/weex/close", async (req, res) => {
  const { key, secret, passphrase } = req.body;
  if (!key || !secret) return res.status(400).json({ error: "Missing credentials" });

  const pass    = passphrase || "";
  const path    = "/capi/v3/closePositions"; // Official: https://www.weex.com/api-doc/contract/Transaction_API/ClosePositions
  const bodyStr = "{}";
  const ts      = Date.now().toString();

  console.log("[Close All] Closing all open positions...");
  try {
    const r = await httpsReq({
      hostname: "api-contract.weex.com", path, method: "POST",
      headers: {
        ...weexHeaders(key, secret, pass, ts, "POST", path, bodyStr),
        "Content-Length": Buffer.byteLength(bodyStr),
      },
    }, bodyStr);
    console.log("[Close All] Response:", JSON.stringify(r.data));
    const d = r.data;
    if (d.code && d.code !== "00000" && d.code !== 0) throw new Error(d.msg || JSON.stringify(d));
    res.json({ success: true, raw: d });
  } catch(e) {
    console.error("[Close All] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║       Shah Jee Trading Bot — Proxy v2.0              ║
╠══════════════════════════════════════════════════════╣
║  GET  /health          → status check                ║
║  GET  /prices          → BTC / ETH / SOL live        ║
║  POST /ai/analyze      → Claude AI signal            ║
║  POST /weex/balance    → spot + futures balance      ║
║  POST /weex/order      → place futures order         ║
║  POST /weex/close      → emergency close all         ║
╚══════════════════════════════════════════════════════╝
Anthropic Key: ${process.env.ANTHROPIC_API_KEY ? "✅ Loaded" : "❌ MISSING - set in Railway env vars"}
Port: ${PORT}
`);
});