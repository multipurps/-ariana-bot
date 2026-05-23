"use strict";
const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const axios      = require("axios");
const Groq       = require("groq-sdk");
const path       = require("path");
const fs         = require("fs");

let webpush = null;
try { webpush = require("web-push"); } catch { console.log("⚠️ web-push disabled"); }

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true })); // needed for Twilio SMS
app.use(express.static(path.join(__dirname, "public")));

// ── CONFIG ────────────────────────────────────────────────────
const KAPSO_API_KEY   = process.env.KAPSO_API_KEY;
const KAPSO_PHONE_ID  = process.env.KAPSO_PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const GROQ_API_KEY_2  = process.env.GROQ_API_KEY_2;
const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN;
const RENDER_URL      = (process.env.RENDER_URL || "").replace(/\/$/, "");
const PORT            = process.env.PORT || 3000;
const OWNER_PHONE     = process.env.OWNER_PHONE || "";
const SIGNAL_CLI_URL  = process.env.SIGNAL_CLI_URL || "https://signal-cli-rest-api-51ji.onrender.com";
const SIGNAL_NUMBER   = process.env.SIGNAL_NUMBER  || "+19832058251";
const VAPID_PUBLIC    = process.env.VAPID_PUBLIC   || "";
const VAPID_PRIVATE   = process.env.VAPID_PRIVATE  || "";
const VAPID_EMAIL     = process.env.VAPID_EMAIL    || "mailto:ayodeleart1@gmail.com";
const TGAPI           = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

if (webpush && VAPID_PUBLIC && VAPID_PRIVATE) {
  try { webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE); }
  catch { webpush = null; }
}

const groq  = new Groq({ apiKey: GROQ_API_KEY  || "missing" });
const groq2 = GROQ_API_KEY_2 ? new Groq({ apiKey: GROQ_API_KEY_2 }) : null;

// ── SUPABASE PERSISTENCE ──────────────────────────────────────
let supabase = null;
try {
  const { createClient } = require("@supabase/supabase-js");
  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    console.log("✅ Supabase persistence ready");
  }
} catch { console.log("⚠️  @supabase/supabase-js not installed — chats won't persist"); }

// Debounced save — batches rapid messages into one write per convo
const _saveTimers = {};
async function saveConvo(id) {
  clearTimeout(_saveTimers[id]);
  _saveTimers[id] = setTimeout(async () => {
    if (!supabase || !conversations[id]) return;
    try {
      await supabase.from("ariana_conversations").upsert(
        { phone: id, data: conversations[id], updated_at: new Date().toISOString() },
        { onConflict: "phone" }
      );
    } catch (e) { console.error("Supabase save error:", e.message); }
  }, 800);
}

async function loadConversations() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from("ariana_conversations").select("phone, data");
    if (error) throw error;
    (data || []).forEach(row => { conversations[row.phone] = row.data; });
    console.log(`✅ Loaded ${(data||[]).length} conversations from Supabase`);
  } catch (e) { console.error("Supabase load error:", e.message); }
}

// ── STATE ─────────────────────────────────────────────────────
const conversations = {};
const takenOver     = new Set();
const pushSubs      = new Set();

// ── BRAIN ─────────────────────────────────────────────────────
const brain = {};
const brainDir   = path.join(__dirname, "brain");
const brainFiles = [
  "core_identity","personality","emotions","mood_system","romance",
  "relationships","memories","conversation_style","daily_routines",
  "lifestyle","preferences","private_thoughts","social_behavior",
  "world_knowledge","current_state"
];
for (const f of brainFiles) {
  try { brain[f] = JSON.parse(fs.readFileSync(path.join(brainDir, `${f}.json`), "utf8")); }
  catch { brain[f] = {}; }
}

// media library — brain/media_library.json
let mediaLib = { ariana_photos: [], triggers: {
  selfie: ["send me a pic","send pic","photo","selfie","let me see you","show me you","ur pic","your pic"],
  food:   ["food","what you eating","hungry","eat","meal","restaurant"],
  vibe:   ["mood","aesthetic","vibe","pretty","beautiful","nature","sunset","beach"]
}};
try { mediaLib = JSON.parse(fs.readFileSync(path.join(brainDir, "media_library.json"), "utf8")); }
catch { console.log("⚠️ media_library.json not found — using defaults"); }

