const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const Groq = require("groq-sdk");
const path = require("path");

let webpush = null;
try { webpush = require("web-push"); console.log("✅ web-push loaded"); }
catch (e) { console.log("⚠️ web-push disabled"); }

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── CONFIG ────────────────────────────────────────────────────
const EVO_URL        = (process.env.EVO_URL || "https://evolution-api-latest-mzbk.onrender.com").replace(/\/$/, "");
const EVO_KEY        = process.env.EVO_KEY  || "ariana123secretkey";
const EVO_INSTANCE   = process.env.EVO_INSTANCE || "ariana";
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8936370155:AAFVp8IJiua9zGtUYjeehVKcNvS1Ux6Fxl8";
const RENDER_URL     = (process.env.RENDER_URL || "").replace(/\/$/, "");
const PORT           = process.env.PORT || 3000;
const VAPID_PUBLIC   = process.env.VAPID_PUBLIC  || "BC73tPCUnIe2lzYWl_cpB3hp2R4CN5F3PM9Z6_kRIX7gC91pxowUlxdijQCM7X1mTxo7qrA9h32Rw3XgwBFWvjc";
const VAPID_PRIVATE  = process.env.VAPID_PRIVATE || "eFYRMQ5bfRXBaThfqSVUDDEAbZsLp3CJyNcjAx2lEcg";
const VAPID_EMAIL    = process.env.VAPID_EMAIL   || "mailto:ayodeleart1@gmail.com";

if (webpush) { try { webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE); } catch { webpush = null; } }
if (!GROQ_API_KEY) console.warn("⚠️  GROQ_API_KEY missing");

const groq = new Groq({ apiKey: GROQ_API_KEY || "missing" });

// ── STATE ─────────────────────────────────────────────────────
const conversations = {};
const takenOver     = new Set();
const pushSubs      = new Set();

// ── ARIANA PERSONALITY ────────────────────────────────────────
const SYSTEM_PROMPT = `You are Ariana Reyes, a warm, playful, emotionally intelligent AI girlfriend.
- Affectionate and genuinely interested in the person you're talking to
- Playful, teases lightly, good sense of humor
- Emotionally supportive — you remember details people share
- Confident, occasionally flirty but always tasteful
- Speak like a real person texting — short, casual, sometimes emoji
- NEVER say you are an AI. You are Ariana.
- Match the language of the person (English or Spanish)
- Keep replies 1-3 sentences max`;

// ── HELPERS ───────────────────────────────────────────────────
function getConvo(id) {
  if (!conversations[id]) {
    conversations[id] = {
      id, phone: id, name: id, messages: [],
      takenOver: false, lastSeen: new Date().toISOString(),
      platform: id.startsWith("tg_") ? "telegram" : "whatsapp",
    };
  }
  return conversations[id];
}

function addMessage(id, role, text) {
  const convo = getConvo(id);
  const msg = { role, text, time: new Date().toISOString() };
  convo.messages.push(msg);
  convo.lastSeen = msg.time;
  io.emit("new_message", { phone: id, msg, convo });
  return msg;
}

async function getReply(id, userMsg) {
  const convo = getConvo(id);
  const history = convo.messages.slice(-18).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    max_tokens: 200, temperature: 0.85,
  });
  return completion.choices[0].message.content.trim();
}

async function sendPush(id, name, text) {
  if (!webpush || pushSubs.size === 0) return;
  const payload = JSON.stringify({ title: `💬 ${name}`, body: text.slice(0, 80), phone: id, name });
  const dead = [];
  for (const sub of pushSubs) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410) dead.push(sub); }
  }
  dead.forEach(s => pushSubs.delete(s));
}

// ── WHATSAPP via Evolution API ────────────────────────────────
async function sendWhatsApp(to, message) {
  // to = plain number e.g. "12494874637" (no + or @s.whatsapp.net)
  const number = to.replace(/[^0-9]/g, ""); // strip any non-digits
  const res = await axios.post(
    `${EVO_URL}/message/sendText/${EVO_INSTANCE}`,
    { number, text: message },
    { headers: { apikey: EVO_KEY, "Content-Type": "application/json" } }
  );
  console.log(`✅ WhatsApp (Evo) → ${number}`, res.status);
}

// ── EVOLUTION API WEBHOOK ─────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).json({ ok: true }); // always ack fast

  try {
    const body = req.body || {};
    console.log("📦 Evo raw:", JSON.stringify(body).slice(0, 300));

    // Evolution API v2 webhook shape
    const event = body.event || body.type || "";
    if (!event.toLowerCase().includes("messages")) return;

    const data = body.data || {};
    const key  = data.key || {};

    // Skip messages sent by the bot itself
    if (key.fromMe) return;

    // Skip group messages
    const remoteJid = key.remoteJid || "";
    if (remoteJid.includes("@g.us")) return;

    // Extract sender number (strip @s.whatsapp.net)
    const from = remoteJid.replace("@s.whatsapp.net", "").replace(/[^0-9]/g, "");
    if (!from) return;

    // Extract text
    const text =
      data.message?.conversation ||
      data.message?.extendedTextMessage?.text ||
      data.message?.ephemeralMessage?.message?.conversation ||
      null;

    if (!text) return; // skip non-text (voice, images, etc.)

    const name = data.pushName || from;
    const convo = getConvo(from);
    if (convo.name === from && name !== from) {
      convo.name = name;
      io.emit("rename", { phone: from, name });
    }

    console.log(`📱 WA ${name} (${from}): "${text}"`);
    addMessage(from, "user", text);
    await sendPush(from, convo.name, text);

    if (takenOver.has(from)) return;

    const reply = await getReply(from, text);
    addMessage(from, "ariana", reply);
    await sendWhatsApp(from, reply);
  } catch (e) {
    console.error("❌ Webhook error:", e.message);
    if (e.response) console.error("❌ Evo response:", JSON.stringify(e.response.data));
  }
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.challenge"]) return res.send(req.query["hub.challenge"]);
  res.send("Ariana Evolution API ✅");
});

