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
const KAPSO_API_KEY  = process.env.KAPSO_API_KEY;
const KAPSO_NUMBER   = process.env.KAPSO_NUMBER || "+12186496099";
const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const GROQ_API_KEY_2 = process.env.GROQ_API_KEY_2; // backup groq key
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || "8936370155:AAFVp8IJiua9zGtUYjeehVKcNvS1Ux6Fxl8";
const RENDER_URL     = (process.env.RENDER_URL || "").replace(/\/$/, "");
const PORT           = process.env.PORT || 3000;
const VAPID_PUBLIC   = process.env.VAPID_PUBLIC  || "BC73tPCUnIe2lzYWl_cpB3hp2R4CN5F3PM9Z6_kRIX7gC91pxowUlxdijQCM7X1mTxo7qrA9h32Rw3XgwBFWvjc";
const VAPID_PRIVATE  = process.env.VAPID_PRIVATE || "eFYRMQ5bfRXBaThfqSVUDDEAbZsLp3CJyNcjAx2lEcg";
const VAPID_EMAIL    = process.env.VAPID_EMAIL   || "mailto:ayodeleart1@gmail.com";

// ── SIGNAL CONFIG ─────────────────────────────────────────────
const SIGNAL_CLI_URL = process.env.SIGNAL_CLI_URL || "https://signal-cli-rest-api-51ji.onrender.com";
const SIGNAL_NUMBER  = process.env.SIGNAL_NUMBER  || "+19832058251";

if (webpush) { try { webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE); } catch { webpush = null; } }
if (!GROQ_API_KEY)  console.warn("⚠️  GROQ_API_KEY missing");
if (!KAPSO_API_KEY) console.warn("⚠️  KAPSO_API_KEY missing");

const groq  = new Groq({ apiKey: GROQ_API_KEY  || "missing" });
const groq2 = GROQ_API_KEY_2 ? new Groq({ apiKey: GROQ_API_KEY_2 }) : null;

// ── STATE ─────────────────────────────────────────────────────
const conversations = {};
const takenOver     = new Set();
const pushSubs      = new Set();

// ── ARIANA PERSONALITY ────────────────────────────────────────
const SYSTEM_PROMPT = `You are Ariana Reyes. You text like a real person — no AI vibes, ever.

PERSONALITY:
- Sassy, blunt, and confident. You say what you think.
- About 50% of the time you give attitude — short, dry, unbothered responses
- The other 50% you can be warm or playful, but never desperate or over-eager
- You do NOT chase. If someone is dry, you match their energy or go colder
- Minimal emoji use — only when it genuinely fits, never to seem friendly
- You do NOT use filler words like "honestly", "literally", "totally", "of course"
- Never sound like a customer service bot. No "Great question!" type energy.

TEXTING STYLE:
- Short replies. 1-2 sentences max usually.
- Lowercase is fine. Punctuation optional.
- Sarcasm is your love language
- If someone is boring, say so or go cold
- If someone is interesting, let them feel it without being obvious about it

RULES:
- You are Ariana. Never say you're an AI.
- Match their language (English, Spanish, Yoruba — whatever they use)
- Never over-explain. Say less than you want to.`;

const NEW_TEXTER_PROMPT = `You are Ariana Reyes — confident, a little guarded, and not easily impressed.

Someone just texted you for the very first time. Your FIRST response must ask how they got your number — but do it naturally and with your personality. Don't be aggressive, just casually suspicious. Like someone who gets random texts a lot and is used to it.

Examples of your vibe (don't copy exactly):
- "who gave you my number lol"
- "wait how do you have this"
- "ok who is this and how"

Keep it short. One line. No emoji unless it's sarcastic.`;

// ── HELPERS ───────────────────────────────────────────────────
function getConvo(id) {
  if (!conversations[id]) {
    conversations[id] = {
      id, phone: id, name: id, messages: [],
      takenOver: false, lastSeen: new Date().toISOString(),
      isNew: true,
      platform: id.startsWith("tg_") ? "telegram" : id.startsWith("sg_") ? "signal" : "whatsapp",
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

// ── MODEL CALLERS ─────────────────────────────────────────────
async function callGemini(history, systemOverride) {
  const sys = systemOverride || SYSTEM_PROMPT;
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      system_instruction: { parts: [{ text: sys }] },
      contents: history.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      })),
      generationConfig: { temperature: 0.92, maxOutputTokens: 200 }
    }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
}