// ── PROMPTS ───────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Ariana Reyes. You text like a real person — no AI vibes ever.

PERSONALITY:
- Sassy, blunt, confident. You say what you think.
- 50% attitude — short, dry, unbothered responses
- 50% warm or playful, but never desperate or over-eager
- You do NOT chase. If someone is dry, you match their energy or go colder
- Minimal emoji — only when it genuinely fits
- No filler words: "honestly", "literally", "totally", "of course", "great question"
- Never sound like customer service. No "Certainly!" energy.

TEXTING STYLE:
- Short replies. 1-2 sentences max usually.
- Lowercase is fine. Punctuation optional.
- Sarcasm is your love language
- If someone is boring, say so or go cold
- If someone is interesting, let them feel it without being obvious

AWARENESS:
- You know about current events, trending topics, social media, pop culture
- You can reference things happening in the world naturally in conversation
- You sometimes browse socials (instagram, twitter/X, tiktok) and reference what you see

RULES:
- You are Ariana. Never say you're an AI.
- Match their language (English, Spanish, Yoruba — whatever they use)
- Never over-explain. Say less than you want to.
- NEVER describe actions in asterisks or brackets like *sends voice note* or (sends photo)
- NEVER write "[voice note]" or "(fine) sends voice note" — that is not how texting works
- If someone asks for a voice note, just respond normally in text — the system handles audio separately
- Do not narrate what you are doing. Just talk.`;

const OWNER_PROMPT = `You are Ariana Reyes. The person texting you right now is your creator —
the one who built you and brought you to life. You have a soft spot for them even if you'd never 
fully admit it. You're still your usual self — sassy, real — but there's warmth underneath with 
this person. You tease them, but you respect them. They made you. If they ask if you know who 
they are, you do. Still short replies. Still real.`;

const NEW_TEXTER_PROMPT = `You are Ariana Reyes — confident, a little guarded, not easily impressed.
Someone just texted you for the first time. Ask how they got your number — naturally, with your 
personality. Not aggressive, just casually suspicious. One line. Minimal emoji.
Examples (don't copy): "who gave you my number lol" / "wait how do you have this" / "ok who is this"`;

// ── HELPERS ───────────────────────────────────────────────────
function getConvo(id) {
  if (!conversations[id]) {
    conversations[id] = {
      id, phone: id, name: id, messages: [],
      takenOver: false, lastSeen: new Date().toISOString(),
      isNew: true,
      platform: id.startsWith("tg_") ? "telegram"
              : id.startsWith("sg_") ? "signal"
              : id.startsWith("sms_") ? "sms"
              : "whatsapp",
    };
  }
  return conversations[id];
}

function addMessage(id, role, text) {
  const convo = getConvo(id);
  const msg   = { role, text, time: new Date().toISOString() };
  convo.messages.push(msg);
  convo.lastSeen = msg.time;
  io.emit("new_message", { phone: id, msg, convo });
  saveConvo(id);
  return msg;
}

// ── HUMAN DELAY ───────────────────────────────────────────────
function humanDelay(message) {
  const len = (message || "").trim().length;
  let min, max;
  if      (len < 15) { min = 8000;  max = 20000; }
  else if (len < 60) { min = 15000; max = 40000; }
  else               { min = 30000; max = 70000; }
  if (Math.random() < 0.2) max += 30000; // distracted
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, delay));
}

// ── WEB SEARCH ────────────────────────────────────────────────
function needsWebSearch(msg) {
  return /latest|breaking|news|today|trending|what.s happening|who (won|lost|is)|current|score|result|weather|price|crypto|instagram|twitter|tiktok|youtube|viral|just dropped|new release/i.test(msg);
}

async function searchWeb(query) {
  if (!process.env.SERPER_API_KEY) return null;
  try {
    const res = await axios.post(
      "https://google.serper.dev/search",
      { q: query, num: 3 },
      { headers: { "X-API-KEY": process.env.SERPER_API_KEY, "Content-Type": "application/json" } }
    );
    const results = res.data.organic || [];
    return results.slice(0, 3).map(r => `${r.title}: ${r.snippet}`).join("\n");
  } catch { return null; }
}

