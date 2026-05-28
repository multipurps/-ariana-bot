/**
 * baileys.js — Ariana WhatsApp via Baileys + Residential Proxy
 * Run alongside index.js OR standalone
 * Proxy: 38.154.203.95:5863
 */

const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { createClient } = require("@supabase/supabase-js");
const { useSupabaseAuthState } = require("./supabase-auth");
const pino = require("pino");
const qrcode = require("qrcode");
const http = require("http");
const axios = require("axios");
const ws    = require("ws");

// ── PROXY ─────────────────────────────────────────────────────
const PROXY_URL   = process.env.WA_PROXY || "http://kwolujui:jco3lxjq9tqo@38.154.203.95:5863";
const proxyAgent  = new HttpsProxyAgent(PROXY_URL);

// ── CONFIG ────────────────────────────────────────────────────
const PHONE_NUMBER  = process.env.PHONE_NUMBER  || "";   // Ariana's WhatsApp number e.g. +12494874637
const MAIN_APP_URL  = process.env.RENDER_URL    || "http://localhost:3000"; // index.js URL
const BAILEYS_PORT  = process.env.BAILEYS_PORT  || 3001;

// ── SUPABASE ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false }, realtime: { transport: ws } }
);

// ── STATE ─────────────────────────────────────────────────────
let currentQR    = null;
let pairingCode  = null;
let isConnected  = false;
let sockGlobal   = null;