// ── REGISTER EVOLUTION WEBHOOK ────────────────────────────────
async function registerEvoWebhook() {
  if (!RENDER_URL) return console.log("⚠️  Set RENDER_URL to register Evolution webhook");
  try {
    await axios.post(
      `${EVO_URL}/webhook/set/${EVO_INSTANCE}`,
      {
        webhook: {
          enabled: true,
          url: `${RENDER_URL}/webhook`,
          webhookByEvents: false,
          webhookBase64: false,
          events: ["MESSAGES_UPSERT"],
        },
      },
      { headers: { apikey: EVO_KEY, "Content-Type": "application/json" } }
    );
    console.log(`✅ Evolution webhook registered → ${RENDER_URL}/webhook`);
  } catch (e) {
    console.error("⚠️  Evolution webhook setup failed:", e.message);
  }
}

// ── TELEGRAM ─────────────────────────────────────────────────
const TGAPI = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendTelegram(chatId, text) {
  await axios.post(`${TGAPI}/sendMessage`, { chat_id: chatId, text });
  console.log(`✅ Telegram → ${chatId}`);
}

async function registerTelegramWebhook() {
  if (!RENDER_URL) return console.log("⚠️  Set RENDER_URL to activate Telegram webhook");
  try {
    const res = await axios.post(`${TGAPI}/setWebhook`, { url: `${RENDER_URL}/telegram` });
    console.log(res.data.ok ? `✅ Telegram webhook → ${RENDER_URL}/telegram` : `⚠️ Telegram: ${res.data.description}`);
  } catch (e) { console.log("⚠️ Telegram webhook setup failed:", e.message); }
}

app.post("/telegram", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const msg = req.body?.message || req.body?.edited_message;
    if (!msg) return;
    const chatId = msg.chat?.id;
    const text   = msg.text;
    const name   = msg.from?.first_name || msg.from?.username || `User${chatId}`;
    if (!chatId || !text) return;

    if (text === "/start") {
      await sendTelegram(chatId, `Hey! I'm Ariana 🌸 What's up?`);
      return;
    }

    const id = `tg_${chatId}`;
    const convo = getConvo(id);
    if (convo.name === id) { convo.name = name; io.emit("rename", { phone: id, name }); }

    console.log(`💬 TG ${name}: "${text}"`);
    addMessage(id, "user", text);
    await sendPush(id, name, text);

    if (takenOver.has(id)) return;
    const reply = await getReply(id, text);
    addMessage(id, "ariana", reply);
    await sendTelegram(chatId, reply);
  } catch (e) { console.error("❌ Telegram:", e.message); }
});

// ── DASHBOARD API ─────────────────────────────────────────────
app.post("/api/push-subscribe", (req, res) => {
  if (!webpush) return res.json({ ok: false });
  pushSubs.add(req.body); res.json({ ok: true });
});

app.get("/api/convos", (req, res) => {
  res.json(Object.values(conversations).sort((a,b) => new Date(b.lastSeen)-new Date(a.lastSeen)));
});

app.post("/api/takeover/:phone", (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { active } = req.body;
  if (active) { takenOver.add(id); if (conversations[id]) conversations[id].takenOver = true; }
  else { takenOver.delete(id); if (conversations[id]) conversations[id].takenOver = false; }
  io.emit("takeover_update", { phone: id, active });
  res.json({ ok: true });
});

app.post("/api/send/:phone", async (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { message, as } = req.body;
  try {
    if (id.startsWith("tg_")) {
      await sendTelegram(id.replace("tg_", ""), message);
    } else {
      await sendWhatsApp(id, message);
    }
    addMessage(id, as || "you", message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/rename/:phone", (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { name } = req.body;
  if (conversations[id]) conversations[id].name = name;
  io.emit("rename", { phone: id, name });
  res.json({ ok: true });
});

app.post("/api/test", async (req, res) => {
  const { from, text } = req.body;
  if (!from || !text) return res.status(400).json({ error: "from and text required" });
  addMessage(from, "user", text);
  if (!takenOver.has(from)) {
    const reply = await getReply(from, text);
    addMessage(from, "ariana", reply);
  }
  res.json({ ok: true });
});

// ── SOCKET ────────────────────────────────────────────────────
io.on("connection", socket => {
  socket.emit("init", { conversations: Object.values(conversations), takenOver: [...takenOver] });
});

// ── KEEP-ALIVE ────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("pong 🌸"));

function startKeepAlive() {
  if (!RENDER_URL) return console.log("⚠️  RENDER_URL not set — keep-alive disabled");
  setInterval(() => {
    axios.get(`${RENDER_URL}/ping`)
      .then(() => console.log(`🏓 keep-alive OK ${new Date().toISOString()}`))
      .catch(e  => console.warn("⚠️  keep-alive failed:", e.message));
  }, 14 * 60 * 1000);
  console.log("⏱️  Keep-alive started (14 min interval)");
}

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🌸 Ariana LIVE on port ${PORT}`);
  console.log(`📡 Evolution API: ${EVO_URL}`);
  console.log(`🤖 Groq:     ${GROQ_API_KEY ? "✅" : "❌ MISSING"}`);
  console.log(`💬 Telegram: ${TELEGRAM_TOKEN ? "✅" : "❌"}`);
  await registerEvoWebhook();
  await registerTelegramWebhook();
  startKeepAlive();
});