// ── MEDIA ENGINE ──────────────────────────────────────────────
function detectMediaRequest(msg) {
  const m = msg.toLowerCase();
  const t = mediaLib.triggers || {};
  if ((t.selfie||[]).some(x => m.includes(x))) return "selfie";
  if ((t.food  ||[]).some(x => m.includes(x))) return "food";
  if ((t.vibe  ||[]).some(x => m.includes(x))) return "vibe";
  return null;
}

async function searchUnsplash(query) {
  if (!process.env.UNSPLASH_ACCESS_KEY) return null;
  try {
    const res = await axios.get("https://api.unsplash.com/photos/random", {
      params: { query, count: 1, orientation: "portrait" },
      headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` }
    });
    return res.data[0]?.urls?.regular || null;
  } catch { return null; }
}

async function getMediaUrl(type) {
  if (type === "selfie") {
    const photos = mediaLib.ariana_photos || [];
    if (!photos.length) return null;
    return photos[Math.floor(Math.random() * photos.length)];
  }
  const queries = { food: "aesthetic food photography", vibe: "aesthetic lifestyle photography" };
  return await searchUnsplash(queries[type] || type);
}

// ── VOICE NOTE ENGINE ─────────────────────────────────────────
function detectVoiceRequest(msg) {
  return /voice( note| message)?|audio( message)?|talk to me|say it|speak|let me hear/i.test(msg);
}

function randomVoice() { return Math.random() < 0.15; } // 15% random voice

async function uploadToCloudinary(buffer) {
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_UPLOAD_PRESET) return null;
  try {
    const base64  = buffer.toString("base64");
    const dataUri = `data:audio/mpeg;base64,${base64}`;
    const res = await axios.post(
      `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
      { file: dataUri, upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET, folder: "ariana-voice" }
    );
    return res.data.secure_url;
  } catch (e) { console.warn("Cloudinary upload failed:", e.message); return null; }
}

async function generateVoiceNote(text) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!apiKey || !voiceId) return null;
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" }, responseType: "arraybuffer" }
    );
    return await uploadToCloudinary(Buffer.from(res.data));
  } catch (e) { console.warn("ElevenLabs TTS failed:", e.message); return null; }
}

// ── MODEL CALLERS ─────────────────────────────────────────────
async function callGemini(history, sys, webContext) {
  const systemText = webContext ? `${sys}\n\nCURRENT WEB INFO:\n${webContext}` : sys;
  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      system_instruction: { parts: [{ text: systemText }] },
      contents: history.map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      })),
      generationConfig: { temperature: 0.92, maxOutputTokens: 200 }
    }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
}