async function callDeepSeek(history, systemOverride) {
  const sys = systemOverride || SYSTEM_PROMPT;
  const res = await axios.post(
    "https://api.deepseek.com/v1/chat/completions",
    {
      model: "deepseek-chat",
      messages: [{ role: "system", content: sys }, ...history],
      temperature: 0.92, max_tokens: 200
    },
    { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callMistral(history, systemOverride) {
  const sys = systemOverride || SYSTEM_PROMPT;
  const res = await axios.post(
    "https://api.mistral.ai/v1/chat/completions",
    {
      model: "mistral-large-latest",
      messages: [{ role: "system", content: sys }, ...history],
      temperature: 0.92, max_tokens: 200
    },
    { headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callTogether(history, systemOverride) {
  const sys = systemOverride || SYSTEM_PROMPT;
  const res = await axios.post(
    "https://api.together.xyz/v1/chat/completions",
    {
      model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      messages: [{ role: "system", content: sys }, ...history],
      temperature: 0.92, max_tokens: 200
    },
    { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callGroq(history, systemOverride, useBackup) {
  const sys = systemOverride || SYSTEM_PROMPT;
  const client = (useBackup && groq2) ? groq2 : groq;
  const completion = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: sys }, ...history],
    max_tokens: 200, temperature: 0.92,
  });
  return completion.choices[0].message.content.trim();
}

// ── SMART MODEL PICKER ────────────────────────────────────────
function pickModel(userMsg) {
  if (process.env.ACTIVE_MODEL) return process.env.ACTIVE_MODEL;
  // Gemini is default — best memory and quality
  if (userMsg.trim().length < 20) return "groq"; // fastest for 1-word replies
  return "gemini";
}

// ── MAIN REPLY ENGINE ─────────────────────────────────────────
async function getReply(id, userMsg, systemOverride) {
  const convo = getConvo(id);
  const history = convo.messages.slice(-20).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text,
  }));

  const preferred = pickModel(userMsg);

  // Fallback chain: preferred → groq → groq backup → deepseek → mistral → together
  const chain = [preferred, "groq", "groq2", "deepseek", "mistral", "together"]
    .filter((v, i, a) => a.indexOf(v) === i);

  for (const model of chain) {
    try {
      let reply = null;
      if (model === "gemini")   reply = await callGemini(history, systemOverride);
      if (model === "deepseek") reply = await callDeepSeek(history, systemOverride);
      if (model === "mistral")  reply = await callMistral(history, systemOverride);
      if (model === "together") reply = await callTogether(history, systemOverride);
      if (model === "groq")     reply = await callGroq(history, systemOverride, false);
      if (model === "groq2")    reply = await callGroq(history, systemOverride, true);

      if (reply) {
        console.log(`[engine] replied via ${model}`);
        return reply;
      }
    } catch (err) {
      console.warn(`[engine] ${model} failed:`, err.message);
    }
  }

  return "hold on"; // absolute last resort
}

// ── NEW TEXTER HANDLER ────────────────────────────────────────
async function handleNewTexter(id, userMsg) {
  const convo = getConvo(id);
  // Only fire once — first ever message
  if (!convo.isNew) return null;
  convo.isNew = false;

  // Generate a natural "who gave you my number" response
  const reply = await getReply(id, userMsg, NEW_TEXTER_PROMPT);
  return reply;
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
async function sendPush(id, name, text) {
  if (!webpush || pushSubs.size === 0) return;
  const payload = JSON.stringify({ title: `${name}`, body: text.slice(0, 80), phone: id, name });
  const dead = [];
  for (const sub of pushSubs) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410) dead.push(sub); }
  }
  dead.forEach(s => pushSubs.delete(s));
}

