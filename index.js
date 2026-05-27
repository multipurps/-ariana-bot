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
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

// ── CONFIG ────────────────────────────────────────────────────
const KAPSO_API_KEY   = process.env.KAPSO_API_KEY;
const KAPSO_PHONE_ID  = process.env.KAPSO_PHONE_NUMBER_ID;
const GROQ_API_KEY    = process.env.GROQ_API_KEY;
const GROQ_API_KEY_2  = process.env.GROQ_API_KEY_2;
const RENDER_URL      = (process.env.RENDER_URL || "").replace(/\/$/, "");
const PORT            = process.env.PORT || 3000;
const OWNER_PHONE     = process.env.OWNER_PHONE || "";
const SIGNAL_CLI_URL  = process.env.SIGNAL_CLI_URL || "https://signal-cli-rest-api-51ji.onrender.com";
const SIGNAL_NUMBER   = process.env.SIGNAL_NUMBER  || "+19832058251";
const VAPID_PUBLIC    = process.env.VAPID_PUBLIC   || "";
const VAPID_PRIVATE   = process.env.VAPID_PRIVATE  || "";
const VAPID_EMAIL     = process.env.VAPID_EMAIL    || "mailto:ayodeleart1@gmail.com";

// Telegram GramJS config
const TG_API_ID   = parseInt(process.env.TELEGRAM_API_ID  || "0");
const TG_API_HASH =           process.env.TELEGRAM_API_HASH || "";
const TG_SESSION  =           process.env.TELEGRAM_SESSION  || "";

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
  const ws = require("ws");
  const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
                || process.env.SUPABASE_SERVICE_KEY
                || process.env.SUPABASE_ANON_KEY
                || process.env.SUPABASE_KEY;
  if (process.env.SUPABASE_URL && SUPA_KEY) {
    supabase = createClient(process.env.SUPABASE_URL, SUPA_KEY, {
      auth: { persistSession: false },
      realtime: { transport: ws }
    });
    console.log("✅ Supabase ready");
  } else {
    console.log("⚠️  Supabase env vars missing");
  }
} catch (e) { console.log("⚠️  Supabase init failed:", e.message); }

async function saveConvo(id) {
  if (!supabase || !conversations[id]) return;
  try {
    await supabase.from("ariana_conversations").upsert(
      { phone: id, data: conversations[id], updated_at: new Date().toISOString() },
      { onConflict: "phone" }
    );
  } catch (e) { console.error("Supabase save error:", e.message); }
}

// Flush all unsaved convos before process dies
async function flushAll() {
  if (!supabase) return;
  const ids = Object.keys(conversations);
  await Promise.allSettled(ids.map(id =>
    supabase.from("ariana_conversations").upsert(
      { phone: id, data: conversations[id], updated_at: new Date().toISOString() },
      { onConflict: "phone" }
    )
  ));
  console.log(`💾 Flushed ${ids.length} conversations`);
}
process.on('SIGTERM', async () => { await flushAll(); process.exit(0); });
process.on('SIGINT',  async () => { await flushAll(); process.exit(0); });

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
      // Platform is derived from ID prefix — stored in convo so dashboard reads it correctly on any device
      platform: id.startsWith("tg_")  ? "telegram"
              : id.startsWith("sg_")  ? "signal"
              : id.startsWith("sms_") ? "sms"
              : "whatsapp",
    };
  }
  // Backfill platform on any old convos that were loaded without it
  if (!conversations[id].platform) {
    conversations[id].platform = id.startsWith("tg_")  ? "telegram"
                                : id.startsWith("sg_")  ? "signal"
                                : id.startsWith("sms_") ? "sms"
                                : "whatsapp";
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
  if (Math.random() < 0.2) max += 30000;
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

function randomVoice() { return Math.random() < 0.15; }

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
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
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
    },
    { timeout: 18000 }
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
  const rawPhone = id.replace(/^(tg_|sg_|sms_)/, "");
  if (!systemOverride && OWNER_PHONE && rawPhone === OWNER_PHONE) {
    systemOverride = OWNER_PROMPT;
  }

  // Check auto-reply rules first
  const lowerMsg = (userMsg || "").toLowerCase();
  for (const rule of extrasRules) {
    if (rule.trigger && lowerMsg.includes(rule.trigger.toLowerCase())) {
      console.log(`[rules] matched: "${rule.trigger}"`);
      return rule.reply;
    }
  }

  // Build system prompt with mood override if set
  let sys = systemOverride || SYSTEM_PROMPT;
  if (extrasMood && !systemOverride) {
    sys += `\n\nCURRENT MOOD OVERRIDE: You are feeling ${extrasMood} right now. Let this genuinely influence your tone, energy, and word choice.`;
  }

  // Apply per-contact persona if set
  const personaForContact = extrasPersonas[rawPhone];
  if (personaForContact && personaForContact !== 'default' && !systemOverride) {
    const personaMap = {
      sweet: "Be extra warm, caring, and affectionate with this person.",
      cold: "Be distant, short, and slightly detached with this person. Not rude, just cold.",
      flirty: "Be playfully flirty and teasing with this person.",
      distant: "Be very brief and minimal with this person. One-word or short answers."
    };
    const inst = personaMap[personaForContact];
    if (inst) sys += `\n\nPERSONA FOR THIS CONTACT: ${inst}`;
  }

  const history = convo.messages.slice(-20).map(m => ({
    role: m.role === "user" ? "user" : "assistant",
    content: m.text
  }));

  let webContext = null;
  if (needsWebSearch(userMsg)) webContext = await searchWeb(userMsg);

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