// ── WEB UI — QR + Pairing ─────────────────────────────────────
http.createServer(async (req, res) => {

  // QR page
  if (req.url === "/qr") {
    if (currentQR) {
      const img = await qrcode.toDataURL(currentQR);
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <style>body{background:#111;display:flex;flex-direction:column;align-items:center;
        justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:white}
        img{width:280px;height:280px;background:white;padding:16px;border-radius:12px}
        h2{color:#25D366}p{color:#aaa;text-align:center;padding:0 20px;font-size:14px}</style>
        </head><body>
        <h2>Scan QR — Ariana</h2><img src="${img}"/>
        <p>WhatsApp → Linked Devices → Link a Device → Scan</p>
        <p style="color:#555;font-size:12px">Refresh if expired</p>
        </body></html>`);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body style="background:#111;color:white;display:flex;align-items:center;
        justify-content:center;min-height:100vh;font-family:sans-serif">
        <p>QR not ready yet — refresh in a moment</p></body></html>`);
    }
    return;
  }

  // Pairing code page — get code by phone number
  if (req.url.startsWith("/pair")) {
    const phone = (req.url.split("phone=")[1] || PHONE_NUMBER).replace(/\D/g, "");
    if (sockGlobal && phone) {
      try {
        const code = await sockGlobal.requestPairingCode(phone);
        pairingCode = code;
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
          <style>body{background:#111;display:flex;flex-direction:column;align-items:center;
          justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:white}
          .code{font-size:52px;font-weight:bold;color:#25D366;letter-spacing:10px;
          background:#1a1a1a;padding:24px 36px;border-radius:16px;margin:20px 0}
          p{color:#aaa;text-align:center;padding:0 20px;font-size:14px}h2{color:#25D366}</style>
          </head><body>
          <h2>Pairing Code</h2>
          <div class="code">${code}</div>
          <p>Open Ariana's WhatsApp → Linked Devices → Link a Device → Link with phone number</p>
          <p>Enter this code. Expires in ~60 seconds.</p>
          </body></html>`);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/html" });
        res.end(`<html><body style="background:#111;color:white;padding:30px;font-family:sans-serif">
          <p style="color:#ff6b6b">Error: ${e.message}</p>
          <p>Make sure PHONE_NUMBER env var is set with country code e.g. +12494874637</p>
          </body></html>`);
      }
    } else {
      res.writeHead(400, { "Content-Type": "text/html" });
      res.end(`<html><body style="background:#111;color:white;padding:30px;font-family:sans-serif">
        <p>Bot not ready yet — try again in a moment</p></body></html>`);
    }
    return;
  }

  // Ping
  if (req.url === "/ping") { res.writeHead(200); res.end("ok"); return; }

  // Home
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{background:#111;color:white;font-family:sans-serif;display:flex;flex-direction:column;
    align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
    h2{color:#25D366;text-align:center}.status{font-size:20px;margin:10px 0;text-align:center}
    .card{background:#1a1a1a;border-radius:12px;padding:20px;margin:12px 0;width:100%;max-width:360px;box-sizing:border-box}
    h3{color:#25D366;margin-top:0}input{width:100%;padding:12px;border-radius:8px;border:1px solid #333;
    background:#222;color:white;font-size:16px;box-sizing:border-box;margin:8px 0}
    button{width:100%;padding:12px;border-radius:8px;border:none;background:#25D366;color:white;
    font-size:16px;cursor:pointer;margin-top:8px}a{color:#25D366;display:block;text-align:center;margin-top:8px}</style>
    </head><body>
    <h2>🌸 Ariana — Baileys</h2>
    <div class="status">${isConnected ? "🟢 Connected" : "🔴 Not Connected"}</div>
    <div style="font-size:12px;color:#555;text-align:center">Proxy: ${PROXY_URL.split("@")[1] || "set"}</div>
    ${!isConnected ? `
    <div class="card">
      <h3>Pairing Code (Recommended)</h3>
      <p style="color:#aaa;font-size:13px">No scanning needed. Enter Ariana's number with country code.</p>
      <input type="tel" id="phone" placeholder="e.g. +12494874637" value="${PHONE_NUMBER}"/>
      <button onclick="go()">Get Code</button>
    </div>
    <div class="card">
      <h3>QR Code</h3>
      <a href="/qr">View QR Code →</a>
    </div>
    ` : `<div class="card"><p style="color:#aaa;text-align:center">Ariana is live on WhatsApp 🎉</p></div>`}
    <script>function go(){const p=document.getElementById("phone").value.replace(/\s/g,"");
    if(!p){alert("Enter a phone number");return;}window.location.href="/pair?phone="+encodeURIComponent(p);}</script>
    </body></html>`);

}).listen(BAILEYS_PORT, () => console.log(`🌐 Baileys UI on port ${BAILEYS_PORT}`));

// ── FORWARD MESSAGE TO MAIN APP ───────────────────────────────
// When Baileys receives a WhatsApp message, we send it to index.js
// which handles the AI brain, dashboard, etc.
async function forwardToMainApp(from, text) {
  try {
    const res = await axios.post(`${MAIN_APP_URL}/webhook`, {
      message: { from, text: { body: text } },
      _source: "baileys"  // flag so main app knows to reply via Baileys
    }, { timeout: 30000 });
    return res.data;
  } catch (e) {
    console.error("❌ Forward to main app failed:", e.message);
    return null;
  }
}

// ── DIRECT REPLY via Baileys ──────────────────────────────────
// Called by main app when it wants to send a WhatsApp reply
async function sendViaWhatsApp(to, text) {
  if (!sockGlobal || !isConnected) {
    throw new Error("Baileys not connected");
  }
  await sockGlobal.sendMessage(to, { text });
  console.log(`✅ Baileys → ${to}`);
}

// Expose send function via HTTP so index.js can call it
http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/send") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", async () => {
      try {
        const { to, message } = JSON.parse(body);
        await sendViaWhatsApp(to, message);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(200);
    res.end(JSON.stringify({ connected: isConnected }));
  }
}).listen(3002, () => console.log("📡 Baileys send API on port 3002"));

// ── BAILEYS CORE ──────────────────────────────────────────────
async function startBaileys() {
  const { state, saveCreds } = await useSupabaseAuthState(supabase);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["Chrome (Linux)", "", ""],
    agent: proxyAgent,
    fetchAgent: proxyAgent,
    generateHighQualityLinkPreview: true,
  });

  sockGlobal = sock;
  sock.ev.on("creds.update", saveCreds);

  // Auto-request pairing code on startup
  if (!sock.authState.creds.registered && PHONE_NUMBER) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(PHONE_NUMBER.replace(/\D/g, ""));
        console.log("\n══════════════════════════════");
        console.log("  PAIRING CODE: " + code);
        console.log("  WhatsApp → Linked Devices → Link with phone number");
        console.log("  Or open: your-render-url:3001/pair");
        console.log("══════════════════════════════\n");
      } catch (e) {
        console.log("Auto-pair failed:", e.message);
        console.log("Open /pair page manually to get code");
      }
    }, 3000);
  }

  // Connection events
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log("📱 QR ready — open /qr page to scan");
    }

    if (connection === "open") {
      isConnected = true;
      currentQR = null;
      console.log("✅ Ariana WhatsApp CONNECTED via Baileys");
      console.log("   Proxy:", PROXY_URL.split("@")[1]);
    }

    if (connection === "close") {
      isConnected = false;
      sockGlobal = null;
      const code = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode
        : null;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (loggedOut) {
        console.log("⚠️  Logged out — delete Supabase auth state and restart");
      } else {
        console.log(`🔄 Disconnected (code ${code}) — reconnecting in 5s...`);
        setTimeout(startBaileys, 5000);
      }
    }
  });

  // Incoming messages
  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (msg.key.remoteJid === "status@broadcast") continue;
      if (msg.key.remoteJid.endsWith("@g.us")) continue; // skip groups

      const from = msg.key.remoteJid;
      const text = msg.message.conversation
                || msg.message.extendedTextMessage?.text
                || "";

      if (!text.trim()) continue;

      console.log(`📱 WA [Baileys] ${from}: "${text}"`);

      // Show typing indicator
      try { await sock.sendPresenceUpdate("composing", from); } catch {}

      // Forward to main app brain
      await forwardToMainApp(from, text);
    }
  });
}

// ── START ─────────────────────────────────────────────────────
startBaileys().catch(err => {
  console.error("startBaileys failed:", err);
  setTimeout(startBaileys, 5000);
});

process.on("unhandledRejection", r => console.error("Unhandled:", r));
process.on("uncaughtException",  e => console.error("Uncaught:", e));