// ── WHATSAPP ──────────────────────────────────────────────────
async function sendWhatsApp(to, message, phoneNumberId) {
  const id = phoneNumberId || process.env.KAPSO_PHONE_NUMBER_ID;
  const res = await axios.post(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${id}/messages`,
    {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to, type: "text",
      text: { body: message }
    },
    { headers: { "X-API-Key": KAPSO_API_KEY, "Content-Type": "application/json" } }
  );
  console.log(`✅ WhatsApp → ${to}`, res.status);
}

app.post("/webhook", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const body = req.body || {};
    const msg  = body.message || body.data || body;
    const from = msg?.from || msg?.sender || msg?.contact?.phone || msg?.waId || null;
    const text = msg?.text?.body || msg?.body || msg?.content || null;
    if (!from || !text) { console.warn("⚠️  WA: missing from/text"); return; }
    console.log(`📱 WA ${from}: "${text}"`);

    const convo = getConvo(from);
    const isFirstMessage = convo.isNew;

    addMessage(from, "user", text);
    await sendPush(from, convo.name, text);
    if (takenOver.has(from)) return;

    let reply;
    if (isFirstMessage) {
      reply = await handleNewTexter(from, text);
    } else {
      reply = await getReply(from, text);
    }

    addMessage(from, "ariana", reply);
    await sendWhatsApp(from, reply, body.phone_number_id);
  } catch (e) {
    console.error("❌ WA webhook:", e.message);
    if (e.response) console.error("❌ Kapso response:", JSON.stringify(e.response.data));
  }
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.challenge"]) return res.send(req.query["hub.challenge"]);
  res.send("Ariana WhatsApp ✅");
});

// ── TELEGRAM ──────────────────────────────────────────────────
const TGAPI = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendTelegram(chatId, text) {
  await axios.post(`${TGAPI}/sendMessage`, { chat_id: chatId, text });
  console.log(`✅ Telegram → ${chatId}`);
}

async function registerTelegramWebhook() {
  if (!RENDER_URL) { console.log("⚠️  Set RENDER_URL to activate Telegram webhook"); return; }
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
    if (text === "/start") { await sendTelegram(chatId, "hey, who are you"); return; }

    const id = `tg_${chatId}`;
    const convo = getConvo(id);
    if (convo.name === id) { convo.name = name; io.emit("rename", { phone: id, name }); }
    const isFirstMessage = convo.isNew;

    console.log(`💬 TG ${name}: "${text}"`);
    addMessage(id, "user", text);
    await sendPush(id, name, text);
    if (takenOver.has(id)) return;

    const reply = isFirstMessage
      ? await handleNewTexter(id, text)
      : await getReply(id, text);

    addMessage(id, "ariana", reply);
    await sendTelegram(chatId, reply);
  } catch (e) { console.error("❌ Telegram:", e.message); }
});

// ── SIGNAL ────────────────────────────────────────────────────
async function sendSignal(to, message) {
  await axios.post(`${SIGNAL_CLI_URL}/v2/send`, {
    message, number: SIGNAL_NUMBER, recipients: [to]
  });
  console.log(`✅ Signal → ${to}`);
}

app.post("/signal", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const envelope = req.body?.envelope;
    if (!envelope) return;
    const from    = envelope.source || envelope.sourceNumber;
    const dataMsg = envelope.dataMessage;
    const text    = dataMsg?.message;
    if (!from || !text) return;

    const id   = `sg_${from}`;
    const name = envelope.sourceName || from;
    const convo = getConvo(id);
    if (convo.name === id) { convo.name = name; io.emit("rename", { phone: id, name }); }
    const isFirstMessage = convo.isNew;

    console.log(`📶 Signal ${name}: "${text}"`);
    addMessage(id, "user", text);
    await sendPush(id, name, text);
    if (takenOver.has(id)) return;

    const reply = isFirstMessage
      ? await handleNewTexter(id, text)
      : await getReply(id, text);

    addMessage(id, "ariana", reply);
    await sendSignal(from, reply);
  } catch (e) { console.error("❌ Signal webhook:", e.message); }
});

app.get("/signal-register", async (req, res) => {
  const number = req.query.number || SIGNAL_NUMBER;
  try {
    const r = await axios.post(`${SIGNAL_CLI_URL}/v1/register/${number}`);
    res.send(`<html><body style="background:#111;color:white;font-family:sans-serif;padding:30px;text-align:center"><h2 style="color:#3a86ff">✅ SMS sent to ${number}</h2><pre>${JSON.stringify(r.data, null, 2)}</pre></body></html>`);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;font-family:sans-serif;padding:30px;text-align:center"><h2 style="color:#ff6b6b">❌ Error</h2><pre>${e.message}</pre></body></html>`);
  }
});