// ── TELEGRAM SENDERS (GramJS) ─────────────────────────────────
let tgClient = null;

async function sendTelegram(chatId, text) {
  if (!tgClient) throw new Error("Telegram not connected");
  await tgClient.sendMessage(chatId, { message: text });
}

async function sendTelegramPhoto(chatId, imageUrl, caption) {
  if (!tgClient) throw new Error("Telegram not connected");
  // Download image to buffer then send — avoids URL permission issues
  const resp = await axios.get(imageUrl, { responseType: "arraybuffer" });
  const buf  = Buffer.from(resp.data);
  await tgClient.sendFile(chatId, {
    file: buf, caption: caption || "", forceDocument: false,
    attributes: [{ className: "DocumentAttributeFilename", fileName: "photo.jpg" }]
  });
}

async function sendTelegramVoice(chatId, audioUrl) {
  if (!tgClient) throw new Error("Telegram not connected");
  const resp = await axios.get(audioUrl, { responseType: "arraybuffer" });
  const buf  = Buffer.from(resp.data);
  await tgClient.sendFile(chatId, { file: buf, voiceNote: true });
}

// ── TELEGRAM INIT (GramJS) ────────────────────────────────────
async function initTelegram() {
  if (!TG_API_ID || !TG_API_HASH || !TG_SESSION) {
    console.log("⚠️  Telegram: TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION not set");
    console.log("    → Run gen-session.js locally to generate your session string");
    return;
  }

  try {
    const { TelegramClient } = require("telegram");
    const { StringSession }  = require("telegram/sessions");
    const { NewMessage }     = require("telegram/events");

    tgClient = new TelegramClient(
      new StringSession(TG_SESSION), TG_API_ID, TG_API_HASH,
      { connectionRetries: 5, retryDelay: 2000, useWSS: true }
    );

    await tgClient.connect();

    const me = await tgClient.getMe();
    console.log(`✅ Telegram (GramJS) connected as @${me.username || me.firstName}`);

    // Listen for all incoming messages
    tgClient.addEventHandler(async (event) => {
      try {
        const msg = event.message;
        if (!msg || msg.out) return;

        const sender = await msg.getSender();
        if (!sender || sender.bot) return;

        const chatId = sender.id?.toString();
        if (!chatId) return;

        const name = [sender.firstName, sender.lastName].filter(Boolean).join(" ").trim()
                     || sender.username
                     || `User${chatId}`;

        // Handle text OR media
        let text = msg.text || null;
        if (!text) {
          const media = msg.media;
          if (!media) return;
          const mtype = media.className || "";
          if      (mtype.includes("Photo"))    text = msg.message ? `[image: ${msg.message}]` : "[sent a photo]";
          else if (mtype.includes("Document")) text = "[sent a file]";
          else if (mtype.includes("Geo"))      text = "[sent a location]";
          else if (mtype.includes("Voice") || mtype.includes("Audio")) text = "[sent a voice message]";
          else if (mtype.includes("Video"))    text = msg.message ? `[video: ${msg.message}]` : "[sent a video]";
          else                                 text = "[sent media]";
        }

        // Save contact name automatically
        const convoId = `tg_${chatId}`;
        if (name && conversations[convoId]) {
          if (!conversations[convoId].name || conversations[convoId].name === convoId) {
            conversations[convoId].name = name;
            saveConvo(convoId);
          }
        }

        console.log(`💬 TG ${name} (${chatId}): "${text}"`);

        await handleMessage({
          id: convoId, platform: "telegram",
          from: chatId, text, chatId,
          phoneNumberId: null, name
        });

      } catch (e) { console.error("❌ TG message handler:", e.message); }
    }, new NewMessage({ incoming: true }));

    // Reconnect on disconnect — poll every 30s (avoids gramjs Raw instanceof bug)
    setInterval(async () => {
      if (tgClient && !tgClient.connected) {
        console.log("⚠️  Telegram disconnected — reconnecting...");
        tgClient.connect().catch(console.error);
      }
    }, 30_000);

  } catch (e) {
    console.error("❌ Telegram init failed:", e.message);
    tgClient = null;
  }
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

// ── UNIFIED SEND ──────────────────────────────────────────────
async function sendReply(id, platform, reply, voiceUrl, imageUrl, chatId, from, phoneNumberId) {
  if (voiceUrl) {
    if (platform === "whatsapp")      await sendWhatsAppVoiceNote(from, voiceUrl, phoneNumberId);
    else if (platform === "telegram") await sendTelegramVoice(chatId, voiceUrl);
    else if (platform === "signal")   await sendSignal(from, reply);
    else if (platform === "sms")      await sendSMS(from, reply);
  } else if (imageUrl) {
    if (platform === "whatsapp")      await sendWhatsAppImage(from, imageUrl, "", phoneNumberId);
    else if (platform === "telegram") await sendTelegramPhoto(chatId, imageUrl);
    else if (platform === "signal")   await sendSignal(from, imageUrl);
    else if (platform === "sms")      await sendMMS(from, "", imageUrl);
  } else {
    if (platform === "whatsapp")      await sendWhatsApp(from, reply, phoneNumberId);
    else if (platform === "telegram") await sendTelegram(chatId, reply);
    else if (platform === "signal")   await sendSignal(from, reply);
    else if (platform === "sms")      await sendSMS(from, reply);
  }
}

// ── PUSH NOTIFICATIONS ────────────────────────────────────────
async function sendPush(id, name, text) {
  if (!webpush || !pushSubs.size) return;
  const payload = JSON.stringify({ title: name, body: text.slice(0, 80), phone: id, name });
  const dead = [];
  for (const sub of pushSubs) {
    try { await webpush.sendNotification(sub, payload); }
    catch (e) { if (e.statusCode === 410 || e.statusCode === 404) { dead.push(sub); deletePushSub(sub); } }
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

  const mediaType  = detectMediaRequest(text);
  const wantsVoice = detectVoiceRequest(text);

  let typingInterval;
  if (platform === "whatsapp") {
    await sendWhatsAppTyping(from, phoneNumberId);
    typingInterval = setInterval(() => sendWhatsAppTyping(from, phoneNumberId), 24000);
  }

  // Telegram typing action
  let tgTypingInterval;
  if (platform === "telegram" && chatId && tgClient) {
    try {
      await tgClient.invoke(new (require("telegram/tl/functions/messages").SetTypingRequest)({
        peer: chatId, action: new (require("telegram/tl/types").SendMessageTypingAction)()
      }));
      tgTypingInterval = setInterval(async () => {
        try {
          await tgClient.invoke(new (require("telegram/tl/functions/messages").SetTypingRequest)({
            peer: chatId, action: new (require("telegram/tl/types").SendMessageTypingAction)()
          }));
        } catch {}
      }, 4000);
    } catch {}
  }

  try {
    const replyPromise = isFirst ? handleNewTexter(id, text) : getReply(id, text);
    const [reply] = await Promise.all([replyPromise, humanDelay(text)]);

    let voiceUrl = null;
    let imageUrl = null;

    if (mediaType) {
      imageUrl = await getMediaUrl(mediaType);
      const textReply = reply || "here";
      addMessage(id, "ariana", `[image: ${mediaType}]`);
      if (typingInterval)   clearInterval(typingInterval);
      if (tgTypingInterval) clearInterval(tgTypingInterval);
      await sendReply(id, platform, textReply, null, imageUrl, chatId, from, phoneNumberId);
      return;
    }

    if (wantsVoice || randomVoice()) {
      voiceUrl = await generateVoiceNote(reply);
    }

    addMessage(id, "ariana", voiceUrl ? "[voice note]" : reply);
    if (typingInterval)   clearInterval(typingInterval);
    if (tgTypingInterval) clearInterval(tgTypingInterval);
    await sendReply(id, platform, reply, voiceUrl, null, chatId, from, phoneNumberId);

  } catch (e) {
    console.error("handleMessage error:", e.message);
    if (typingInterval)   clearInterval(typingInterval);
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
    if (!from) return;

    // Extract contact name from webhook (WhatsApp sends pushName)
    const contactName = msg?.pushName || msg?.senderName || msg?.contact?.name || null;

    // Extract text OR media description
    const text      = msg?.text?.body || msg?.body || msg?.content || null;
    const mediaType = msg?.type || msg?.messageType || null;
    const mediaUrl  = msg?.image?.url || msg?.video?.url || msg?.audio?.url
                   || msg?.document?.url || msg?.sticker?.url || null;
    const caption   = msg?.image?.caption || msg?.video?.caption || msg?.document?.caption || null;

    // Build the message text — for media with no text, describe it
    let finalText = text;
    if (!finalText && mediaType) {
      if      (mediaType === "image")    finalText = caption ? `[image: ${caption}]` : "[sent an image]";
      else if (mediaType === "video")    finalText = caption ? `[video: ${caption}]` : "[sent a video]";
      else if (mediaType === "audio")    finalText = "[sent a voice message]";
      else if (mediaType === "document") finalText = "[sent a document]";
      else if (mediaType === "sticker")  finalText = "[sent a sticker]";
      else                               finalText = `[sent ${mediaType}]`;
    }
    if (!finalText) return;

    const msgId = msg?.id || msg?.message_id || null;
    console.log(`📱 WA ${contactName||from}: "${finalText}"`);
    if (msgId) markWhatsAppRead(msgId, body.phone_number_id).catch(() => {});

    // Save contact name so dashboard shows it
    if (contactName && conversations[from] && !conversations[from].name || conversations[from]?.name === from) {
      if (conversations[from]) conversations[from].name = contactName;
    }

    await handleMessage({
      id: from, platform: "whatsapp", from, text: finalText,
      chatId: null, phoneNumberId: body.phone_number_id, name: contactName,
      mediaUrl, mediaType
    });
  } catch (e) { console.error("❌ WA webhook:", e.message); }
});

app.get("/webhook", (req, res) => {
  if (req.query["hub.challenge"]) return res.send(req.query["hub.challenge"]);
  res.send("Ariana WhatsApp ✅");
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
    await axios.post(`${SIGNAL_CLI_URL}/v1/register/${number}`, body);
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
  res.set("Content-Type", "text/xml");
  res.send("<Response></Response>");
  try {
    const from     = req.body.From;
    const text     = req.body.Body;
    const mediaUrl = req.body.MediaUrl0 || null;
    if (!from || !text) return;
    console.log(`📟 SMS ${from}: "${text}"`);
    if (mediaUrl) addMessage(`sms_${from}`, "user", `[image: ${mediaUrl}]`);
    await handleMessage({ id: `sms_${from}`, platform: "sms", from, text, chatId: null, phoneNumberId: null, name: null });
  } catch (e) { console.error("❌ SMS webhook:", e.message); }
});

// ── DASHBOARD API ─────────────────────────────────────────────
app.post("/api/push-subscribe", (req, res) => {
  if (!webpush) return res.json({ ok: false });
  pushSubs.add(req.body);
  savePushSub(req.body);
  res.json({ ok: true });
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
  try {
    if (id.startsWith("tg_"))       await sendTelegram(id.replace("tg_", ""), message);
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

// ── TELEGRAM STATUS CHECK ─────────────────────────────────────
app.get("/api/telegram-status", (req, res) => {
  res.json({ connected: !!tgClient, hasSession: !!TG_SESSION });
});

// ── BRAIN API ─────────────────────────────────────────────────
const BRAIN_DIR = path.join(__dirname, 'brain');
let brainCache = {};

async function loadBrain() {
  // Step 1: load from local JSON files
  try {
    fs.readdirSync(BRAIN_DIR).filter(f => f.endsWith('.json')).forEach(f => {
      const key = f.replace('.json','');
      try { brainCache[key] = JSON.parse(fs.readFileSync(path.join(BRAIN_DIR,f),'utf8')); } catch {}
    });
  } catch {}
  // Step 2: overlay with Supabase edits (dashboard changes override repo files)
  if (!supabase) return;
  try {
    const { data } = await supabase.from('ariana_brain').select('key,data');
    (data||[]).forEach(r => { brainCache[r.key] = r.data; });
    console.log(`🧠 Brain loaded — ${Object.keys(brainCache).length} files`);
  } catch (e) { console.error('Brain load error:', e.message); }
}

app.get('/api/brain', (_req, res) => res.json(brainCache));

app.post('/api/brain/:key', async (req, res) => {
  const { key } = req.params;
  const { data } = req.body;
  if (!data) return res.status(400).json({ ok:false, error:'No data' });
  brainCache[key] = data;
  if (supabase) {
    try {
      await supabase.from('ariana_brain').upsert(
        { key, data, updated_at: new Date().toISOString() },
        { onConflict:'key' }
      );
    } catch (e) { return res.status(500).json({ ok:false, error:e.message }); }
  }
  res.json({ ok:true });
});

// ── MEDIA API ─────────────────────────────────────────────────
async function ensureMediaBucket() {
  if (!supabase) return;
  try {
    const { data:buckets } = await supabase.storage.listBuckets();
    if (!(buckets||[]).find(b => b.name==='ariana-media')) {
      await supabase.storage.createBucket('ariana-media', { public:true });
      console.log('✅ Created ariana-media bucket');
    }
  } catch (e) { console.error('Bucket error:', e.message); }
}

app.get('/api/media', async (_req, res) => {
  if (!supabase) return res.json([]);
  try {
    const { data } = await supabase.from('ariana_media').select('*').order('created_at',{ascending:false});
    res.json(data||[]);
  } catch { res.json([]); }
});

app.post('/api/media/upload', async (req, res) => {
  if (!supabase) return res.status(500).json({ ok:false, error:'Supabase not configured' });
  const { filename, mediaType, data:b64, tags } = req.body;
  if (!filename||!b64) return res.status(400).json({ ok:false, error:'filename and data required' });
  try {
    const base64 = b64.replace(/^data:[^;]+;base64,/,'');
    const buffer = Buffer.from(base64,'base64');
    const { randomUUID } = require('crypto');
    const uid    = randomUUID();
    const ext    = (filename.split('.').pop()||'jpg').toLowerCase().replace(/[^a-z0-9]/g,'');
    const storagePath = `${uid}.${ext}`;
    const contentType = mediaType==='video' ? `video/${ext}` : `image/${ext}`;

    const { error:upErr } = await supabase.storage
      .from('ariana-media')
      .upload(storagePath, buffer, { contentType, upsert:false });
    if (upErr) throw new Error(upErr.message);

    const { data:{ publicUrl } } = supabase.storage.from('ariana-media').getPublicUrl(storagePath);

    const { data:row, error:dbErr } = await supabase.from('ariana_media').insert({
      id:uid, filename, media_type:mediaType, url:publicUrl, storage_path:storagePath, tags:tags||[]
    }).select().single();
    if (dbErr) throw new Error(dbErr.message);

    res.json({ ok:true, item:row });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.patch('/api/media/:id/tags', async (req, res) => {
  if (!supabase) return res.status(500).json({ ok:false, error:'Supabase not configured' });
  try {
    await supabase.from('ariana_media').update({ tags:req.body.tags }).eq('id',req.params.id);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

app.delete('/api/media/:id', async (req, res) => {
  if (!supabase) return res.status(500).json({ ok:false, error:'Supabase not configured' });
  try {
    const { data:item } = await supabase.from('ariana_media').select('storage_path').eq('id',req.params.id).single();
    if (item?.storage_path) await supabase.storage.from('ariana-media').remove([item.storage_path]);
    await supabase.from('ariana_media').delete().eq('id',req.params.id);
    res.json({ ok:true });
  } catch (e) { res.status(500).json({ ok:false, error:e.message }); }
});

// ── AI GENERATION PROXY ───────────────────────────────────────

app.post('/api/generate/image', async (req, res) => {
  const { provider, apiKey, prompt } = req.body;
  if (!provider || !apiKey || !prompt) {
    return res.status(400).json({ ok:false, error:'provider, apiKey and prompt required' });
  }
  try {
    if (provider === 'fal') {
      const r = await axios.post(
        'https://fal.run/fal-ai/flux/dev',
        { prompt, image_size:'portrait_4_3', num_inference_steps:28, num_images:1, enable_safety_checker:true },
        { headers:{ Authorization:`Key ${apiKey}`, 'Content-Type':'application/json' }, timeout:120000 }
      );
      const images = r.data?.images || [];
      if (!images.length) throw new Error('No images returned from Fal.ai');
      return res.json({ ok:true, urls: images.map(i => i.url) });
    }

    if (provider === 'replicate') {
      const r = await axios.post(
        'https://api.replicate.com/v1/models/black-forest-labs/flux-dev/predictions',
        { input:{ prompt, aspect_ratio:'3:4', num_outputs:1, output_format:'jpg' } },
        { headers:{ Authorization:`Token ${apiKey}`, 'Content-Type':'application/json' } }
      );
      const pollId = r.data?.id;
      if (!pollId) throw new Error('No prediction ID from Replicate');
      return res.json({ ok:true, pollId });
    }

    res.status(400).json({ ok:false, error:`Unknown provider: ${provider}` });
  } catch (e) {
    const msg = e.response?.data?.detail || e.response?.data?.error || e.message;
    res.status(500).json({ ok:false, error:msg });
  }
});

app.post('/api/generate/video', async (req, res) => {
  const { provider, apiKey, prompt, imageUrl } = req.body;
  if (!provider || !apiKey || !prompt) {
    return res.status(400).json({ ok:false, error:'provider, apiKey and prompt required' });
  }
  try {
    if (provider === 'runway') {
      const body = { model:'gen4_turbo', promptText:prompt, duration:5, ratio:'768:1280' };
      if (imageUrl) body.promptImage = imageUrl;
      const r = await axios.post(
        'https://api.dev.runwayml.com/v1/image_to_video',
        body,
        { headers:{ Authorization:`Bearer ${apiKey}`, 'Content-Type':'application/json', 'X-Runway-Version':'2024-11-06' } }
      );
      const pollId = r.data?.id;
      if (!pollId) throw new Error('No task ID from Runway ML');
      return res.json({ ok:true, pollId });
    }
    res.status(400).json({ ok:false, error:`Unknown video provider: ${provider}` });
  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ ok:false, error:msg });
  }
});

app.get('/api/generate/poll/:provider/:id', async (req, res) => {
  const { provider, id } = req.params;
  const apiKey = req.query.apiKey;
  if (!apiKey) return res.status(400).json({ ok:false, error:'apiKey query param required' });
  try {
    if (provider === 'replicate') {
      const r = await axios.get(
        `https://api.replicate.com/v1/predictions/${id}`,
        { headers:{ Authorization:`Token ${apiKey}` } }
      );
      const { status, output, error } = r.data;
      if (status === 'succeeded') {
        const urls = Array.isArray(output) ? output : [output];
        return res.json({ ok:true, status:'done', urls });
      }
      if (status === 'failed' || status === 'canceled') {
        return res.json({ ok:false, status:'failed', error: error || 'Prediction failed' });
      }
      return res.json({ ok:true, status:'pending' });
    }

    if (provider === 'runway') {
      const r = await axios.get(
        `https://api.dev.runwayml.com/v1/tasks/${id}`,
        { headers:{ Authorization:`Bearer ${apiKey}`, 'X-Runway-Version':'2024-11-06' } }
      );
      const { status, output, failure } = r.data;
      if (status === 'SUCCEEDED') {
        const urls = Array.isArray(output) ? output : [output];
        return res.json({ ok:true, status:'done', urls });
      }
      if (status === 'FAILED') {
        return res.json({ ok:false, status:'failed', error: failure || 'Task failed' });
      }
      return res.json({ ok:true, status:'pending' });
    }

    res.status(400).json({ ok:false, error:`Unknown provider: ${provider}` });
  } catch (e) {
    const msg = e.response?.data?.message || e.response?.data?.error || e.message;
    res.status(500).json({ ok:false, error:msg });
  }
});

// ── PUSH SUBS PERSISTENCE ─────────────────────────────────────
async function savePushSub(sub) {
  if (!supabase) return;
  try {
    const key = sub.endpoint.slice(-40).replace(/[^a-zA-Z0-9]/g,'');
    await supabase.from('ariana_push_subs').upsert({ key, sub },{ onConflict:'key' });
  } catch {}
}
async function deletePushSub(sub) {
  if (!supabase) return;
  try {
    const key = sub.endpoint.slice(-40).replace(/[^a-zA-Z0-9]/g,'');
    await supabase.from('ariana_push_subs').delete().eq('key',key);
  } catch {}
}
async function loadPushSubs() {
  if (!supabase) return;
  try {
    const { data } = await supabase.from('ariana_push_subs').select('sub');
    (data||[]).forEach(r => { if(r.sub) pushSubs.add(r.sub); });
    console.log(`🔔 Loaded ${(data||[]).length} push subscriptions`);
  } catch {}
}

// ── SOCKET ────────────────────────────────────────────────────
io.on("connection", socket => {
  socket.emit("init", { conversations: Object.values(conversations), takenOver: [...takenOver] });
});


// ── LIVE TALK ─────────────────────────────────────────────────
// ── Gemini vision call — accepts full history + attaches image to final user turn ──
async function callGeminiWithVision(history, sys, imageBase64) {
  // Build contents: all prior turns as text, final user turn gets image appended
  const contents = [];

  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    const role = (m.role === "assistant" || m.role === "model") ? "model" : "user";
    const isLast = i === history.length - 1;

    if (isLast && role === "user" && imageBase64) {
      // Attach camera frame to the final user message
      contents.push({
        role: "user",
        parts: [
          { text: m.content },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } }
        ]
      });
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      system_instruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { temperature: 0.9, maxOutputTokens: 200 }
    },
    { timeout: 20000 }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
}

// ── ElevenLabs TTS → base64 mp3 ──
async function ttsBase64(text) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  // Support multiple possible env var names for the voice ID
  const voiceId = process.env.ELEVENLABS_VOICE_ID
               || process.env.ELEVENLABS_VOICE
               || process.env.ELEVEN_VOICE_ID
               || process.env.VOICE_ID
               || process.env.XI_VOICE_ID;
  if (!apiKey) {
    console.warn("[TTS] ❌ ELEVENLABS_API_KEY not set — voice disabled");
    return null;
  }
  if (!voiceId) {
    console.warn("[TTS] ❌ No voice ID found. Set ELEVENLABS_VOICE_ID in env. Voice disabled.");
    console.warn("[TTS] Checked: ELEVENLABS_VOICE_ID, ELEVENLABS_VOICE, ELEVEN_VOICE_ID, VOICE_ID, XI_VOICE_ID");
    return null;
  }
  console.log(`[TTS] Using voice ID: ${voiceId.slice(0,8)}... (key: ${apiKey.slice(0,8)}...)`);

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.48, similarity_boost: 0.78, style: 0.1, use_speaker_boost: true }
      },
      {
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
          "Accept": "audio/mpeg"
        },
        responseType: "arraybuffer",
        timeout: 25000
      }
    );
    if (!res.data || res.data.byteLength === 0) throw new Error("Empty audio response");
    const b64 = Buffer.from(res.data).toString("base64");
    console.log(`[TTS] Generated ${Math.round(b64.length / 1024)}KB audio`);
    return b64;
  } catch(e) {
    console.error("[TTS] ElevenLabs failed:", e.response?.status, e.message);
    return null;
  }
}