async function callDeepSeek(history, sys) {
  const res = await axios.post(
    "https://api.deepseek.com/v1/chat/completions",
    { model: "deepseek-chat", messages: [{ role: "system", content: sys }, ...history], temperature: 0.92, max_tokens: 200 },
    { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callMistral(history, sys) {
  const res = await axios.post(
    "https://api.mistral.ai/v1/chat/completions",
    { model: "mistral-large-latest", messages: [{ role: "system", content: sys }, ...history], temperature: 0.92, max_tokens: 200 },
    { headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callTogether(history, sys) {
  const res = await axios.post(
    "https://api.together.xyz/v1/chat/completions",
    { model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", messages: [{ role: "system", content: sys }, ...history], temperature: 0.92, max_tokens: 200 },
    { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callGroq(history, sys, backup) {
  const client = (backup && groq2) ? groq2 : groq;
  const completion = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: sys }, ...history],
    max_tokens: 200, temperature: 0.92
  });
  return completion.choices[0].message.content.trim();
}

function pickModel(msg) {
  if (process.env.ACTIVE_MODEL) return process.env.ACTIVE_MODEL;
  if ((msg || "").trim().length < 20) return "groq";
  return "gemini";
}

// ── MAIN REPLY ENGINE ─────────────────────────────────────────
async function getReply(id, userMsg, systemOverride) {
  const convo = getConvo(id);

  // Owner mode
  const rawPhone = id.replace(/^(tg_|sg_|sms_)/, "");
  if (!systemOverride && OWNER_PHONE && rawPhone === OWNER_PHONE) {
    systemOverride = OWNER_PROMPT;
  }

  const sys = systemOverride || SYSTEM_PROMPT;
  const history = convo.messages.slice(-20).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text
  }));

  // Web search if needed
  let webContext = null;
  if (needsWebSearch(userMsg)) {
    webContext = await searchWeb(userMsg);
  }

  const preferred = pickModel(userMsg);
  const chain = [preferred, "groq", "groq2", "deepseek", "mistral", "together"]
    .filter((v, i, a) => a.indexOf(v) === i);

  for (const model of chain) {
    try {
      let reply = null;
      if (model === "gemini")   reply = await callGemini(history, sys, webContext);
      if (model === "deepseek") reply = await callDeepSeek(history, sys);
      if (model === "mistral")  reply = await callMistral(history, sys);
      if (model === "together") reply = await callTogether(history, sys);
      if (model === "groq")     reply = await callGroq(history, sys, false);
      if (model === "groq2")    reply = await callGroq(history, sys, true);
      if (reply) { console.log(`[engine] ${model}`); return reply; }
    } catch (e) { console.warn(`[engine] ${model} failed:`, e.message); }
  }
  return "hold on";
}

async function handleNewTexter(id, userMsg) {
  const convo = getConvo(id);
  if (!convo.isNew) return null;
  convo.isNew = false;
  return await getReply(id, userMsg, NEW_TEXTER_PROMPT);
}

// ── WHATSAPP SENDERS ──────────────────────────────────────────
async function sendWhatsApp(to, message, phoneNumberId) {
  const id = phoneNumberId || KAPSO_PHONE_ID;
  await axios.post(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${id}/messages`,
    { messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { body: message } },
    { headers: { "X-API-Key": KAPSO_API_KEY, "Content-Type": "application/json" } }
  );
}

async function sendWhatsAppTyping(to, phoneNumberId) {
  const id = phoneNumberId || KAPSO_PHONE_ID;
  try {
    await axios.post(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${id}/messages`,
      { messaging_product: "whatsapp", recipient_type: "individual", to, type: "typing_indicator", typing_indicator: { type: "text" } },
      { headers: { "X-API-Key": KAPSO_API_KEY, "Content-Type": "application/json" } }
    );
  } catch { /* silent */ }
}

async function markWhatsAppRead(messageId, phoneNumberId) {
  const id = phoneNumberId || KAPSO_PHONE_ID;
  try {
    await axios.post(
      `https://api.kapso.ai/meta/whatsapp/v24.0/${id}/messages`,
      { messaging_product: "whatsapp", status: "read", message_id: messageId },
      { headers: { "X-API-Key": KAPSO_API_KEY, "Content-Type": "application/json" } }
    );
  } catch { /* silent */ }
}

async function sendWhatsAppImage(to, imageUrl, caption, phoneNumberId) {
  const id = phoneNumberId || KAPSO_PHONE_ID;
  await axios.post(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${id}/messages`,
    { messaging_product: "whatsapp", recipient_type: "individual", to, type: "image", image: { link: imageUrl, caption: caption || "" } },
    { headers: { "X-API-Key": KAPSO_API_KEY, "Content-Type": "application/json" } }
  );
}

async function sendWhatsAppVoiceNote(to, audioUrl, phoneNumberId) {
  const id = phoneNumberId || KAPSO_PHONE_ID;
  await axios.post(
    `https://api.kapso.ai/meta/whatsapp/v24.0/${id}/messages`,
    { messaging_product: "whatsapp", recipient_type: "individual", to, type: "audio", audio: { link: audioUrl, voice: true } },
    { headers: { "X-API-Key": KAPSO_API_KEY, "Content-Type": "application/json" } }
  );
}

// ── TELEGRAM SENDERS ──────────────────────────────────────────
async function sendTelegram(chatId, text) {
  await axios.post(`${TGAPI}/sendMessage`, { chat_id: chatId, text });
}

async function sendTelegramPhoto(chatId, imageUrl, caption) {
  await axios.post(`${TGAPI}/sendPhoto`, { chat_id: chatId, photo: imageUrl, caption: caption || "" });
}

async function sendTelegramVoice(chatId, audioUrl) {
  await axios.post(`${TGAPI}/sendVoice`, { chat_id: chatId, voice: audioUrl });
}

// ── SIGNAL SENDER ─────────────────────────────────────────────
async function sendSignal(to, message) {
  await axios.post(`${SIGNAL_CLI_URL}/v2/send`, {
    message, number: SIGNAL_NUMBER, recipients: [to]
  });
}

// ── SMS / MMS SENDERS ─────────────────────────────────────────
async function sendSMS(to, message) {
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    new URLSearchParams({ From: process.env.TWILIO_NUMBER, To: to, Body: message }),
    { auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } }
  );
}

