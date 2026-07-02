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
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "Mozilla/5.0" } }, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,120))); } });
    }).on("error", reject);
  });
}

function httpsReq(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, data: {}, raw: d.slice(0,500) }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function httpsRaw(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sign(secret, ts, method, path, body = "") {
  return crypto.createHmac("sha256", secret)
    .update(ts + method.toUpperCase() + path + body)
    .digest("base64");
}

function weexH(key, secret, pass, ts, method, path, body = "") {
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
// PRICES — Binance → CoinGecko fallback
// ─────────────────────────────────────────────────────────────────────────────
app.get("/prices", async (_, res) => {
  try {
    const [a,b,c] = await Promise.all([
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"),
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"),
      httpsGet("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT"),
    ]);
    const btc=parseFloat(a.price),eth=parseFloat(b.price),sol=parseFloat(c.price);
    if(btc>0&&eth>0&&sol>0){
      console.log(`[Prices] Binance BTC=$${btc} ETH=$${eth} SOL=$${sol}`);
      return res.json({ BTC:btc, ETH:eth, SOL:sol, source:"Binance" });
    }
  } catch(e){ console.warn("[Prices] Binance failed:", e.message); }
  try {
    const d = await httpsGet("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd");
    const btc=d.bitcoin?.usd, eth=d.ethereum?.usd, sol=d.solana?.usd;
    if(btc>0){
      console.log(`[Prices] CoinGecko BTC=$${btc} ETH=$${eth} SOL=$${sol}`);
      return res.json({ BTC:btc, ETH:eth, SOL:sol, source:"CoinGecko" });
    }
  } catch(e){ console.warn("[Prices] CoinGecko failed:", e.message); }
  res.status(500).json({ error:"All price sources failed" });
});

// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYZE — Claude claude-sonnet-4-6 via Anthropic API
// ─────────────────────────────────────────────────────────────────────────────
app.post("/ai/analyze", async (req, res) => {
  const { prompt, pair } = req.body;
  if(!prompt) return res.status(400).json({ error:"Missing prompt" });
  const KEY = process.env.ANTHROPIC_API_KEY || "";
  if(!KEY) return res.status(500).json({ error:"ANTHROPIC_API_KEY not configured in Railway env vars" });
  const body = JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    messages: [{ role:"user", content:prompt }]
  });
  try {
    const r = await httpsReq({
      hostname:"api.anthropic.com", path:"/v1/messages", method:"POST",
      headers:{ "Content-Type":"application/json","Content-Length":Buffer.byteLength(body),"x-api-key":KEY,"anthropic-version":"2023-06-01" },
    }, body);
    const d = r.data;
    if(d.error) throw new Error(d.error.message);
    const txt = (d.content||[]).map(b=>b.text||"").join("").trim();
    const match = txt.match(/\{[\s\S]*?\}/);
    if(!match) throw new Error("No JSON in response: "+txt.slice(0,200));
    const sig = JSON.parse(match[0]);
    console.log(`[AI] ${pair||"?"} → ${sig.signal} ${sig.confidence}% | ${sig.strategy}`);
    res.json(sig);
  } catch(e){
    console.error("[AI] Error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEEX BALANCE — spot + futures
// ─────────────────────────────────────────────────────────────────────────────
app.post("/weex/balance", async (req, res) => {
  const { key, secret, passphrase } = req.body;
  if(!key||!secret) return res.status(400).json({ error:"Missing credentials" });
  const result = { spot:{}, futures:{}, debug:[] };
  const pass   = passphrase||"";

  // Spot
  try {
    const ts=Date.now().toString(), path="/api/v3/account";
    const r = await httpsRaw({ hostname:"api-spot.weex.com", path, method:"GET", headers:weexH(key,secret,pass,ts,"GET",path) });
    result.debug.push(`[Spot] HTTP${r.status} | ${r.body.slice(0,200)}`);
    if(r.status===200){
      const d=JSON.parse(r.body);
      const list=Array.isArray(d.balances)?d.balances:Array.isArray(d.data)?d.data:[];
      for(const a of list){
        const sym=(a.asset||a.coinName||"").toUpperCase();
        if(["USDT","BTC","ETH","SOL"].includes(sym))
          result.spot[sym]={ available:parseFloat(a.free||a.available||0).toFixed(sym==="USDT"?2:8), locked:parseFloat(a.locked||0).toFixed(sym==="USDT"?2:8) };
      }
      console.log("[Spot] ✅", result.spot);
    }
  } catch(e){ result.debug.push(`[Spot] ERROR: ${e.message}`); }

  // Futures USDT-M
  try {
    const ts=Date.now().toString(), path="/capi/v3/account/balance";
    const r = await httpsRaw({ hostname:"api-contract.weex.com", path, method:"GET", headers:weexH(key,secret,pass,ts,"GET",path) });
    result.debug.push(`[Futures] HTTP${r.status} | ${r.body.slice(0,300)}`);
    if(r.status===200){
      const body=r.body.trim();
      if(body.startsWith("[")){
        const list=JSON.parse(body);
        for(const a of list){
          const sym=(a.asset||"USDT").toUpperCase();
          result.futures[sym]={ available:parseFloat(a.availableBalance||0).toFixed(2), total:parseFloat(a.balance||0).toFixed(2), unrealized:parseFloat(a.unrealizePnl||0).toFixed(2), frozen:parseFloat(a.frozen||0).toFixed(2) };
        }
        console.log("[Futures] ✅", result.futures);
      } else {
        const d=JSON.parse(body);
        result.futuresError=d.msg||"Unexpected format";
        result.debug.push(`[Futures] code=${d.code} msg=${d.msg}`);
      }
    }
  } catch(e){ result.debug.push(`[Futures] ERROR: ${e.message}`); result.futuresError=e.message; }

  res.json(result);
});

// ─────────────────────────────────────────────────────────────────────────────
// WEEX ORDER — place futures LONG or SHORT
// Accepts: pair, side (BUY=LONG / SELL=SHORT), leverage, usdtAmount
// Calculates contracts from usdtAmount + leverage
// ─────────────────────────────────────────────────────────────────────────────
app.post("/weex/order", async (req, res) => {
  const { key, secret, passphrase, pair, side, leverage, usdtAmount, price } = req.body;
  if(!key||!secret||!pair||!side) return res.status(400).json({ error:"Missing params" });

  const symbol   = pair.replace("/","");
  const posSide  = side.toUpperCase()==="BUY"?"LONG":"SHORT";
  const pass     = passphrase||"";
  const lev      = parseInt(leverage)||10;
  const usdt     = parseFloat(usdtAmount||0);
  const px       = parseFloat(price||0);

  // Weex contract sizes
  const CS = { BTCUSDT:0.001, ETHUSDT:0.01, SOLUSDT:0.1 };
  const cs = CS[symbol]||0.01;

  let contracts = 1;
  if(px>0 && usdt>0){
    // notional = contracts * cs * price
    // margin   = notional / leverage
    // usdt     = margin → notional = usdt * leverage → contracts = (usdt * lev) / (cs * px)
    contracts = Math.floor((usdt * lev) / (cs * px));
    if(contracts < 1) contracts = 1;
  }

  const path    = "/capi/v3/order";
  const bodyObj = { symbol, side:side.toUpperCase(), positionSide:posSide, type:"MARKET", quantity:contracts.toString(), newClientOrderId:"sjbot-"+Date.now() };
  const bodyStr = JSON.stringify(bodyObj);
  const ts      = Date.now().toString();

  console.log(`[Order] ${side}(${posSide}) ${contracts} contracts ${symbol} | $${usdt} @ ${lev}x | margin=$${(contracts*cs*px/lev).toFixed(2)}`);

  try {
    const r = await httpsReq({
      hostname:"api-contract.weex.com", path, method:"POST",
      headers:{ ...weexH(key,secret,pass,ts,"POST",path,bodyStr), "Content-Length":Buffer.byteLength(bodyStr) },
    }, bodyStr);
    console.log(`[Order] Response HTTP${r.status}:`, JSON.stringify(r.data));
    const d = r.data;
    if(d.success===false) throw new Error(d.errorMessage||JSON.stringify(d));
    if(d.code&&d.code!=="00000"&&d.code!==0) throw new Error(d.msg||JSON.stringify(d));
    const orderId = d.orderId||(d.data&&d.data.orderId)||"ok_"+Date.now();
    console.log(`[Order] ✅ ${side}(${posSide}) ${contracts} contracts ${symbol} → ${orderId}`);
    res.json({ success:true, orderId, symbol, side, posSide, contracts, leverage:lev, margin:(contracts*cs*(px||0)/lev).toFixed(2) });
  } catch(e){
    console.error("[Order] Error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// WEEX CLOSE ALL — emergency stop
// POST /capi/v3/closePositions (no symbol = close all)
// ─────────────────────────────────────────────────────────────────────────────
app.post("/weex/close", async (req, res) => {
  const { key, secret, passphrase } = req.body;
  if(!key||!secret) return res.status(400).json({ error:"Missing credentials" });
  const pass    = passphrase||"";
  const path    = "/capi/v3/closePositions";
  const bodyStr = "{}";
  const ts      = Date.now().toString();
  console.log("[Close All] Closing all positions...");
  try {
    const r = await httpsReq({
      hostname:"api-contract.weex.com", path, method:"POST",
      headers:{ ...weexH(key,secret,pass,ts,"POST",path,bodyStr), "Content-Length":Buffer.byteLength(bodyStr) },
    }, bodyStr);
    console.log("[Close All] Response:", JSON.stringify(r.data));
    const d=r.data;
    if(d.code&&d.code!=="00000"&&d.code!==0) throw new Error(d.msg||JSON.stringify(d));
    res.json({ success:true, raw:d });
  } catch(e){
    console.error("[Close All] Error:", e.message);
    res.status(500).json({ error:e.message });
  }
});

app.listen(PORT, () => console.log(`Shah Jee Proxy v3.0 running on port ${PORT} | Anthropic: ${process.env.ANTHROPIC_API_KEY?"✅":"❌ MISSING"}`));