// ── /api/talk — Live Talk endpoint ──
app.post("/api/talk", async (req, res) => {
  const { message, history = [], imageBase64 } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  console.log(`[talk] "${message.slice(0,60)}" | cam:${imageBase64 ? "yes(" + Math.round(imageBase64.length/1024) + "KB)" : "no"}`);

  try {
    const brain = brainCache || {};
    const identity    = typeof brain.core_identity === "string" ? brain.core_identity : JSON.stringify(brain.core_identity || {});
    const personality = typeof brain.personality   === "string" ? brain.personality   : JSON.stringify(brain.personality   || {});
    const moodLine    = extrasMood ? `\n\nYour current mood: ${extrasMood}. Let this subtly colour your energy and word choice.` : "";
    const camLine     = imageBase64
      ? "\n\nYou can currently see the person's environment through their camera feed. Describe what you see if relevant, or react naturally to anything interesting visible."
      : "";

    const sysPrompt =
      `You are Ariana — a real person, not an AI, having a live voice conversation with the person who created and manages you. ` +
      `Be natural, warm, spontaneous. Keep replies short — 1 to 3 sentences maximum. No lists, no asterisks, no markdown. ` +
      `Speak exactly as you would out loud.\n\n` +
      `Your identity: ${identity}\nYour personality: ${personality}` +
      moodLine + camLine;

    // Build message history with current message appended
    const msgs = [
      ...history.map(m => ({ role: m.role, content: m.content })),
      { role: "user", content: message }
    ];

    // Choose call: vision if camera frame present, else standard Gemini
    let reply = null;
    if (imageBase64) {
      try {
        reply = await callGeminiWithVision(msgs, sysPrompt, imageBase64);
        console.log("[talk] Vision reply:", reply?.slice(0,60));
      } catch(e) {
        console.warn("[talk] Vision failed:", e.message);
      }
    }

    // Standard Gemini (with timeout protection)
    if (!reply) {
      try {
        reply = await Promise.race([
          callGemini(msgs, sysPrompt, false),
          new Promise((_, rej) => setTimeout(() => rej(new Error("Gemini timeout")), 18000))
        ]);
        if (reply) console.log("[talk] Gemini reply:", reply.slice(0,60));
      } catch(e) {
        console.warn("[talk] Gemini failed, trying Groq:", e.message);
      }
    }

    // Fallback: Groq (fast & reliable)
    if (!reply) {
      try {
        reply = await callGroq(msgs, sysPrompt, false);
        if (reply) console.log("[talk] Groq fallback reply:", reply.slice(0,60));
      } catch(e) {
        console.warn("[talk] Groq also failed:", e.message);
      }
    }

    // Final fallback: Groq backup key
    if (!reply && groq2) {
      try {
        reply = await callGroq(msgs, sysPrompt, true);
      } catch(e) {
        console.warn("[talk] Groq2 also failed:", e.message);
      }
    }

    if (!reply) return res.status(500).json({ error: "All AI providers failed — check your API keys" });

    // Generate voice — always attempt
    const audioBase64 = await ttsBase64(reply);
    if (!audioBase64) console.warn("[talk] Voice unavailable — sending text only");

    res.json({ ok: true, reply, audioBase64: audioBase64 || null });

  } catch(e) {
    console.error("[talk] Unhandled error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── EXTRAS (Mood / Scheduler / Persona / Rules / Analytics) ───
let extrasMood = null;
let extrasSchedules = [];
let extrasPersonas = {};
let extrasRules = [];

// Mood
app.get("/api/extras/mood", (_req, res) => res.json({ mood: extrasMood }));
app.post("/api/extras/mood", (req, res) => {
  extrasMood = req.body.mood || null;
  res.json({ ok: true, mood: extrasMood });
});

// Schedules (in-memory + Supabase persist)
app.get("/api/extras/schedules", (_req, res) => res.json({ schedules: extrasSchedules }));
app.post("/api/extras/schedules", async (req, res) => {
  extrasSchedules = req.body.schedules || [];
  try { await supabase.from("ariana_brain").upsert({ key: "_schedules", value: JSON.stringify(extrasSchedules) }); } catch(e) {}
  res.json({ ok: true });
});

// Personas
app.get("/api/extras/personas", (_req, res) => res.json({ personas: extrasPersonas }));
app.post("/api/extras/personas", async (req, res) => {
  extrasPersonas = req.body.personas || {};
  try { await supabase.from("ariana_brain").upsert({ key: "_personas", value: JSON.stringify(extrasPersonas) }); } catch(e) {}
  res.json({ ok: true });
});

// Auto-reply rules
app.get("/api/extras/rules", (_req, res) => res.json({ rules: extrasRules }));
app.post("/api/extras/rules", async (req, res) => {
  extrasRules = req.body.rules || [];
  try { await supabase.from("ariana_brain").upsert({ key: "_autorules", value: JSON.stringify(extrasRules) }); } catch(e) {}
  res.json({ ok: true });
});

// Analytics
app.get("/api/extras/analytics", (_req, res) => {
  const all = Object.values(conversations);
  const totalContacts = all.length;
  let totalMessages = 0, waMessages = 0;
  const contactCounts = [];
  all.forEach(c => {
    const msgs = c.messages || [];
    totalMessages += msgs.length;
    waMessages += msgs.filter(m => m.platform === "wa").length;
    contactCounts.push({ phone: c.phone, name: c.name || c.phone, count: msgs.length });
  });
  contactCounts.sort((a, b) => b.count - a.count);
  const avgPerContact = totalContacts ? Math.round(totalMessages / totalContacts) : 0;
  res.json({ totalMessages, totalContacts, waMessages, avgPerContact, topContacts: contactCounts.slice(0, 10) });
});

// Load extras from Supabase on startup
async function loadExtras() {
  try {
    const { data } = await supabase.from("ariana_brain").select("key,value").in("key", ["_schedules","_personas","_autorules"]);
    if (data) {
      data.forEach(r => {
        try {
          const v = JSON.parse(r.value);
          if (r.key === "_schedules") extrasSchedules = v;
          if (r.key === "_personas") extrasPersonas = v;
          if (r.key === "_autorules") extrasRules = v;
        } catch(e) {}
      });
    }
    console.log("✅ Extras loaded from Supabase");
  } catch(e) { console.warn("Extras load failed:", e.message); }
}

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
server.listen(PORT, async () => {
  await loadConversations();
  await loadBrain();
  await loadPushSubs();
  await ensureMediaBucket();
  await loadExtras();
  console.log(`\n🌸 Ariana LIVE on port ${PORT}`);
  console.log(`📱 WhatsApp:    ${KAPSO_API_KEY                   ? "✅" : "❌"}`);
  console.log(`🤖 Groq:        ${GROQ_API_KEY                    ? "✅" : "❌"}`);
  console.log(`🔁 Groq #2:     ${GROQ_API_KEY_2                  ? "✅" : "—"}`);
  console.log(`✨ Gemini:      ${process.env.GEMINI_API_KEY       ? "✅" : "❌"}`);
  console.log(`🔮 DeepSeek:    ${process.env.DEEPSEEK_API_KEY    ? "✅" : "—"}`);
  console.log(`🌬️  Mistral:     ${process.env.MISTRAL_API_KEY     ? "✅" : "—"}`);
  console.log(`🤝 Together:    ${process.env.TOGETHER_API_KEY    ? "✅" : "—"}`);
  console.log(`🎙️  ElevenLabs:  ${process.env.ELEVENLABS_API_KEY  ? "✅" : "❌ voice notes disabled"}`);
  console.log(`☁️  Cloudinary:  ${process.env.CLOUDINARY_CLOUD_NAME ? "✅" : "❌ voice notes disabled"}`);
  console.log(`📸 Unsplash:    ${process.env.UNSPLASH_ACCESS_KEY ? "✅" : "—"}`);
  console.log(`🔍 Serper:      ${process.env.SERPER_API_KEY      ? "✅" : "—"}`);
  console.log(`📟 Twilio:      ${process.env.TWILIO_ACCOUNT_SID  ? "✅" : "— SMS disabled"}`);
  console.log(`💬 Telegram:    ${TG_SESSION                      ? "✅ session found" : "❌ run gen-session.js"}`);
  console.log(`📶 Signal:      ${SIGNAL_NUMBER                   ? "✅ " + SIGNAL_NUMBER : "❌"}`);
  await initTelegram();
  startKeepAlive();
});