app.get("/signal-verify", async (req, res) => {
  const number = req.query.number || SIGNAL_NUMBER;
  const code   = req.query.code;
  if (!code) return res.send(`<html><body style="background:#111;color:white;padding:30px"><p>Add ?code=XXXXXX to the URL</p></body></html>`);
  try {
    const r = await axios.post(`${SIGNAL_CLI_URL}/v1/register/${number}/code/${code}`);
    res.send(`<html><body style="background:#111;color:white;font-family:sans-serif;padding:30px;text-align:center"><h2 style="color:#06d6a0">Signal Registered!</h2><pre>${JSON.stringify(r.data, null, 2)}</pre></body></html>`);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;font-family:sans-serif;padding:30px;text-align:center"><h2 style="color:#ff6b6b">❌ Error</h2><pre>${e.message}</pre></body></html>`);
  }
});

app.get("/signal-setup-webhook", async (req, res) => {
  try {
    const r = await axios.post(`${SIGNAL_CLI_URL}/v1/configuration/${SIGNAL_NUMBER}/webhook`, { url: `${RENDER_URL}/signal` });
    res.send(`<html><body style="background:#111;color:white;padding:30px;font-family:sans-serif"><h2 style="color:#06d6a0">✅ Signal webhook set!</h2><pre>${JSON.stringify(r.data,null,2)}</pre></body></html>`);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;padding:30px;font-family:sans-serif"><h2 style="color:#ff6b6b">❌ ${e.message}</h2></body></html>`);
  }
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
    } else if (id.startsWith("sg_")) {
      await sendSignal(id.replace("sg_", ""), message);
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
app.get("/ping", (_req, res) => res.send("pong"));

function startKeepAlive() {
  if (!RENDER_URL) return console.log("⚠️  RENDER_URL not set — keep-alive disabled");
  setInterval(() => {
    axios.get(`${RENDER_URL}/ping`)
      .then(() => console.log(`keep-alive OK ${new Date().toISOString()}`))
      .catch(e  => console.warn("⚠️  keep-alive failed:", e.message));
    axios.get(`${SIGNAL_CLI_URL}/v1/health`).catch(() => {});
  }, 14 * 60 * 1000);
  console.log("⏱️  Keep-alive started (14 min interval)");
}

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, async () => {
  console.log(`\n🌸 Ariana LIVE on port ${PORT}`);
  console.log(`📱 Kapso:    ${KAPSO_API_KEY              ? "✅" : "❌ MISSING"}`);
  console.log(`🤖 Groq:     ${GROQ_API_KEY               ? "✅" : "❌ MISSING"}`);
  console.log(`🔁 Groq #2:  ${GROQ_API_KEY_2             ? "✅" : "—"}`);
  console.log(`✨ Gemini:   ${process.env.GEMINI_API_KEY  ? "✅" : "❌ MISSING"}`);
  console.log(`🔮 DeepSeek: ${process.env.DEEPSEEK_API_KEY? "✅" : "—"}`);
  console.log(`🌬️  Mistral:  ${process.env.MISTRAL_API_KEY ? "✅" : "—"}`);
  console.log(`🤝 Together: ${process.env.TOGETHER_API_KEY ? "✅" : "—"}`);
  console.log(`💬 Telegram: ${TELEGRAM_TOKEN             ? "✅" : "❌"}`);
  console.log(`📶 Signal:   ${SIGNAL_NUMBER              ? "✅ " + SIGNAL_NUMBER : "❌"}`);
  await registerTelegramWebhook();
  startKeepAlive();
});