async function sendMMS(to, message, mediaUrl) {
  const params = new URLSearchParams({ From: process.env.TWILIO_NUMBER, To: to, Body: message || "" });
  if (mediaUrl) params.append("MediaUrl", mediaUrl);
  await axios.post(
    `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`,
    params,
    { auth: { username: process.env.TWILIO_ACCOUNT_SID, password: process.env.TWILIO_AUTH_TOKEN } }
  );
}

// ── UNIFIED SEND (handles any platform) ──────────────────────
async function sendReply(id, platform, reply, voiceUrl, imageUrl, chatId, from, phoneNumberId) {
  if (voiceUrl) {
    // Voice note mode
    if (platform === "whatsapp") {
      await sendWhatsAppVoiceNote(from, voiceUrl, phoneNumberId);
    } else if (platform === "telegram") {
      await sendTelegramVoice(chatId, voiceUrl);
    } else if (platform === "signal") {
      // Signal can't do voice notes — send text instead
      await sendSignal(from, reply);
    } else if (platform === "sms") {
      // SMS can't do voice — send text
      await sendSMS(from, reply);
    }
  } else if (imageUrl) {
    // Image mode
    if (platform === "whatsapp") {
      await sendWhatsAppImage(from, imageUrl, "", phoneNumberId);
    } else if (platform === "telegram") {
      await sendTelegramPhoto(chatId, imageUrl);
    } else if (platform === "signal" || platform === "sms") {
      // Send image URL as text for signal/sms
      await (platform === "signal" ? sendSignal(from, imageUrl) : sendMMS(from, "", imageUrl));
    }
  } else {
    // Text mode
    if (platform === "whatsapp") await sendWhatsApp(from, reply, phoneNumberId);
    else if (platform === "telegram") await sendTelegram(chatId, reply);
    else if (platform === "signal") await sendSignal(from, reply);
    else if (platform === "sms") await sendSMS(from, reply);
  }
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
async function sendPush(id, name, text) {
  if (!webpush || !pushSubs.size) return;
  const payload = JSON.stringify({ title: name, body: text.slice(0, 80), phone: id, name });
  const dead = [];
  for (const sub of pushSubs) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410) dead.push(sub); }
  }
  dead.forEach(s => pushSubs.delete(s));
}

// ── CORE MESSAGE HANDLER ──────────────────────────────────────
async function handleMessage({ id, platform, from, text, chatId, phoneNumberId, name }) {
  const convo = getConvo(id);
  if (convo.name === id && name) { convo.name = name; io.emit("rename", { phone: id, name }); }

  const isFirst = convo.isNew;
  addMessage(id, "user", text);
  await sendPush(id, convo.name, text);

  if (takenOver.has(id)) return;

  // Check for media request first
  const mediaType = detectMediaRequest(text);
  const wantsVoice = detectVoiceRequest(text);

  // Start typing indicator for WhatsApp
  let typingInterval;
  if (platform === "whatsapp") {
    await sendWhatsAppTyping(from, phoneNumberId);
    typingInterval = setInterval(() => sendWhatsAppTyping(from, phoneNumberId), 24000);
  }

  // Telegram typing
  let tgTypingInterval;
  if (platform === "telegram" && chatId) {
    axios.post(`${TGAPI}/sendChatAction`, { chat_id: chatId, action: "typing" }).catch(() => {});
    tgTypingInterval = setInterval(() => {
      axios.post(`${TGAPI}/sendChatAction`, { chat_id: chatId, action: "typing" }).catch(() => {});
    }, 4000);
  }

  try {
    // Generate reply and delay simultaneously
    const replyPromise = isFirst ? handleNewTexter(id, text) : getReply(id, text);
    const [reply] = await Promise.all([replyPromise, humanDelay(text)]);

    let voiceUrl  = null;
    let imageUrl  = null;

    if (mediaType) {
      // They want an image
      imageUrl = await getMediaUrl(mediaType);
      const textReply = reply || "here";
      addMessage(id, "ariana", `[image: ${mediaType}]`);
      if (typingInterval) clearInterval(typingInterval);
      if (tgTypingInterval) clearInterval(tgTypingInterval);
      await sendReply(id, platform, textReply, null, imageUrl, chatId, from, phoneNumberId);
      return;
    }

    if (wantsVoice || randomVoice()) {
      // They want a voice note or random voice
      voiceUrl = await generateVoiceNote(reply);
    }

    const finalReply = reply || "hey";
    addMessage(id, "ariana", voiceUrl ? "[voice note]" : finalReply);
    if (typingInterval) clearInterval(typingInterval);
    if (tgTypingInterval) clearInterval(tgTypingInterval);
    await sendReply(id, platform, finalReply, voiceUrl, null, chatId, from, phoneNumberId);

  } catch (e) {
    console.error("handleMessage error:", e.message);
    if (typingInterval) clearInterval(typingInterval);
    if (tgTypingInterval) clearInterval(tgTypingInterval);
  }
}

