require("dotenv").config();
const express = require("express");
const cors    = require("cors");
const https   = require("https");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 4000;

app.use(cors({ origin: "*" }));
app.use(express.json());

// ── HTTPS helpers ─────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error("Parse error: " + data.slice(0,100))); }
      });
    }).on("error", reject);
  });
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, raw: data.slice(0, 500) }); }
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
      res.on("end", () => resolve({ status: res.statusCode, body: data.slice(0, 1000) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Weex V3 Signature ─────────────────────────────────────────────────────────
// ACCESS-SIGN = Base64( HMAC-SHA256( timestamp + method + path + body, secret ) )
function weexV3Sign(secret, timestamp, method, path, body) {
  const msg = timestamp + method.toUpperCase() + path + (body || "");
  return crypto.createHmac("sha256", secret).update(msg).digest("base64");
}

// Weex V1 signature (old format — hex)
function weexV1Sign(secret, timestamp, method, path, body) {
  const msg = timestamp + method.toUpperCase() + path + (body || "");
  return crypto.createHmac("sha256", secret).update(msg).digest("hex");
}

// ── GET /health ───────────────────────────────────────────────────────────────
app.get("/health", (_, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// ── GET /prices ───────────────────────────────────────────────────────────────
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
      console.log(`[Prices] CoinGecko BTC=$${btc}`);
      return res.json({ BTC: btc, ETH: eth, SOL: sol, source: "CoinGecko" });
    }
  } catch(e) { console.warn("[Prices] CoinGecko failed:", e.message); }

  res.status(500).json({ error: "All price sources failed" });
});

// ── POST /ai/analyze ──────────────────────────────────────────────────────────
app.post("/ai/analyze", async (req, res) => {
  const { prompt, pair } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });
  const KEY = process.env.ANTHROPIC_API_KEY || "";
  if (!KEY) return res.status(500).json({ error: "ANTHROPIC_API_KEY not in .env" });
  const body = JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 400, messages: [{ role: "user", content: prompt }] });
  try {
    const result = await httpsRequest({
      hostname: "api.anthropic.com", path: "/v1/messages", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    }, body);
    const d = result.data;
    if (d.error) throw new Error(d.error.message);
    const txt = (d.content || []).map(b => b.text || "").join("").trim();
    const match = txt.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error("No JSON in response");
    const sig = JSON.parse(match[0]);
    console.log(`[AI] ${pair || "?"} ${sig.signal} ${sig.confidence}%`);
    res.json(sig);
  } catch(e) {
    console.error("[AI] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /weex/balance — V3 API with correct signature ────────────────────────
app.post("/weex/balance", async (req, res) => {
  const { key, secret, passphrase } = req.body;
  if (!key || !secret) return res.status(400).json({ error: "Missing credentials" });

  const result = { spot: {}, futures: {}, debug: [] };
  const pass = passphrase || "";

  // All endpoint combinations to try with both V3 and V1 signature
  const combos = [
    // THIS WORKS - confirmed HTTP200
    { domain: "api-spot.weex.com", path: "/api/v3/account", version: "v3" },
  ];

  let spotDone = false;
  for (const { domain, path, version } of combos) {
    if (spotDone) break;
    try {
      const ts  = Date.now().toString();
      const sig = version === "v3"
        ? weexV3Sign(secret, ts, "GET", path, "")
        : weexV1Sign(secret, ts, "GET", path, "");

      const headers = version === "v3" ? {
        "Content-Type":       "application/json",
        "ACCESS-KEY":         key,
        "ACCESS-SIGN":        sig,
        "ACCESS-TIMESTAMP":   ts,
        "ACCESS-PASSPHRASE":  pass,
        "User-Agent":         "Mozilla/5.0",
      } : {
        "Content-Type": "application/json",
        "X-API-KEY":    key,
        "X-TIMESTAMP":  ts,
        "X-SIGNATURE":  sig,
        "User-Agent":   "Mozilla/5.0",
      };

      const r = await httpsRaw({ hostname: domain, path, method: "GET", headers });
      const log = `[${version}] ${domain}${path} → HTTP${r.status} | ${r.body.slice(0,150)}`;
      console.log(log);
      result.debug.push(log);

      if (r.status === 200 && r.body.includes("{")) {
        try {
          const d = JSON.parse(r.body);
          // /api/v3/account returns balances array directly
          let list = [];
          if (Array.isArray(d.balances))    list = d.balances;
          else if (Array.isArray(d.data))   list = d.data;
          else if (Array.isArray(d.result)) list = d.result;
          else if (Array.isArray(d.list))   list = d.list;
          else if (d.data && typeof d.data === "object") {
            list = Object.entries(d.data).map(([k, v]) => ({ coinName: k, ...v }));
          }
          for (const a of list) {
            const sym = (a.asset || a.coinName || a.currency || a.coin || "").toUpperCase();
            if (["USDT","BTC","ETH","SOL","BNB"].includes(sym)) {
              result.spot[sym] = {
                available: parseFloat(a.free || a.available || a.availableBalance || 0).toFixed(sym === "USDT" ? 2 : 8),
                locked:    parseFloat(a.locked || a.freeze || a.used || 0).toFixed(sym === "USDT" ? 2 : 8),
              };
            }
          }
          if (Object.keys(result.spot).length > 0) {
            console.log("[Spot] ✅ Parsed:", result.spot);
            spotDone = true;
          } else {
            console.log("[Spot] Response parsed but no matching assets. Full response:", r.body.slice(0, 500));
          }
        } catch(pe) { console.warn("Parse error:", pe.message); }
      }
    } catch(e) {
      const log = `[${version}] ${domain} ERROR: ${e.message}`;
      console.warn(log);
      result.debug.push(log);
    }
  }

  // ── Futures balance — official Weex Contract V3 API ──────────────────────
  // Source: https://www.weex.com/api-doc/contract/Account_API/GetAccountBalance
  // Domain:   api-contract.weex.com
  // Endpoint: GET /capi/v3/account/balance
  // Signature: timestamp + "GET" + "/capi/v3/account/balance" → HMAC-SHA256 → Base64
  // Response fields: asset, balance, availableBalance, frozen, unrealizePnl
  const fKey    = req.body.futuresKey    || key;
  const fSecret = req.body.futuresSecret || secret;
  const fPass   = req.body.futuresPassphrase || pass;

  try {
    const ts      = Date.now().toString();
    const fPath   = "/capi/v3/account/balance";
    // Signature: timestamp + METHOD + requestPath (no queryString, no body for GET)
    const fMsg    = ts + "GET" + fPath;
    const fSig    = crypto.createHmac("sha256", fSecret).update(fMsg).digest("base64");

    const r = await httpsRaw({
      hostname: "api-contract.weex.com",
      path:     fPath,
      method:   "GET",
      headers: {
        "Content-Type":      "application/json",
        "ACCESS-KEY":        fKey,
        "ACCESS-SIGN":       fSig,
        "ACCESS-TIMESTAMP":  ts,
        "ACCESS-PASSPHRASE": fPass,
        "User-Agent":        "Mozilla/5.0",
      },
    });

    const log = `[Futures] api-contract.weex.com${fPath} → HTTP${r.status} | ${r.body.slice(0, 300)}`;
    console.log(log);
    result.debug.push(log);

    if (r.status === 200 && r.body.includes("[")) {
      // Response is a direct array: [{asset, balance, availableBalance, frozen, unrealizePnl}]
      const list = JSON.parse(r.body);
      if (Array.isArray(list) && list.length > 0) {
        for (const a of list) {
          const sym = (a.asset || "USDT").toUpperCase();
          result.futures[sym] = {
            available:  parseFloat(a.availableBalance || 0).toFixed(2),
            unrealized: parseFloat(a.unrealizePnl     || 0).toFixed(2),
            margin:     parseFloat(a.frozen            || 0).toFixed(2),
          };
        }
        console.log("[Futures] ✅", result.futures);
      } else {
        result.debug.push("[Futures] Empty array returned — no futures balance yet");
      }
    } else if (r.status === 200 && r.body.includes("{")) {
      const d = JSON.parse(r.body);
      result.debug.push(`[Futures] Unexpected response: code=${d.code} msg=${d.msg || d.message || ""}`);
    }
  } catch(e) {
    result.debug.push(`[Futures] ERROR: ${e.message}`);
  }

    if (!spotDone)    result.spotError    = "No working endpoint — check debug";
  if (!Object.keys(result.futures).length) result.futuresError = "No futures balance — check Logs tab";

  res.json(result);
});

// ── POST /weex/order ──────────────────────────────────────────────────────────
app.post("/weex/order", async (req, res) => {
  const { key, secret, passphrase, pair, side, qty } = req.body;
  if (!key || !secret || !pair || !side || !qty) return res.status(400).json({ error: "Missing params" });

  const symbol  = pair.replace("/", "");
  const ts      = Date.now().toString();
  const path    = "/api/v3/order";
  const bodyStr = JSON.stringify({ symbol, side: side.toUpperCase(), type: "MARKET", quantity: qty.toString() });
  const sig     = weexV3Sign(secret, ts, "POST", path, bodyStr);

  try {
    const r = await httpsRequest({
      hostname: "api-spot.weex.com", path, method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "Content-Length":    Buffer.byteLength(bodyStr),
        "ACCESS-KEY":        key,
        "ACCESS-SIGN":       sig,
        "ACCESS-TIMESTAMP":  ts,
        "ACCESS-PASSPHRASE": passphrase || "",
        "User-Agent":        "Mozilla/5.0",
      },
    }, bodyStr);
    const d = r.data;
    if (d && d.code && d.code !== "00000" && d.code !== 0) throw new Error(d.msg || JSON.stringify(d));
    const orderId = (d && d.data && d.data.orderId) || "ok_" + Date.now();
    console.log(`[Order] ✅ ${side} ${qty} ${symbol} → ${orderId}`);
    res.json({ success: true, orderId, symbol, side, qty });
  } catch(e) {
    console.error("[Order] Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /weex/cancel ─────────────────────────────────────────────────────────
app.post("/weex/cancel", async (req, res) => {
  const { key, secret, passphrase, orderId } = req.body;
  if (!key || !secret || !orderId) return res.status(400).json({ error: "Missing params" });
  const ts   = Date.now().toString();
  const path = `/api/v3/order/${orderId}`;
  const sig  = weexV3Sign(secret, ts, "DELETE", path, "");
  try {
    const r = await httpsRequest({
      hostname: "api-spot.weex.com", path, method: "DELETE",
      headers: { "Content-Type": "application/json", "ACCESS-KEY": key, "ACCESS-SIGN": sig, "ACCESS-TIMESTAMP": ts, "ACCESS-PASSPHRASE": passphrase || "", "User-Agent": "Mozilla/5.0" },
    });
    res.json({ success: true, raw: r.data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /weex/dns-test ────────────────────────────────────────────────────────
app.get("/weex/dns-test", async (_, res) => {
  const dns = require("dns").promises;
  const domains = ["api-spot.weex.com","api-futures.weex.com","api.weex.com","www.weex.com","openapi.weex.com"];
  const results = {};
  for (const d of domains) {
    try { results[d] = await dns.lookup(d); }
    catch(e) { results[d] = "FAILED: " + e.message; }
  }
  res.json(results);
});

// ── Start ─────────────────────────────────────────────────────────────────────
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
║  GET  /weex/dns-test      DNS check               ║
╚═══════════════════════════════════════════════════╝
Anthropic API Key: ${process.env.ANTHROPIC_API_KEY ? "✅ Loaded" : "❌ Missing"}
  `);
});