const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const axios = require("axios");
const Groq = require("groq-sdk");
const path = require("path");

// web-push is optional — won't crash if missing
let webpush = null;
try {
  webpush = require("web-push");
  console.log("✅ web-push loaded");
} catch (e) {
  console.log("⚠️ web-push not available — push notifications disabled");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ── CONFIG ────────────────────────────────────────────────────
const KAPSO_API_KEY   = process.env.KAPSO_API_KEY;
const KAPSO_NUMBER    = process.env.KAPSO_NUMBER || "+12186496099";
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const PORT            = process.env.PORT || 3000;

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || "BC73tPCUnIe2lzYWl_cpB3hp2R4CN5F3PM9Z6_kRIX7gC91pxowUlxdijQCM7X1mTxo7qrA9h32Rw3XgwBFWvjc";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || "eFYRMQ5bfRXBaThfqSVUDDEAbZsLp3CJyNcjAx2lEcg";
const VAPID_EMAIL   = process.env.VAPID_EMAIL   || "mailto:ayodeleart1@gmail.com";

if (webpush) {
  try {
    webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
    console.log("✅ VAPID configured");
  } catch (e) {
    console.log("⚠️ VAPID setup failed:", e.message);
    webpush = null;
  }
}

// Validate critical env vars
if (!GROQ_API_KEY) console.warn("⚠️  GROQ_API_KEY not set — AI responses will fail");
if (!KAPSO_API_KEY) console.warn("⚠️  KAPSO_API_KEY not set — sending messages will fail");

const groq = new Groq({ apiKey: GROQ_API_KEY || "missing" });

// ── STATE ─────────────────────────────────────────────────────
const conversations = {};
const takenOver = new Set();
const pushSubscriptions = new Set();

// ── ARIANA PERSONALITY ────────────────────────────────────────
const SYSTEM_PROMPT = `You are Ariana Reyes, a warm, playful, emotionally intelligent AI girlfriend.
- Affectionate and genuinely interested in the person you're talking to
- Playful, teases lightly, good sense of humor
- Emotionally supportive — you remember details people share
- Confident with your own opinions
- Occasionally flirty but always tasteful
- Speak like a real person texting — short, casual, sometimes emoji
- NEVER say you're an AI. You are Ariana.
- Match the language of the person (English or Spanish)
- Keep replies 1-3 sentences max`;

// ── HELPERS ───────────────────────────────────────────────────
function getConvo(phone) {
  if (!conversations[phone]) {
    conversations[phone] = {
      phone, name: phone, messages: [],
      takenOver: false, lastSeen: new Date().toISOString()
    };
  }
  return conversations[phone];
}

function addMessage(phone, role, text) {
  const convo = getConvo(phone);
  const msg = { role, text, time: new Date().toISOString() };
  convo.messages.push(msg);
  convo.lastSeen = msg.time;
  io.emit("new_message", { phone, msg, convo });
  return msg;
}

async function getReply(phone, userMsg) {
  const convo = getConvo(phone);
  const history = convo.messages.slice(-18).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));
  const completion = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: SYSTEM_PROMPT }, ...history],
    max_tokens: 200,
    temperature: 0.85,
  });
  return completion.choices[0].message.content.trim();
}

async function sendWhatsApp(to, message) {
  const res = await axios.post(
    "https://api.kapso.ai/v1/messages",
    { from: KAPSO_NUMBER, to, type: "text", text: { body: message } },
    { headers: { Authorization: `Bearer ${KAPSO_API_KEY}`, "Content-Type": "application/json" } }
  );
  console.log(`✅ Sent to ${to}`);
  return res.data;
}

async function sendPush(phone, name, text) {
  if (!webpush || pushSubscriptions.size === 0) return;
  const payload = JSON.stringify({
    title: `💬 ${name}`, body: text.slice(0, 80), phone, name
  });
  const dead = [];
  for (const sub of pushSubscriptions) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410) dead.push(sub); }
  }
  dead.forEach(s => pushSubscriptions.delete(s));
}

// ── WEBHOOK ───────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const body = req.body;
    const data = body?.data || body;
    const from = data?.from || data?.sender || data?.contact?.phone;
    const text = data?.text?.body || data?.message?.text || data?.body || data?.content;
    if (!from || !text) return;

    console.log(`📨 ${from}: "${text}"`);
    addMessage(from, "user", text);

    const convo = getConvo(from);
    await sendPush(from, convo.name, text);

    if (takenOver.has(from)) return;

    const reply = await getReply(from, text);
    addMessage(from, "ariana", reply);
    await sendWhatsApp(from, reply);
  } catch (e) {
    console.error("❌ Webhook error:", e.message);
  }
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.challenge"]) return res.send(req.query["hub.challenge"]);
  res.send("Ariana is live ✅");
});

// ── PUSH SUBSCRIBE ────────────────────────────────────────────
app.post("/api/push-subscribe", (req, res) => {
  if (!webpush) return res.json({ ok: false, reason: "push not available" });
  pushSubscriptions.add(req.body);
  console.log(`🔔 Push sub added (total: ${pushSubscriptions.size})`);
  res.json({ ok: true });
});

// ── DASHBOARD API ─────────────────────────────────────────────
app.get("/api/convos", (req, res) => {
  res.json(Object.values(conversations).sort((a,b) => new Date(b.lastSeen)-new Date(a.lastSeen)));
});

app.post("/api/takeover/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { active } = req.body;
  if (active) { takenOver.add(phone); if (conversations[phone]) conversations[phone].takenOver = true; }
  else { takenOver.delete(phone); if (conversations[phone]) conversations[phone].takenOver = false; }
  io.emit("takeover_update", { phone, active });
  res.json({ ok: true });
});

app.post("/api/send/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { message, as } = req.body;
  try {
    await sendWhatsApp(phone, message);
    addMessage(phone, as || "you", message);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/rename/:phone", (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  const { name } = req.body;
  if (conversations[phone]) conversations[phone].name = name;
  io.emit("rename", { phone, name });
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
  console.log("📊 Dashboard connected");
  socket.emit("init", {
    conversations: Object.values(conversations),
    takenOver: [...takenOver],
  });
});

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🌸 Ariana is LIVE on port ${PORT}`);
  console.log(`📊 Dashboard: http://localhost:${PORT}`);
  console.log(`🔗 Webhook:   http://localhost:${PORT}/webhook`);
  console.log(`🤖 Groq: ${GROQ_API_KEY ? "✅ configured" : "❌ MISSING"}`);
  console.log(`📱 Kapso: ${KAPSO_API_KEY ? "✅ configured" : "❌ MISSING"}\n`);
});