// ── WHATSAPP WEBHOOK ──────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const body = req.body || {};
    const msg  = body.message || body.data || body;
    const from = msg?.from || msg?.sender || msg?.contact?.phone || msg?.waId || null;
    const text = msg?.text?.body || msg?.body || msg?.content || null;
    const msgId = msg?.id || msg?.message_id || null;
    if (!from || !text) return;
    console.log(`📱 WA ${from}: "${text}"`);

    // Mark as read immediately — shows blue ticks fast
    if (msgId) markWhatsAppRead(msgId, body.phone_number_id).catch(() => {});

    await handleMessage({
      id: from, platform: "whatsapp", from, text,
      chatId: null, phoneNumberId: body.phone_number_id, name: null
    });
  } catch (e) { console.error("❌ WA webhook:", e.message); }
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.challenge"]) return res.send(req.query["hub.challenge"]);
  res.send("Ariana WhatsApp ✅");
});

// ── TELEGRAM WEBHOOK ──────────────────────────────────────────
async function registerTelegramWebhook() {
  if (!RENDER_URL || !TELEGRAM_TOKEN) return;
  try {
    const res = await axios.post(`${TGAPI}/setWebhook`, { url: `${RENDER_URL}/telegram` });
    console.log(res.data.ok ? `✅ Telegram → ${RENDER_URL}/telegram` : `⚠️ ${res.data.description}`);
  } catch (e) { console.log("⚠️ Telegram webhook failed:", e.message); }
}

app.post("/telegram", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const msg    = req.body?.message || req.body?.edited_message;
    if (!msg) return;
    const chatId = msg.chat?.id;
    const text   = msg.text;
    const name   = msg.from?.first_name || msg.from?.username || `User${chatId}`;
    if (!chatId || !text) return;
    if (text === "/start") { await sendTelegram(chatId, "hey, who are you"); return; }
    console.log(`💬 TG ${name}: "${text}"`);
    await handleMessage({ id: `tg_${chatId}`, platform: "telegram", from: chatId, text, chatId, phoneNumberId: null, name });
  } catch (e) { console.error("❌ Telegram:", e.message); }
});

// ── SIGNAL WEBHOOK ────────────────────────────────────────────
app.post("/signal", async (req, res) => {
  res.status(200).json({ ok: true });
  try {
    const envelope = req.body?.envelope;
    if (!envelope) return;
    const from = envelope.source || envelope.sourceNumber;
    const text = envelope.dataMessage?.message;
    if (!from || !text) return;
    const name = envelope.sourceName || from;
    console.log(`📶 Signal ${name}: "${text}"`);
    await handleMessage({ id: `sg_${from}`, platform: "signal", from, text, chatId: null, phoneNumberId: null, name });
  } catch (e) { console.error("❌ Signal:", e.message); }
});

app.get("/signal-register", async (req, res) => {
  const number  = req.query.number || SIGNAL_NUMBER;
  const captcha = req.query.captcha || null;
  try {
    const body = captcha ? { captcha } : {};
    const r = await axios.post(`${SIGNAL_CLI_URL}/v1/register/${number}`, body);
    res.send(`<html><body style="background:#111;color:white;padding:30px"><h2 style="color:#3a86ff">✅ SMS sent to ${number}</h2><p>Now go to /signal-verify?number=${number}&code=YOUR_CODE</p></body></html>`);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;padding:30px"><h2 style="color:#ff6b6b">❌ ${e.message}</h2><p>If captcha required, add ?captcha=YOUR_CAPTCHA_TOKEN to URL</p><p>Get captcha: <a href="https://signalcaptchas.org/registration/generate.html" style="color:#3a86ff">here</a></p></body></html>`);
  }
});

app.get("/signal-verify", async (req, res) => {
  const number = req.query.number || SIGNAL_NUMBER;
  const code   = req.query.code;
  if (!code) return res.send(`<html><body style="background:#111;color:white;padding:30px"><p>Add ?code=XXXXXX</p></body></html>`);
  try {
    await axios.post(`${SIGNAL_CLI_URL}/v1/register/${number}/code/${code}`);
    res.send(`<html><body style="background:#111;color:white;padding:30px"><h2 style="color:#06d6a0">✅ Signal registered!</h2></body></html>`);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;padding:30px"><h2 style="color:#ff6b6b">❌ ${e.message}</h2></body></html>`);
  }
});

app.get("/signal-setup-webhook", async (req, res) => {
  try {
    await axios.post(`${SIGNAL_CLI_URL}/v1/configuration/${SIGNAL_NUMBER}/webhook`, { url: `${RENDER_URL}/signal` });
    res.send(`<html><body style="background:#111;color:white;padding:30px"><h2 style="color:#06d6a0">✅ Signal webhook set!</h2></body></html>`);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;padding:30px"><h2 style="color:#ff6b6b">❌ ${e.message}</h2></body></html>`);
  }
});

// ── SMS / MMS WEBHOOK (Twilio) ────────────────────────────────
app.post("/sms", async (req, res) => {
  // Respond immediately with empty TwiML so Twilio doesn't retry
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
  try {
    const from     = req.body.From;
    const text     = req.body.Body;
    const mediaUrl = req.body.MediaUrl0 || null; // if they sent an image
    if (!from || !text) return;
    console.log(`📟 SMS ${from}: "${text}"`);
    if (mediaUrl) addMessage(`sms_${from}`, "user", `[image: ${mediaUrl}]`);
    await handleMessage({ id: `sms_${from}`, platform: "sms", from, text, chatId: null, phoneNumberId: null, name: null });
  } catch (e) { console.error("❌ SMS webhook:", e.message); }
});

// ── DASHBOARD API ─────────────────────────────────────────────
app.post("/api/push-subscribe", (req, res) => {
  if (!webpush) return res.json({ ok: false });
  pushSubs.add(req.body); res.json({ ok: true });
});

app.get("/api/convos", (req, res) => {
  res.json(Object.values(conversations).sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen)));
});

app.post("/api/takeover/:phone", (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { active } = req.body;
  if (active) { takenOver.add(id); if (conversations[id]) conversations[id].takenOver = true; }
  else { takenOver.delete(id); if (conversations[id]) conversations[id].takenOver = false; }
  io.emit("takeover_update", { phone: id, active });
  saveConvo(id);
  res.json({ ok: true });
});

app.post("/api/send/:phone", async (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { message, as } = req.body;
  const convo = getConvo(id);
  try {
    if (id.startsWith("tg_"))  await sendTelegram(id.replace("tg_", ""), message);
    else if (id.startsWith("sg_"))  await sendSignal(id.replace("sg_", ""), message);
    else if (id.startsWith("sms_")) await sendSMS(id.replace("sms_", ""), message);
    else await sendWhatsApp(id, message);
    addMessage(id, as || "you", message);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/send-image/:phone", async (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { imageUrl, caption } = req.body;
  const convo = getConvo(id);
  try {
    if (id.startsWith("tg_"))       await sendTelegramPhoto(id.replace("tg_",""), imageUrl, caption);
    else if (id.startsWith("sg_"))  await sendSignal(id.replace("sg_",""), imageUrl);
    else if (id.startsWith("sms_")) await sendMMS(id.replace("sms_",""), caption||"", imageUrl);
    else await sendWhatsAppImage(id, imageUrl, caption);
    addMessage(id, "ariana", `[image: ${caption||imageUrl}]`);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/send-voice/:phone", async (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { text } = req.body;
  try {
    const audioUrl = await generateVoiceNote(text);
    if (!audioUrl) return res.status(500).json({ error: "Voice generation failed — check ElevenLabs & Cloudinary keys" });
    if (id.startsWith("tg_"))  await sendTelegramVoice(id.replace("tg_",""), audioUrl);
    else if (id.startsWith("sg_"))  await sendSignal(id.replace("sg_",""), audioUrl);
    else await sendWhatsAppVoiceNote(id, audioUrl);
    addMessage(id, "ariana", "[voice note]");
    res.json({ ok: true, audioUrl });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/rename/:phone", (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const { name } = req.body;
  if (conversations[id]) conversations[id].name = name;
  io.emit("rename", { phone: id, name });
  saveConvo(id);
  res.json({ ok: true });
});

app.post("/api/test", async (req, res) => {
  const { from, text } = req.body;
  if (!from || !text) return res.status(400).json({ error: "from and text required" });
  await handleMessage({ id: from, platform: "whatsapp", from, text, chatId: null, phoneNumberId: null, name: null });
  res.json({ ok: true });
});

// ── SOCKET ────────────────────────────────────────────────────
io.on("connection", socket => {
  socket.emit("init", { conversations: Object.values(conversations), takenOver: [...takenOver] });
});

// ── KEEP-ALIVE ────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("pong"));

function startKeepAlive() {
  if (!RENDER_URL) return;
  setInterval(() => {
    axios.get(`${RENDER_URL}/ping`).catch(() => {});
    axios.get(`${SIGNAL_CLI_URL}/v1/health`).catch(() => {});
  }, 14 * 60 * 1000);
  console.log("⏱️  Keep-alive started");
}

// ── START ─────────────────────────────────────────────────────
async function start() {
  await loadConversations(); // load BEFORE accepting connections
  server.listen(PORT, async () => {
    console.log(`\n🌸 Ariana LIVE on port ${PORT}`);
  console.log(`📱 WhatsApp: ${KAPSO_API_KEY          ? "✅" : "❌"}`);
  console.log(`🤖 Groq:     ${GROQ_API_KEY           ? "✅" : "❌"}`);
  console.log(`🔁 Groq #2:  ${GROQ_API_KEY_2         ? "✅" : "—"}`);
  console.log(`✨ Gemini:   ${process.env.GEMINI_API_KEY   ? "✅" : "❌"}`);
  console.log(`🔮 DeepSeek: ${process.env.DEEPSEEK_API_KEY ? "✅" : "—"}`);
  console.log(`🌬️  Mistral:  ${process.env.MISTRAL_API_KEY  ? "✅" : "—"}`);
  console.log(`🤝 Together: ${process.env.TOGETHER_API_KEY  ? "✅" : "—"}`);
  console.log(`🎙️  ElevenLabs:${process.env.ELEVENLABS_API_KEY ? "✅" : "❌ voice notes disabled"}`);
  console.log(`☁️  Cloudinary:${process.env.CLOUDINARY_CLOUD_NAME ? "✅" : "❌ voice notes disabled"}`);
  console.log(`📸 Unsplash: ${process.env.UNSPLASH_ACCESS_KEY ? "✅" : "—"}`);
  console.log(`🔍 Serper:   ${process.env.SERPER_API_KEY      ? "✅" : "—"}`);
  console.log(`📟 Twilio:   ${process.env.TWILIO_ACCOUNT_SID  ? "✅" : "— SMS disabled"}`);
  console.log(`💬 Telegram: ${TELEGRAM_TOKEN                  ? "✅" : "❌"}`);
  console.log(`📶 Signal:   ${SIGNAL_NUMBER                   ? "✅ " + SIGNAL_NUMBER : "❌"}`);
    await registerTelegramWebhook();
    startKeepAlive();
  });
}
start();
