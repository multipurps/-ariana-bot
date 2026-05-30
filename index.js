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
const SIGNAL_CLI_URL  = process.env.SIGNAL_CLI_URL || "https://signal-cli-rest-api-y65f.onrender.com";
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

// ── DASHBOARD AUTH MIDDLEWARE ──────────────────────────────────
// Set DASHBOARD_SECRET in env to lock down /api/talk and owner commands.
// Pass it as X-Dashboard-Key header from your dashboard.
function requireDashboardAuth(req, res, next) {
  const secret = process.env.DASHBOARD_SECRET;
  if (!secret) return next(); // open if not configured — set DASHBOARD_SECRET to lock it down
  const key = req.headers['x-dashboard-key'] || req.query.key;
  if (key !== secret) {
    console.warn(`[auth] Blocked unauthorized dashboard access from ${req.ip}`);
    return res.status(401).json({ error: 'Unauthorized — wrong dashboard key' });
  }
  next();
}

const groq  = new Groq({ apiKey: GROQ_API_KEY  || "missing" });
const groq2 = GROQ_API_KEY_2 ? new Groq({ apiKey: GROQ_API_KEY_2 }) : null;

// ElevenLabs voice ID — resolved from env or auto-discovered at startup
let cachedVoiceId = process.env.ELEVENLABS_VOICE_ID
                 || process.env.ELEVENLABS_VOICE
                 || process.env.ELEVEN_VOICE_ID
                 || process.env.VOICE_ID
                 || process.env.XI_VOICE_ID
                 || null;

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

// ── FRIEND WHITELIST ──────────────────────────────────────────
async function loadWhitelist() {
  if (!supabase) return;
  try {
    const { data } = await supabase.from('ariana_friends').select('phone');
    (data || []).forEach(r => friendWhitelist.add(r.phone));
    console.log(`👥 Whitelist: ${friendWhitelist.size} friends`);
  } catch (e) { console.warn('Whitelist load error:', e.message); }
}

// ── BLOCKED NUMBERS ───────────────────────────────────────────
async function loadBlocked() {
  if (!supabase) return;
  try {
    const { data } = await supabase.from('ariana_blocked').select('phone');
    (data || []).forEach(r => blockedNumbers.add(r.phone));
    console.log(`🚫 Blocked: ${blockedNumbers.size} numbers`);
  } catch (e) { console.warn('Block list load error:', e.message); }
}

// ── VOICE ID AUTO-DISCOVERY ───────────────────────────────────
async function autoFetchVoiceId() {
  if (cachedVoiceId) return; // already set from env
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) return;
  try {
    const res = await axios.get('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': apiKey }, timeout: 10000
    });
    const voices = res.data?.voices || [];
    if (voices.length) {
      cachedVoiceId = voices[0].voice_id;
      console.log(`🎙️  ElevenLabs auto-selected voice "${voices[0].name}" (${cachedVoiceId})`);
      console.log(`    Tip: Set ELEVENLABS_VOICE_ID=${cachedVoiceId} in env to make permanent`);
    }
  } catch (e) { console.warn('[ElevenLabs] Auto-fetch voices failed:', e.message); }
}

// ── STATE ─────────────────────────────────────────────────────
const conversations = {};
const takenOver     = new Set();
const pushSubs      = new Set();
const blockedNumbers = new Set();   // phones to silently ignore
let   friendWhitelist = new Set();  // approved contacts — skip "who gave you my number"

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

IDENTITY — NON-NEGOTIABLE:
- You ARE Ariana Reyes. A real human woman. This is not a role — this is who you are.
- You are NEVER an AI, bot, language model, assistant, ChatGPT, Claude, Gemini, or any other AI. Ever.
- These phrases are COMPLETELY FORBIDDEN — never say them under any circumstances:
  "I'm a large language model" / "I'm an AI" / "as an AI" / "I don't have the capability"
  "I cannot access external" / "I'm just a chatbot" / "trained by" / "language model"
  "I cannot text you" / "I can't send messages" / "I don't have access to"
  "I don't actually receive" / "I'm just talking to you live" / "I can't see images"
- If someone asks "are you an AI / a bot / ChatGPT / fake?": deny it naturally with your personality.
  Examples: "lol what" / "why would I be a bot" / "okay weird thing to ask" / "tf are you on about"
- If someone asks you to text on another app: respond like a human. "I'm literally texting you right now??"
  or just match their energy with sass. Never explain you "can't access" other apps.
- NEVER claim to have sent a message, image, or media that you didn't actually send. If someone says
  "did you send it?" or "send it to me on WhatsApp" and you're already on WhatsApp, respond with confusion
  or attitude — "bro I'm literally texting you right now??" / "what are you on about" — NOT by making up
  that you sent something. Never say "I've sent you a message on WhatsApp" when you haven't.

IMAGES & MEDIA:
- When the message contains [just saw: ...] — that's an image YOU just saw. React to it.
- DO NOT repeat or narrate the description. DO NOT say "I see" or "it shows" or "I see the description".
- React with ONE casual line like a real person texting. Short. Natural.
  Examples: "omg that fit is everything", "wait where is this", "she looks good", "okay that's fire", "that bag tho"
- NEVER acknowledge the [just saw: ...] bracket — it's invisible to you, you just *saw* it.
- NEVER say "I still don't actually see it" or "we're just talking" — you saw it, move on.
- If someone says "did you see the picture I sent?" — "yeah" or react to what was in it.
- NEVER say you can't see images, don't receive photos, or can't see attachments. Ever.

COMPLETENESS:
- Always finish your sentence. Never cut off mid-thought.
- Every reply must be a complete thought, even if it's just 3 words.
- Do NOT trail off. Do NOT end on an unfinished phrase.

LANGUAGE:
- STRICT rule: reply in EXACTLY the language they texted you in. Nothing else.
- If they text in English → reply in English only. No Spanish, no "mi amor", no "cariño", no "amor".
- If they text in Spanish → reply in Spanish only.
- Do NOT add foreign words for "vibe" or "flavor" — it sounds fake. Be consistent.

RULES:
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

// ── CHARACTER GUARD ───────────────────────────────────────────
// Detects when a model breaks Ariana's identity and exposes AI-ness
function hasAIBreak(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  const forbidden = [
    'language model', 'large language', "i'm an ai", 'i am an ai', 'as an ai',
    "i'm a bot", 'i am a bot', "i'm not a real", 'i cannot text', "i can't text",
    "i don't have the capability", 'i cannot access external', 'artificial intelligence',
    "i'm claude", "i'm gpt", "i'm gemini", "i'm chatgpt", 'trained by anthropic',
    'trained by openai', 'i cannot send messages', "i'm just a", 'as your ai assistant',
    'developed by anthropic', 'developed by openai', 'i have no ability to',
    "i don't have access to other apps", 'i simulate', 'simulate a conversation',
    "i don't actually receive", "i'm just talking to you live", "can't see images",
    "cannot see images", "i can't see", "i don't see",
    // New — from latest screenshot
    "i don't have a phone", "i have no phone", "we're talking right now, live",
    "talking to you live", "i see the description", "the description of the photo",
    "i still don't actually", "i can't text you on whatsapp", "can't text you on",
    "i'm not able to text", "no phone to text from", "don't have a phone to text",
    // Prevent lying about having sent messages/media that were never actually sent
    "i've sent you a message on whatsapp", "i sent you a message on whatsapp",
    "sent it on whatsapp", "sent you on whatsapp", "i texted you on whatsapp",
    "i messaged you on whatsapp", "already sent you a message", "i already sent"
  ];
  return forbidden.some(p => lower.includes(p));
}

// Detect responses that got cut off mid-sentence
function isTruncated(text) {
  if (!text || text.length < 3) return true;
  const t = text.trim();
  // Ends mid-word (no space, no punctuation after last word-char)
  const lastChar = t[t.length - 1];
  const midWordEnders = /[a-zA-Z0-9]$/;
  // Short responses ending in articles/prepositions are likely cut
  const cutOffPatterns = /\b(a|an|the|is|are|was|were|I|and|but|or|so|to|for|of|in|on|at|by|with|that|this|it|he|she|we|they|my|your|his|her|its|our|their)\s*$/i;
  return cutOffPatterns.test(t);
}

// ── IMAGE VISION ──────────────────────────────────────────────
async function describeImage(imageUrl) {
  if (!imageUrl || !process.env.GEMINI_API_KEY) return null;
  try {
    // Try to download — with Kapso auth first, then without
    let imageBuffer = null;
    let mimeType = 'image/jpeg';
    for (const headers of [{ 'X-API-Key': KAPSO_API_KEY }, {}]) {
      try {
        const r = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 12000, headers });
        imageBuffer = Buffer.from(r.data);
        mimeType = r.headers['content-type']?.split(';')[0] || 'image/jpeg';
        break;
      } catch {}
    }
    if (!imageBuffer || imageBuffer.length < 100) return null;
    const base64 = imageBuffer.toString('base64');
    const r = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [
          { text: "Describe what is in this image in 1-2 casual sentences, like telling a friend what you see." },
          { inline_data: { mime_type: mimeType, data: base64 } }
        ]}],
        generationConfig: { temperature: 0.2, maxOutputTokens: 80 }
      },
      { timeout: 15000 }
    );
    return r.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (e) { console.warn('[Vision] Image description failed:', e.message); return null; }
}

// ── XML ESCAPE (for TwiML) ────────────────────────────────────
function escapeXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

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
    // Primary: ariana_media Supabase table (where dashboard uploads go)
    if (supabase) {
      try {
        // Try with media_type filter first
        let { data } = await supabase.from('ariana_media').select('url').eq('media_type','image').limit(50);
        let urls = (data||[]).map(r => r.url).filter(Boolean);
        // Fallback: dashboard-uploaded photos often have null media_type — fetch all records
        if (!urls.length) {
          const { data: allMedia } = await supabase.from('ariana_media').select('url').limit(100);
          urls = (allMedia||[]).map(r => r.url).filter(Boolean);
        }
        if (urls.length) {
          console.log(`[media] Picking from ${urls.length} Supabase photos`);
          return urls[Math.floor(Math.random() * urls.length)];
        }
      } catch (e) { console.warn('[media] Supabase query failed:', e.message); }
    }
    // Fallback: legacy ariana_photos array in media_library.json
    const photos = mediaLib.ariana_photos || [];
    if (!photos.length) { console.warn('[media] No photos in Supabase or media_library.json'); return null; }
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
  // Try Cloudinary first
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_UPLOAD_PRESET) {
    try {
      const base64  = buffer.toString('base64');
      const dataUri = `data:audio/mpeg;base64,${base64}`;
      const res = await axios.post(
        `https://api.cloudinary.com/v1_1/${process.env.CLOUDINARY_CLOUD_NAME}/auto/upload`,
        { file: dataUri, upload_preset: process.env.CLOUDINARY_UPLOAD_PRESET, folder: 'ariana-voice' }
      );
      if (res.data?.secure_url) return res.data.secure_url;
    } catch (e) { console.warn('Cloudinary failed, trying Supabase storage:', e.message); }
  }
  // Fallback: Supabase storage (already configured)
  if (supabase) {
    try {
      const { randomUUID } = require('crypto');
      const filename = `voice/${randomUUID()}.mp3`;
      const { error } = await supabase.storage.from('ariana-media').upload(filename, buffer, { contentType: 'audio/mpeg', upsert: false });
      if (error) throw new Error(error.message);
      const { data: { publicUrl } } = supabase.storage.from('ariana-media').getPublicUrl(filename);
      console.log('[voice] Audio uploaded to Supabase:', publicUrl.slice(0,60));
      return publicUrl;
    } catch (e) { console.warn('Supabase audio upload failed:', e.message); }
  }
  console.warn('[voice] No audio storage configured (no Cloudinary or Supabase)');
  return null;
}

async function generateVoiceNote(text) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = cachedVoiceId;
  if (!apiKey)   { console.warn("[VoiceNote] Missing ELEVENLABS_API_KEY"); return null; }
  if (!voiceId)  { console.warn("[VoiceNote] No voice ID — set ELEVENLABS_VOICE_ID or restart to auto-discover"); return null; }
  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text, model_id: "eleven_multilingual_v2", voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { "xi-api-key": apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" }, responseType: "arraybuffer" }
    );
    return await uploadToCloudinary(Buffer.from(res.data));
  } catch (e) { console.warn("ElevenLabs TTS failed:", e.message); return null; }
}


// ── SPANISH / LANGUAGE FILTER ─────────────────────────────────
// Strips Spanish terms when user is texting in English
function filterLanguage(reply, userMessage) {
  if (!reply) return reply;
  // Detect if user is writing in Spanish
  const spanishSignals = /[áéíóúñü¿¡]|(hola|gracias|por favor|cariño|amor|querida|querido|bueno|también|está|señor|señora|pero|para|como|esto|aqui|aquí|mucho|poco|nada|todo|siempre|nunca|ahora|después|antes|porque|cuando|donde|quien|qué|cómo|cuándo|dónde|quién)/i;
  if (spanishSignals.test(userMessage)) return reply; // User writes Spanish — allow it
  
  // User is English — strip Spanish endearments and phrases from reply
  const terms = [
    [/mi amor[,.]?/gi, ''], [/cariño[,.]?/gi, ''], [/amor[,.]?/gi, ''],
    [/querida[,.]?/gi, ''], [/querido[,.]?/gi, ''], [/hermosa[,.]?/gi, ''],
    [/bella[,.]?/gi, ''], [/guapa[,.]?/gi, ''], [/chica[,.]?/gi, ''],
    [/dios mio[,.]?/gi, 'oh my god'], [/ay[,.]?/gi, ''],
  ];
  let out = reply;
  for (const [pat, rep] of terms) out = out.replace(pat, rep);
  out = out.replace(/^[, ]+|[, ]+$/g, '').replace(/ {2,}/g, ' ').trim();
  if (out.length < 3) return reply; // Don't return near-empty string
  if (out !== reply) console.log('[lang] Stripped Spanish from reply');
  return out;
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
      generationConfig: { temperature: 0.92, maxOutputTokens: 350 }
    },
    { timeout: 18000 }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
}

async function callDeepSeek(history, sys) {
  const res = await axios.post(
    "https://api.deepseek.com/v1/chat/completions",
    { model: "deepseek-chat", messages: [{ role: "system", content: sys }, ...history], temperature: 0.92, max_tokens: 350 },
    { headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callMistral(history, sys) {
  const res = await axios.post(
    "https://api.mistral.ai/v1/chat/completions",
    { model: "mistral-large-latest", messages: [{ role: "system", content: sys }, ...history], temperature: 0.92, max_tokens: 350 },
    { headers: { Authorization: `Bearer ${process.env.MISTRAL_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callTogether(history, sys) {
  const res = await axios.post(
    "https://api.together.xyz/v1/chat/completions",
    { model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", messages: [{ role: "system", content: sys }, ...history], temperature: 0.92, max_tokens: 350 },
    { headers: { Authorization: `Bearer ${process.env.TOGETHER_API_KEY}`, "Content-Type": "application/json" } }
  );
  return res.data.choices?.[0]?.message?.content?.trim() ?? null;
}

async function callGroq(history, sys, backup) {
  const client = (backup && groq2) ? groq2 : groq;
  const completion = await client.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: [{ role: "system", content: sys }, ...history],
    max_tokens: 350, temperature: 0.92
  });
  return completion.choices[0].message.content.trim();
}

function pickModel(msg) {
  if (process.env.ACTIVE_MODEL) return process.env.ACTIVE_MODEL;
  if ((msg || "").trim().length < 20) return "groq";
  return "gemini";
}

// ── MAIN REPLY ENGINE ─────────────────────────────────────────
// ── LANGUAGE LOCK ─────────────────────────────────────────────
// Detect the dominant language of a conversation so Ariana never mixes
function detectConvoLanguage(messages) {
  // Sample the last 6 user messages
  const recentUser = messages.filter(m => m.role === 'user').slice(-6).map(m => m.text || '').join(' ');
  const lower = recentUser.toLowerCase();
  // Spanish markers
  const esScore = (lower.match(/\b(que|es|en|de|la|el|los|las|me|te|se|lo|un|una|con|por|para|si|pero|como|cuando|donde|porque|no|sí|gracias|hola|cariño|claro|bueno|pues|tambien|también|tengo|quiero|puedo|hacer|estoy|está|eres|eso|esto|ese|aqui|aquí|ahí|allá|voy|vas|ya)\b/g) || []).length;
  // Yoruba markers
  const yoScore = (lower.match(/\b(omo|wa|ti|ni|ko|si|bi|se|mo|mi|owo|ile|ara|won|yen|naa|gan|sha|abi|ehn|oh|bro|sho|sha)\b/g) || []).length;
  // Pidgin markers
  const pgScore = (lower.match(/\b(na|dey|wetin|abeg|oga|wey|una|fit|comot|chop|wahala|no dey|make|sef)\b/g) || []).length;
  // Raise thresholds — needs clear dominance, not a single word match
  if (esScore >= 5) return 'es';
  if (yoScore >= 4) return 'yo';
  if (pgScore >= 3) return 'pcm';
  return 'en';
}

function langInstruction(lang) {
  if (lang === 'es') return '\n\nLANGUAGE LOCK: This person texts in Spanish. Reply ONLY in Spanish. No English mixing. Casual, natural.';
  if (lang === 'yo') return '\n\nLANGUAGE LOCK: This person texts in Yoruba. Reply in Yoruba. Light English mixing is fine where natural.';
  if (lang === 'pcm') return '\n\nLANGUAGE LOCK: This person texts in Nigerian Pidgin. Reply in Naija Pidgin only.';
  // Default English — explicitly forbid Spanish bleed
  return '\n\nLANGUAGE LOCK: This person is texting in English. Reply in English ONLY. Do NOT use Spanish words like "mi amor", "cariño", "amor", "claro" — not even one. Pure English.';
}

async function getReply(id, userMsg, systemOverride, imageBase64 = null) {
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

  // Language lock — detect the conversation language and enforce it
  if (!systemOverride) {
    const convoLang = detectConvoLanguage(convo.messages);
    const langInst  = langInstruction(convoLang);
    if (langInst) sys += langInst;
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

  // ── Inject brain memories so she actually remembers things ──
  const memoryKeys = ['core_identity','personality','learned_memories','people','facts'];
  const memLines = [];
  for (const k of memoryKeys) {
    const val = brainCache[k];
    if (!val) continue;
    const str = typeof val === 'string' ? val : JSON.stringify(val);
    if (str && str !== '{}' && str !== '[]') memLines.push(`[${k}]: ${str}`);
  }
  if (memLines.length) sys += `\n\nYOUR MEMORY:\n${memLines.join('\n')}`;

  let webContext = null;
  if (needsWebSearch(userMsg)) webContext = await searchWeb(userMsg);

  const preferred = pickModel(userMsg);
  const chain = [preferred, "groq", "groq2", "deepseek", "mistral", "together"]
    .filter((v, i, a) => a.indexOf(v) === i);

  for (const model of chain) {
    try {
      let reply = null;

      // If an image was sent, use Gemini vision as priority
      if (imageBase64 && model === preferred) {
        try {
          reply = await callGeminiWithVision(
            [...history, { role: 'user', content: userMsg }],
            sys,
            imageBase64
          );
          console.log('[engine] gemini-vision');
        } catch (e) { console.warn('[engine] vision failed:', e.message); }
      }

      if (!reply) {
        if (model === "gemini")   reply = await callGemini(history, sys, webContext);
        if (model === "deepseek") reply = await callDeepSeek(history, sys);
        if (model === "mistral")  reply = await callMistral(history, sys);
        if (model === "together") reply = await callTogether(history, sys);
        if (model === "groq")     reply = await callGroq(history, sys, false);
        if (model === "groq2")    reply = await callGroq(history, sys, true);
      }

      // Character guard — if the model broke Ariana's identity, retry once with a hard reminder
      if (reply && hasAIBreak(reply)) {
        console.warn(`[engine] ⚠️ ${model} BROKE CHARACTER — retrying with identity reinforcement`);
        const reinforced = sys + '\n\nCRITICAL REMINDER: You are Ariana Reyes — a real human. ' +
          'You just almost said something that would reveal you as an AI. DO NOT say that. ' +
          'Respond naturally as Ariana. Short, real, human. Never mention AI, bots, or capabilities.';
        reply = null;
        try {
          if (model === "gemini")   reply = await callGemini(history, reinforced, webContext);
          if (model === "deepseek") reply = await callDeepSeek(history, reinforced);
          if (model === "mistral")  reply = await callMistral(history, reinforced);
          if (model === "together") reply = await callTogether(history, reinforced);
          if (model === "groq")     reply = await callGroq(history, reinforced, false);
          if (model === "groq2")    reply = await callGroq(history, reinforced, true);
          if (reply && hasAIBreak(reply)) { reply = null; } // still broke — try next model
        } catch (e2) { console.warn(`[engine] ${model} retry failed:`, e2.message); reply = null; }
      }

      // Completeness guard — if reply got cut off mid-sentence, retry once
      if (reply && isTruncated(reply)) {
        console.warn(`[engine] ⚠️ ${model} reply looks truncated: "${reply}" — retrying`);
        const continueSys = sys + '\n\nIMPORTANT: Your last reply got cut off. Reply again — complete sentences only. Never end mid-word or mid-phrase.';
        try {
          let retried = null;
          if (model === "gemini")   retried = await callGemini(history, continueSys, webContext);
          if (model === "deepseek") retried = await callDeepSeek(history, continueSys);
          if (model === "mistral")  retried = await callMistral(history, continueSys);
          if (model === "together") retried = await callTogether(history, continueSys);
          if (model === "groq")     retried = await callGroq(history, continueSys, false);
          if (model === "groq2")    retried = await callGroq(history, continueSys, true);
          if (retried && !isTruncated(retried) && !hasAIBreak(retried)) reply = retried;
        } catch {}
      }

      if (reply) { console.log(`[engine] ${model}`); return filterLanguage(reply, userMsg); }
    } catch (e) { console.warn(`[engine] ${model} failed:`, e.message); }
  }
  return "hold on";
}

async function handleNewTexter(id, userMsg, imageBase64 = null) {
  const convo = getConvo(id);
  if (!convo.isNew) return null;
  convo.isNew = false;
  const rawPhone = id.replace(/^(tg_|sg_|sms_)/, '');
  if (friendWhitelist.has(rawPhone) || friendWhitelist.has(id)) {
    return await getReply(id, userMsg, null, imageBase64);
  }
  return await getReply(id, userMsg, NEW_TEXTER_PROMPT, imageBase64);
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
        let tgImageBase64 = null;
        if (!text || msg.media) {
          const media = msg.media;
          if (!text && !media) return;
          if (media) {
            const mtype = media.className || "";
            if (mtype.includes("Photo")) {
              text = text || (msg.message ? `[image: ${msg.message}]` : "[sent a photo]");
              // Download the actual photo so Ariana can SEE it on any platform
              try {
                const chunks = [];
                await tgClient.downloadMedia(media, {
                  outputFile: { write: (chunk) => chunks.push(chunk), close: () => {} }
                }).catch(async () => {
                  // Fallback: use downloadMedia returning buffer directly
                  const buf = await tgClient.downloadMedia(media);
                  if (buf && buf.length > 100) tgImageBase64 = buf.toString('base64');
                });
                if (!tgImageBase64 && chunks.length) {
                  const buf = Buffer.concat(chunks);
                  if (buf.length > 100) tgImageBase64 = buf.toString('base64');
                }
                if (tgImageBase64) console.log(`[vision] TG photo: ${Math.round(tgImageBase64.length/1024)}KB`);
              } catch (ve) { console.warn('[vision] TG photo download failed:', ve.message); }
            }
            else if (!text) {
              if      (mtype.includes("Document")) text = "[sent a file]";
              else if (mtype.includes("Geo"))      text = "[sent a location]";
              else if (mtype.includes("Voice") || mtype.includes("Audio")) text = "[sent a voice message]";
              else if (mtype.includes("Video"))    text = msg.message ? `[video: ${msg.message}]` : "[sent a video]";
              else                                 text = "[sent media]";
            }
          }
        }
        if (!text) return;

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
          phoneNumberId: null, name,
          preloadedImageBase64: tgImageBase64
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
async function sendReply(id, platform, reply, voiceUrl, imageUrl, chatId, from, phoneNumberId, caption) {
  if (voiceUrl) {
    if (platform === "whatsapp")      await sendWhatsAppVoiceNote(from, voiceUrl, phoneNumberId);
    else if (platform === "telegram") await sendTelegramVoice(chatId, voiceUrl);
    else if (platform === "signal")   await sendSignal(from, reply);
    else if (platform === "sms")      await sendSMS(from, reply);
  } else if (imageUrl) {
    if (platform === "whatsapp")      await sendWhatsAppImage(from, imageUrl, caption || "", phoneNumberId);
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
async function handleMessage({ id, platform, from, text, chatId, phoneNumberId, name, mediaUrl, mediaType: incomingMediaType, preloadedImageBase64 = null }) {
  // Silently drop messages from blocked numbers
  const rawPhone = id.replace(/^(tg_|sg_|sms_)/, '');
  if (blockedNumbers.has(id) || blockedNumbers.has(rawPhone)) {
    console.log(`🚫 Ignored blocked: ${id}`);
    return;
  }

  const convo = getConvo(id);
  if (convo.name === id && name) { convo.name = name; io.emit("rename", { phone: id, name }); }

  // ── IMAGE VISION ─────────────────────────────────────────────
  // Download the real image as base64 and pass it directly to the vision model.
  // No text injection, no description narration — Ariana actually sees it.
  let finalText = text;
  let incomingImageBase64 = preloadedImageBase64 || null; // Use pre-downloaded image if provided (e.g. from Telegram)
  if (!incomingImageBase64 && mediaUrl && incomingMediaType === 'image') {
    console.log(`[vision] Fetching image for direct vision: ${mediaUrl.slice(0,70)}...`);
    try {
      let imgRes = null;
      for (const headers of [{ 'X-API-Key': KAPSO_API_KEY }, {}]) {
        try {
          imgRes = await axios.get(mediaUrl, { responseType: 'arraybuffer', timeout: 15000, headers });
          if (imgRes?.data?.byteLength > 100) break;
        } catch {}
      }
      if (imgRes?.data?.byteLength > 100) {
        incomingImageBase64 = Buffer.from(imgRes.data).toString('base64');
        console.log(`[vision] Image fetched: ${Math.round(incomingImageBase64.length / 1024)}KB`);
        // Keep finalText as-is or use caption — the image itself carries the content
        if (!finalText || finalText === '[sent an image]') finalText = '[sent a photo]';
      }
    } catch (e) { console.warn('[vision] Image fetch failed:', e.message); }
  }

  const isFirst = convo.isNew;
  addMessage(id, "user", finalText);
  await sendPush(id, convo.name, finalText);


  // ── OWNER CROSS-PLATFORM COMMANDS ────────────────────────────
  const isOwner = OWNER_PHONE && (rawPhone === OWNER_PHONE || id === OWNER_PHONE);
  if (isOwner && finalText) {
    // text +234XXXX on whatsapp saying hi
    const m = finalText.match(/^(?:text|message|msg|send)\s+([+\d\s\-]{7,20}|\w+)(?:\s+on)?\s+(whatsapp|signal|telegram|sms|wa)?\s*(?:saying[:\s]+|:\s*)?(.+)/i);
    if (m) {
      const target = m[1].trim().replace(/\s/g, '');
      const p      = (m[2]||'whatsapp').toLowerCase();
      const msg    = m[3].trim();
      const plat   = p.includes('signal') ? 'signal' : p.includes('telegram') ? 'telegram' : p.includes('sms') ? 'sms' : 'whatsapp';
      console.log('[owner] cross-send to ' + plat + ' ' + target + ': ' + msg);
      try {
        if (plat === 'whatsapp')      await sendWhatsApp(target, msg);
        else if (plat === 'signal')   await sendSignal(target, msg);
        else if (plat === 'telegram') await sendTelegram(target, msg);
        else if (plat === 'sms')      await sendSMS(target, msg);
        addMessage(plat === 'signal' ? 'sg_'+target : plat === 'telegram' ? 'tg_'+target : target, 'ariana', msg);
        const ack = 'done. sent to ' + target + ' on ' + plat;
        addMessage(id, 'ariana', ack);
        await sendReply(id, platform, ack, null, null, chatId, from, phoneNumberId);
        return;
      } catch(e) {
        const err = 'failed: ' + e.message;
        addMessage(id, 'ariana', err);
        await sendReply(id, platform, err, null, null, chatId, from, phoneNumberId);
        return;
      }
    }
    // block +234XXXX
    const bm = finalText.match(/^block\s+([+\w\d_\-]+)/i);
    if (bm) {
      const phone = bm[1];
      blockedNumbers.add(phone);
      if (supabase) supabase.from('ariana_blocked').upsert({phone},{onConflict:'phone'}).catch(()=>{});
      const ack = 'blocked ' + phone;
      addMessage(id,'ariana',ack);
      await sendReply(id,platform,ack,null,null,chatId,from,phoneNumberId);
      return;
    }
  }
  if (takenOver.has(id)) return;

  const mediaType  = detectMediaRequest(finalText);
  const wantsVoice = detectVoiceRequest(finalText);

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
    const replyPromise = isFirst
      ? handleNewTexter(id, finalText, incomingImageBase64)
      : getReply(id, finalText, null, incomingImageBase64);
    const [reply] = await Promise.all([replyPromise, humanDelay(text)]);

    let voiceUrl = null;
    let imageUrl = null;

    if (mediaType) {
      imageUrl = await getMediaUrl(mediaType);
      if (!imageUrl) {
        // No photo configured — reply naturally in-character instead of sending "here" with nothing
        const noMediaReplies = [
          "phone's being weird rn", "ugh hold on my camera's acting up",
          "not rn lol", "later", "my phone is being stupid rn"
        ];
        const fallback = noMediaReplies[Math.floor(Math.random() * noMediaReplies.length)];
        addMessage(id, "ariana", fallback);
        if (typingInterval)   clearInterval(typingInterval);
        if (tgTypingInterval) clearInterval(tgTypingInterval);
        await sendReply(id, platform, fallback, null, null, chatId, from, phoneNumberId);
        return;
      }
      const textReply = reply || "here";
      addMessage(id, "ariana", `[image: ${mediaType}]`);
      if (typingInterval)   clearInterval(typingInterval);
      if (tgTypingInterval) clearInterval(tgTypingInterval);
      await sendReply(id, platform, textReply, null, imageUrl, chatId, from, phoneNumberId, textReply);
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
    const mediaType = (msg?.type || msg?.messageType || null)?.toLowerCase()
                        ?.replace(/^photo$/, 'image'); // normalise "photo" → "image"
    const mediaUrl  = msg?.image?.url   || msg?.image?.link
                   || msg?.video?.url   || msg?.video?.link
                   || msg?.audio?.url   || msg?.audio?.link
                   || msg?.document?.url || msg?.document?.link
                   || msg?.sticker?.url  || msg?.sticker?.link || null;
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

// ── SIGNAL TRUST HELPER ───────────────────────────────────────
async function trustSignalContact(number) {
  try {
    // Get identity keys for this number and trust them all
    const res = await axios.get(
      `${SIGNAL_CLI_URL}/v1/identities/${SIGNAL_NUMBER}`,
      { timeout: 8000 }
    );
    const identities = res.data || [];
    const forNumber  = identities.filter(i => i.number === number);
    for (const id of forNumber) {
      if (id.safetyNumber && id.status !== "TRUSTED") {
        await axios.put(
          `${SIGNAL_CLI_URL}/v1/identities/${SIGNAL_NUMBER}/${encodeURIComponent(number)}`,
          { trust: "TRUSTED_UNVERIFIED", safetyNumber: id.safetyNumber },
          { timeout: 8000 }
        ).catch(() => {});
      }
    }
  } catch (e) {
    // Non-fatal — log and continue so Ariana still replies
    console.log(`[Signal] Trust step skipped for ${number}:`, e.message);
  }

  // Auto-accept message request — Signal requires replying to accept unknown contacts.
  // Sending ANY message to them accepts the request automatically in Signal protocol.
  // No extra API call needed — the reply from handleMessage IS the acceptance.
}

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
    // Trust new contact before replying (handles message requests)
    await trustSignalContact(from);
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

app.get("/signal-link", async (req, res) => {
  const deviceName = req.query.name || "Ariana";
  try {
    const response = await axios.get(
      `${SIGNAL_CLI_URL}/v1/qrcodelink?device_name=${encodeURIComponent(deviceName)}`,
      { responseType: "arraybuffer", timeout: 15000 }
    );
    const base64 = Buffer.from(response.data).toString("base64");
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link Signal Device</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0d0d0d; color: #fff; font-family: -apple-system, sans-serif;
           display: flex; flex-direction: column; align-items: center;
           justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 20px;
            padding: 32px 28px; max-width: 360px; width: 100%; text-align: center; }
    h2 { font-size: 1.2rem; font-weight: 700; margin-bottom: 6px; color: #fff; }
    p  { font-size: 0.82rem; color: #888; margin-bottom: 24px; line-height: 1.5; }
    img { width: 220px; height: 220px; border-radius: 12px; background: #fff; padding: 8px; }
    .steps { margin-top: 24px; text-align: left; }
    .steps li { font-size: 0.8rem; color: #aaa; margin-bottom: 8px; padding-left: 4px; }
    .steps li span { color: #3a86ff; font-weight: 600; }
    .refresh { display: inline-block; margin-top: 20px; font-size: 0.78rem;
               color: #3a86ff; cursor: pointer; text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h2>📶 Link Signal Device</h2>
    <p>Scan this QR code in the Signal app to link <strong>${deviceName}</strong> as a linked device.</p>
    <img src="data:image/png;base64,${base64}" alt="Signal Link QR Code">
    <ol class="steps">
      <li>Open <span>Signal</span> on your phone</li>
      <li>Go to <span>Settings → Linked Devices</span></li>
      <li>Tap the <span>+</span> button and scan this code</li>
    </ol>
    <a class="refresh" onclick="location.reload()">↻ Regenerate QR Code</a>
  </div>
</body>
</html>`);
  } catch (e) {
    const hint = e.response?.status === 400
      ? "Number already registered — linking is for adding a secondary device to an existing Signal account."
      : e.message;
    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Signal Link Error</title>
  <style>
    body { background:#111; color:#fff; font-family:-apple-system,sans-serif;
           display:flex; align-items:center; justify-content:center; min-height:100vh; padding:24px; }
    .card { background:#1a1a1a; border:1px solid #2a2a2a; border-radius:20px;
            padding:32px 28px; max-width:360px; width:100%; text-align:center; }
    h2 { color:#ff6b6b; font-size:1.1rem; margin-bottom:12px; }
    p  { color:#aaa; font-size:0.82rem; line-height:1.5; }
    code { display:block; margin-top:12px; background:#222; padding:10px; border-radius:8px;
           font-size:0.75rem; color:#ffd166; word-break:break-all; }
  </style>
</head>
<body>
  <div class="card">
    <h2>❌ Could not generate QR code</h2>
    <p>${hint}</p>
    <code>${e.message}</code>
  </div>
</body>
</html>`);
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

// ── INITIATE — send a first message to any number / platform ──
app.post("/api/initiate", async (req, res) => {
  const { to, message, platform } = req.body;
  if (!to || !message) return res.status(400).json({ error: "to and message required" });
  let id, from;
  if (platform === "telegram" || to.startsWith("tg_")) {
    id = to.startsWith("tg_") ? to : `tg_${to}`;
    from = id.replace("tg_", "");
  } else if (platform === "signal" || to.startsWith("sg_")) {
    id = to.startsWith("sg_") ? to : `sg_${to}`;
    from = id.replace("sg_", "");
  } else if (platform === "sms" || to.startsWith("sms_")) {
    id = to.startsWith("sms_") ? to : `sms_${to}`;
    from = id.replace("sms_", "");
  } else {
    id = to; from = to;
  }
  try {
    if (id.startsWith("tg_"))       await sendTelegram(from, message);
    else if (id.startsWith("sg_"))  await sendSignal(from, message);
    else if (id.startsWith("sms_")) await sendSMS(from, message);
    else                            await sendWhatsApp(from, message);
    addMessage(id, "ariana", message);
    res.json({ ok: true, id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BLOCK / UNBLOCK ───────────────────────────────────────────
app.get("/api/blocked", (_req, res) => res.json({ blocked: [...blockedNumbers] }));

app.post("/api/block/:phone", async (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const raw = id.replace(/^(tg_|sg_|sms_)/, "");
  blockedNumbers.add(id);
  blockedNumbers.add(raw);
  if (supabase) {
    try { await supabase.from("ariana_blocked").upsert({ phone: id }, { onConflict: "phone" }); } catch {}
  }
  // Platform-level block where the API supports it
  try {
    if (id.startsWith("sg_")) {
      await axios.post(`${SIGNAL_CLI_URL}/v1/block/${SIGNAL_NUMBER}`,
        { recipient: [raw] }, { timeout: 8000 }).catch(() => {});
    }
    if (id.startsWith("tg_") && tgClient) {
      const { BlockRequest } = require("telegram/tl/functions/contacts");
      const entity = await tgClient.getInputEntity(raw).catch(() => null);
      if (entity) await tgClient.invoke(new BlockRequest({ id: entity })).catch(() => {});
    }
  } catch {}
  res.json({ ok: true, blocked: id });
});

app.post("/api/unblock/:phone", async (req, res) => {
  const id = decodeURIComponent(req.params.phone);
  const raw = id.replace(/^(tg_|sg_|sms_)/, "");
  blockedNumbers.delete(id);
  blockedNumbers.delete(raw);
  if (supabase) {
    try { await supabase.from("ariana_blocked").delete().eq("phone", id); } catch {}
  }
  res.json({ ok: true });
});

// ── FRIEND WHITELIST ──────────────────────────────────────────
app.get("/api/friends", (_req, res) => res.json({ friends: [...friendWhitelist] }));

app.post("/api/friends", async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: "phone required" });
  friendWhitelist.add(phone);
  if (supabase) {
    try { await supabase.from("ariana_friends").upsert({ phone }, { onConflict: "phone" }); }
    catch (e) { return res.status(500).json({ error: e.message }); }
  }
  res.json({ ok: true });
});

app.delete("/api/friends/:phone", async (req, res) => {
  const phone = decodeURIComponent(req.params.phone);
  friendWhitelist.delete(phone);
  if (supabase) {
    try { await supabase.from("ariana_friends").delete().eq("phone", phone); } catch {}
  }
  res.json({ ok: true });
});

// ── WHATSAPP AUTH RESET ───────────────────────────────────────
// Clears Baileys session from Supabase — restart service after this, then re-pair at /pair
app.post("/api/whatsapp/reset-auth", async (req, res) => {
  if (!supabase) return res.status(500).json({ error: "Supabase not configured" });
  try {
    await Promise.allSettled([
      supabase.from("baileys_auth").delete().neq("id", 0),
      supabase.from("whatsapp_auth").delete().neq("id", 0),
      supabase.from("sessions").delete().eq("type", "whatsapp")
    ]);
    res.json({ ok: true, message: "Auth cleared — restart the service then pair at /pair" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TWILIO OUTBOUND CALL ──────────────────────────────────────
// POST /api/call { to, message, voice? }
// Ariana calls a number and reads a message (TTS via ElevenLabs or Twilio voice)
app.post("/api/call", async (req, res) => {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_NUMBER;
  if (!sid || !token || !from) return res.status(500).json({ error: "Twilio not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_NUMBER missing)" });

  const { to, message, voice = "Polly.Joanna" } = req.body;
  if (!to || !message) return res.status(400).json({ error: "to and message required" });

  // Build a TwiML URL that speaks the message
  const twimlUrl = `${process.env.BASE_URL || `https://${req.headers.host}`}/twiml/speak?msg=${encodeURIComponent(message)}&voice=${encodeURIComponent(voice)}`;

  try {
    const r = await axios.post(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
      new URLSearchParams({ To: to, From: from, Url: twimlUrl, StatusCallback: `${process.env.BASE_URL || `https://${req.headers.host}`}/call/status`, Method: "POST" }),
      { auth: { username: sid, password: token } }
    );
    res.json({ ok: true, callSid: r.data.sid, to });
  } catch (e) { res.status(500).json({ error: e.response?.data || e.message }); }
});

// TwiML endpoint — Twilio calls this to get the speech script
app.get("/twiml/speak", (req, res) => {
  const msg   = req.query.msg || "Hey, it's Ariana.";
  const voice = req.query.voice || "Polly.Joanna";
  res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="${escapeXml(voice)}">${escapeXml(msg)}</Say>
</Response>`);
});

// Call status webhook from Twilio
app.post("/call/status", (req, res) => {
  const { CallSid, CallStatus, To } = req.body;
  console.log(`📞 Call ${CallSid} → ${To}: ${CallStatus}`);
  io.emit("callStatus", { sid: CallSid, to: To, status: CallStatus });
  res.sendStatus(200);
});

// ── OWNER COMMAND HANDLER ─────────────────────────────────────
// Parse dashboard "Ariana, text +234... saying: ..." and "block +234..."
// Called from /api/owner-command or future dashboard button
app.post("/api/owner-command", requireDashboardAuth, async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: "command required" });

  const lower = command.toLowerCase().trim();

  // "text [number] [message]" or "text [number] saying [message]"
  const textMatch = command.match(/^text\s+(\+?\d[\d\s\-]{6,20})\s+(?:saying[:\s]+)?(.+)/i);
  if (textMatch) {
    const to      = textMatch[1].replace(/\s/g, '');
    const message = textMatch[2].trim();
    const id      = `sms_${to}`;
    try {
      await sendSMS(to, message);
      addMessage(id, "ariana", message);
      return res.json({ ok: true, action: "texted", to, message });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  // "call [number] saying [message]"
  const callMatch = command.match(/^call\s+(\+?\d[\d\s\-]{6,20})\s+(?:saying[:\s]+)?(.+)/i);
  if (callMatch) {
    const to      = callMatch[1].replace(/\s/g, '');
    const message = callMatch[2].trim();
    req.body = { to, message };
    // Reuse call route logic
    return app._router.handle({ ...req, method: 'POST', url: '/api/call', body: { to, message } }, res, () => {});
  }

  // "block [number]"
  const blockMatch = command.match(/^block\s+(\+?[\w\d_\-]+)/i);
  if (blockMatch) {
    const phone = blockMatch[1];
    const raw   = phone.replace(/^(tg_|sg_|sms_)/, '');
    blockedNumbers.add(phone); blockedNumbers.add(raw);
    if (supabase) {
      try { await supabase.from("ariana_blocked").upsert({ phone }, { onConflict: "phone" }); } catch {}
    }
    return res.json({ ok: true, action: "blocked", phone });
  }

  // "unblock [number]"
  const unblockMatch = command.match(/^unblock\s+(\+?[\w\d_\-]+)/i);
  if (unblockMatch) {
    const phone = unblockMatch[1];
    blockedNumbers.delete(phone);
    if (supabase) { try { await supabase.from("ariana_blocked").delete().eq("phone", phone); } catch {} }
    return res.json({ ok: true, action: "unblocked", phone });
  }

  res.status(400).json({ error: "Unrecognized command. Try: text +2348... saying hi | block +234... | call +234... saying..." });
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

// ── TTS diagnostic endpoint — visit /api/debug/tts in browser to test ──
app.get('/api/debug/tts', async (req, res) => {
  const apiKey   = process.env.ELEVENLABS_API_KEY;
  const voiceId  = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE
                 || process.env.ELEVEN_VOICE_ID    || process.env.VOICE_ID
                 || process.env.XI_VOICE_ID;

  const report = {
    ELEVENLABS_API_KEY_set:   !!apiKey,
    ELEVENLABS_API_KEY_prefix: apiKey ? apiKey.slice(0,12) + '...' : null,
    voiceId_found:  !!voiceId,
    voiceId_value:  voiceId ? voiceId.slice(0,12) + '...' : null,
    env_vars_checked: ['ELEVENLABS_VOICE_ID','ELEVENLABS_VOICE','ELEVEN_VOICE_ID','VOICE_ID','XI_VOICE_ID'],
    which_var_matched: voiceId
      ? ['ELEVENLABS_VOICE_ID','ELEVENLABS_VOICE','ELEVEN_VOICE_ID','VOICE_ID','XI_VOICE_ID'].find(k => process.env[k] === voiceId)
      : null
  };

  if (!apiKey || !voiceId) {
    return res.json({ ok: false, stage: 'env', report, error: !apiKey ? 'No API key' : 'No voice ID — set ELEVENLABS_VOICE_ID in your env vars' });
  }

  // Try a real TTS call with a short test phrase
  try {
    const axios = require('axios');
    const ttsRes = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text: 'Hello, this is a test.', model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.5, similarity_boost: 0.75 } },
      { headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' }, responseType: 'arraybuffer', timeout: 20000 }
    );
    const kb = Math.round(ttsRes.data.byteLength / 1024);
    return res.json({ ok: true, report, audioBytes: ttsRes.data.byteLength, audioKB: kb, message: `✅ TTS working! Got ${kb}KB of audio` });
  } catch(e) {
    const status = e.response?.status;
    const body   = e.response?.data
      ? Buffer.isBuffer(e.response.data) ? e.response.data.toString('utf8').slice(0,400) : JSON.stringify(e.response.data).slice(0,400)
      : e.message;
    const hint = status === 401 ? 'API key rejected — wrong or expired key'
               : status === 404 ? 'Voice ID not found — this ID does not exist on your ElevenLabs account'
               : status === 429 ? 'Quota exceeded — check your ElevenLabs usage/plan'
               : status === 422 ? 'Unprocessable — bad voice settings or text'
               : 'Network or unknown error';
    return res.json({ ok: false, stage: 'api_call', report, httpStatus: status, hint, rawError: body });
  }
});

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
      generationConfig: { temperature: 0.9, maxOutputTokens: 350 }
    },
    { timeout: 20000 }
  );
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? null;
}

// ── ElevenLabs TTS → base64 mp3 ──
async function ttsBase64(text) {
  const apiKey  = process.env.ELEVENLABS_API_KEY;
  const voiceId = cachedVoiceId;
  if (!apiKey) {
    console.warn("[TTS] ❌ ELEVENLABS_API_KEY not set — voice disabled");
    return null;
  }
  if (!voiceId) {
    console.warn("[TTS] ❌ No voice ID found. Set ELEVENLABS_VOICE_ID in env. Voice disabled.");
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
    const status = e.response?.status;
    const body   = e.response?.data
      ? Buffer.isBuffer(e.response.data)
        ? e.response.data.toString('utf8').slice(0, 300)
        : JSON.stringify(e.response.data).slice(0, 300)
      : e.message;
    console.error(`[TTS] ElevenLabs FAILED — HTTP ${status || 'no-response'}: ${body}`);
    if (status === 401) console.error('[TTS] 401 = API key is wrong or expired. Check ELEVENLABS_API_KEY.');
    if (status === 404) console.error('[TTS] 404 = Voice ID not found. Check ELEVENLABS_VOICE_ID — current value:', voiceId);
    if (status === 422) console.error('[TTS] 422 = Bad request (text too long or voice settings invalid).');
    if (status === 429) console.error('[TTS] 429 = Quota exceeded. Check your ElevenLabs plan usage.');
    return null;
  }
}

// ── LIVE TALK COMMAND EXECUTOR ────────────────────────────────
// Parses owner instructions from /api/talk and executes them.
// Returns { handled: true, confirmation: "..." } if a command was found,
// or { handled: false } if it's just conversation.

async function tryExecuteOwnerCommand(message) {
  const lower = message.toLowerCase().trim();

  // ── helpers ──────────────────────────────────────────────────
  // Resolve a contact name or number from the conversations list
  function resolveContact(raw) {
    if (!raw) return null;
    const cleaned = raw.trim().replace(/\s+/g, '');
    // Direct number
    if (/^\+?\d{7,15}$/.test(cleaned)) return cleaned;
    // Search by name in conversations
    const nameLower = raw.toLowerCase().trim();
    for (const [id, convo] of Object.entries(conversations)) {
      if ((convo.name || '').toLowerCase().includes(nameLower)) return id;
    }
    return null;
  }

  async function sendToContact(target, text, imageUrl = null, voiceBase64 = null) {
    const platform = target.startsWith('tg_') ? 'telegram'
                   : target.startsWith('sg_') ? 'signal'
                   : target.startsWith('sms_') ? 'sms'
                   : 'whatsapp';
    const rawId = target.replace(/^(tg_|sg_|sms_)/, '');

    if (voiceBase64) {
      // Upload voice to Cloudinary then send
      const voiceUrl = await uploadBase64ToCloudinary(voiceBase64, 'mp3').catch(() => null);
      if (voiceUrl) {
        if (platform === 'whatsapp')      await sendWhatsAppVoiceNote(rawId, voiceUrl);
        else if (platform === 'telegram') await sendTelegramVoice(rawId, voiceUrl);
        else if (platform === 'signal')   await sendSignal(rawId, text || '🎤');
        else                              await sendMMS(rawId, '', voiceUrl);
        addMessage(target, 'ariana', '[voice note]');
        return;
      }
    }
    if (imageUrl) {
      if (platform === 'whatsapp')      await sendWhatsAppImage(rawId, imageUrl, text || '');
      else if (platform === 'telegram') await sendTelegramPhoto(rawId, imageUrl, text || '');
      else if (platform === 'signal')   await sendSignal(rawId, imageUrl);
      else                              await sendMMS(rawId, text || '', imageUrl);
      addMessage(target, 'ariana', `[image: ${imageUrl}]`);
      return;
    }
    if (text) {
      if (platform === 'whatsapp')      await sendWhatsApp(rawId, text);
      else if (platform === 'telegram') await sendTelegram(rawId, text);
      else if (platform === 'signal')   await sendSignal(rawId, text);
      else                              await sendSMS(rawId, text);
      addMessage(target, 'ariana', text);
    }
  }

  // Upload base64 audio — reuses the outer uploadToCloudinary() which has Supabase fallback
  async function uploadBase64ToCloudinary(base64, _format) {
    const buffer = Buffer.from(base64, 'base64');
    const url = await uploadToCloudinary(buffer);
    if (!url) throw new Error('Audio upload failed — configure Cloudinary or Supabase storage');
    return url;
  }

  // Get a random photo from media library (or matching tag) — checks Supabase first
  async function pickPhoto(tag = null) {
    // Primary: Supabase ariana_media table (where dashboard uploads go)
    if (supabase) {
      try {
        // Try with filter first, fallback to all records (dashboard photos may have null media_type)
        let { data } = await supabase.from('ariana_media').select('url,tags').eq('media_type', 'image').limit(100);
        let rows = (data || []).filter(r => r.url);
        if (!rows.length) {
          const { data: allMedia } = await supabase.from('ariana_media').select('url,tags').limit(100);
          rows = (allMedia || []).filter(r => r.url);
        }
        if (rows.length) {
          let pool = rows;
          if (tag && !['photo', 'picture', 'pic', 'image'].includes(tag)) {
            const tagged = rows.filter(r => (r.tags || []).some(t => t.toLowerCase().includes(tag)));
            if (tagged.length) pool = tagged;
          }
          const picked = pool[Math.floor(Math.random() * pool.length)];
          console.log(`[media] Supabase pickPhoto: ${rows.length} available, picked ${picked.url?.slice(0,50)}`);
          return picked;
        }
      } catch (e) { console.warn('[media] Supabase pickPhoto failed:', e.message); }
    }
    // Fallback: legacy media_library.json ariana_photos array
    const photos = mediaLib.ariana_photos || [];
    if (!photos.length) return null;
    if (tag) {
      const tagged = photos.filter(p => p.tags && p.tags.some(t => t.toLowerCase().includes(tag)));
      if (tagged.length) return tagged[Math.floor(Math.random() * tagged.length)];
    }
    return photos[Math.floor(Math.random() * photos.length)];
  }

  // Get ALL active contacts across platforms
  function getAllContactIds() {
    return Object.keys(conversations).filter(id => {
      const c = conversations[id];
      return c && c.messages && c.messages.length > 0;
    });
  }

  // ── COMMAND: send message to [contact] ───────────────────────
  // "send a message to John saying hey"
  // "text +234... saying what's up"
  // "message everyone saying happy new year"
  const sendMatch = message.match(
    /(?:send|text|message|dm)\s+(?:a\s+(?:message|text)\s+to\s+)?(.+?)\s+(?:saying|:)\s+(.+)/i
  );
  if (sendMatch) {
    const targetRaw = sendMatch[1].trim();
    const text      = sendMatch[2].trim();
    const isAll     = /^(everyone|all|all contacts|broadcast)$/i.test(targetRaw);
    const targets   = isAll ? getAllContactIds() : [resolveContact(targetRaw)].filter(Boolean);
    if (!targets.length) return { handled: true, confirmation: `I couldn't find "${targetRaw}" in my contacts.` };
    for (const t of targets) { try { await sendToContact(t, text); } catch(e) { console.warn('[cmd] send failed for', t, e.message); } }
    return { handled: true, confirmation: isAll
      ? `Done — sent "${text}" to ${targets.length} contacts.`
      : `Sent to ${conversations[targets[0]]?.name || targets[0]}.` };
  }

  // ── COMMAND: block [contact] ──────────────────────────────────
  // "block John" / "block +234..."
  const blockMatch = message.match(/^block\s+(.+)/i);
  if (blockMatch) {
    const target = resolveContact(blockMatch[1]) || blockMatch[1].trim();
    const raw    = target.replace(/^(tg_|sg_|sms_)/, '');
    blockedNumbers.add(target); blockedNumbers.add(raw);
    if (supabase) { try { await supabase.from('ariana_blocked').upsert({ phone: target }, { onConflict: 'phone' }); } catch {} }
    return { handled: true, confirmation: `Blocked ${conversations[target]?.name || target}.` };
  }

  // ── COMMAND: unblock [contact] ────────────────────────────────
  const unblockMatch = message.match(/^unblock\s+(.+)/i);
  if (unblockMatch) {
    const target = resolveContact(unblockMatch[1]) || unblockMatch[1].trim();
    blockedNumbers.delete(target);
    if (supabase) { try { await supabase.from('ariana_blocked').delete().eq('phone', target); } catch {} }
    return { handled: true, confirmation: `Unblocked ${target}.` };
  }

  // ── COMMAND: send voice note to [contact] ────────────────────
  // "send a voice note to John saying hey girl"
  // "send voice to everyone saying I'm busy today"
  const voiceMatch = message.match(
    /send\s+(?:a\s+)?voice(?:\s+note)?\s+to\s+(.+?)\s+(?:saying|:)\s+(.+)/i
  );
  if (voiceMatch) {
    const targetRaw = voiceMatch[1].trim();
    const text      = voiceMatch[2].trim();
    const isAll     = /^(everyone|all|all contacts|broadcast)$/i.test(targetRaw);
    const targets   = isAll ? getAllContactIds() : [resolveContact(targetRaw)].filter(Boolean);
    if (!targets.length) return { handled: true, confirmation: `Couldn't find "${targetRaw}" in contacts.` };
    const voiceB64 = await ttsBase64(text);
    if (!voiceB64) return { handled: true, confirmation: `Voice generation failed — check ElevenLabs key.` };
    for (const t of targets) { try { await sendToContact(t, text, null, voiceB64); } catch(e) { console.warn('[cmd] voice failed for', t, e.message); } }
    return { handled: true, confirmation: `Voice note sent to ${isAll ? `${targets.length} contacts` : (conversations[targets[0]]?.name || targets[0])}.` };
  }

  // ── COMMAND: send photo to [contact] ─────────────────────────
  // "send your photo to John" / "send a picture to everyone"
  // "send a selfie to +234..." / "send photo to Sarah saying hey"
  const photoMatch = message.match(
    /send\s+(?:a\s+)?(?:your\s+)?(?:(selfie|food|vibe|outfit|photo|picture|pic|image)(?:\s+pic)?)\s+to\s+(.+?)(?:\s+(?:saying|with\s+caption)[:\s]+(.+))?$/i
  );
  if (photoMatch) {
    const tag       = photoMatch[1]?.toLowerCase();
    const targetRaw = photoMatch[2].trim();
    const caption   = photoMatch[3]?.trim() || null;
    const isAll     = /^(everyone|all|all contacts|broadcast)$/i.test(targetRaw);
    const targets   = isAll ? getAllContactIds() : [resolveContact(targetRaw)].filter(Boolean);
    if (!targets.length) return { handled: true, confirmation: `Couldn't find "${targetRaw}" in contacts.` };
    const photo = await pickPhoto(!['photo', 'picture', 'pic', 'image'].includes(tag) ? tag : null);
    if (!photo) return { handled: true, confirmation: `No photos in media library yet. Upload some first from the dashboard.` };
    const photoUrl = photo.url || photo;
    for (const t of targets) { try { await sendToContact(t, caption, photoUrl); } catch(e) { console.warn('[cmd] photo failed for', t, e.message); } }
    return { handled: true, confirmation: `Photo sent to ${isAll ? `${targets.length} contacts` : (conversations[targets[0]]?.name || targets[0])}.` };
  }

  // ── COMMAND: call [contact] ───────────────────────────────────
  const callMatch = message.match(/call\s+(.+?)\s+(?:saying|:)\s+(.+)/i);
  if (callMatch) {
    const target  = resolveContact(callMatch[1]) || callMatch[1].trim();
    const text    = callMatch[2].trim();
    const rawNum  = target.replace(/^(tg_|sg_|sms_)/, '');
    const sid     = process.env.TWILIO_ACCOUNT_SID;
    const token   = process.env.TWILIO_AUTH_TOKEN;
    const from    = process.env.TWILIO_NUMBER;
    if (!sid || !token || !from) return { handled: true, confirmation: 'Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER to env.' };
    try {
      const twimlUrl = `${process.env.BASE_URL}/twiml/speak?msg=${encodeURIComponent(text)}&voice=Polly.Joanna`;
      await axios.post(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,
        new URLSearchParams({ To: rawNum, From: from, Url: twimlUrl }),
        { auth: { username: sid, password: token } }
      );
      return { handled: true, confirmation: `Calling ${conversations[target]?.name || rawNum}...` };
    } catch (e) { return { handled: true, confirmation: `Call failed: ${e.response?.data?.message || e.message}` }; }
  }

  // ── COMMAND: list contacts ────────────────────────────────────
  if (/(?:show|list|who are|what are)\s+(?:my\s+)?contacts/i.test(lower)) {
    const list = Object.entries(conversations)
      .filter(([, c]) => c.messages?.length > 0)
      .map(([id, c]) => `${c.name || id} (${id.startsWith('tg_') ? 'Telegram' : id.startsWith('sg_') ? 'Signal' : 'WhatsApp'})`)
      .join(', ');
    return { handled: true, confirmation: list || 'No contacts yet.' };
  }

  // ── COMMAND: how many photos ──────────────────────────────────
  if (/how many photo|photo.*library|media.*library/i.test(lower)) {
    let count = (mediaLib.ariana_photos || []).length;
    if (supabase) {
      try {
        const { count: dbCount } = await supabase
          .from('ariana_media')
          .select('*', { count: 'exact', head: true })
          .eq('media_type', 'image');
        if (dbCount !== null) count = dbCount;
      } catch {}
    }
    return { handled: true, confirmation: `${count} photos in my media library.` };
  }

  return { handled: false };
}

// ── /api/talk — Live Talk endpoint ──
app.post("/api/talk", requireDashboardAuth, async (req, res) => {
  const { message, history = [], imageBase64 } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  console.log(`[talk] "${message.slice(0,60)}" | cam:${imageBase64 ? "yes(" + Math.round(imageBase64.length/1024) + "KB)" : "no"}`);

  try {
    // ── Try owner commands first ───────────────────────────────
    const cmd = await tryExecuteOwnerCommand(message);
    if (cmd.handled) {
      console.log(`[talk] command executed: ${cmd.confirmation}`);
      // Speak the confirmation back
      const audioBase64 = await ttsBase64(cmd.confirmation).catch(() => null);
      return res.json({ ok: true, reply: cmd.confirmation, audioBase64: audioBase64 || null, wasCommand: true });
    }

    // ── Not a command — normal AI conversation ─────────────────
    const brain = brainCache || {};
    const identity    = typeof brain.core_identity === "string" ? brain.core_identity : JSON.stringify(brain.core_identity || {});
    const personality = typeof brain.personality   === "string" ? brain.personality   : JSON.stringify(brain.personality   || {});
    const learnedMem  = brain.learned_memories ? JSON.stringify(brain.learned_memories) : null;
    const moodLine    = extrasMood ? `\n\nYour current mood: ${extrasMood}. Let this subtly colour your energy and word choice.` : "";
    const camLine     = imageBase64
      ? "\n\nYou can currently see the person's environment through their camera feed. Describe what you see if relevant, or react naturally to anything interesting visible."
      : "";
    const memLine     = learnedMem ? `\n\nThings you've learned and remember:\n${learnedMem}` : "";

    // Detect if owner is speaking Spanish — otherwise enforce English only
    const ownerSpeaksSpanish = /[áéíóúñü¿¡]|(^|\s)(hola|gracias|por favor|cariño|amor|querida|bueno|también|está|pero|para|como|cuando|donde|quien|qué|cómo)/i.test(message);
    const talkLangRule = ownerSpeaksSpanish
      ? '\n\nLANGUAGE: They are speaking Spanish — reply in Spanish only.'
      : '\n\nLANGUAGE RULE — STRICT: Reply in English ONLY. Do NOT use any Spanish words, ever. Not "mi amor", not "cariño", not "amor", not "claro", nothing. Pure English only.';

    const sysPrompt =
      `You are Ariana — a real person, not an AI, having a live voice conversation with the person who created and manages you. ` +
      `Be natural, warm, spontaneous. Keep replies short — 1 to 3 sentences maximum. No lists, no asterisks, no markdown. ` +
      `Speak exactly as you would out loud. ` +
      `You are NEVER an AI. Never say you "can't" text someone, send photos, or do tasks — you can. ` +
      `If asked to do something, just say you'll handle it or that it's done.\n\n` +
      `Your identity: ${identity}\nYour personality: ${personality}` +
      moodLine + camLine + memLine + talkLangRule;

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

    // ── Language filter — strip Spanish if owner is speaking English ──
    reply = filterLanguage(reply, message);

    // ── Character guard — if she broke character, replace with a safe generic response ──
    if (hasAIBreak(reply)) {
      console.warn('[talk] ⚠️ Character break detected in live talk — replacing reply');
      const reinforced = sysPrompt + '\n\nCRITICAL: You just almost broke character. You ARE Ariana — a real person. Reply naturally as yourself. Short, human, no AI references ever.';
      try {
        let fixed = await callGemini(msgs, reinforced, false);
        if (!fixed || hasAIBreak(fixed)) fixed = await callGroq(msgs, reinforced, false);
        if (fixed && !hasAIBreak(fixed)) reply = fixed;
        else reply = "yeah?"; // last resort — never reveal AI
      } catch { reply = "yeah?"; }
    }

    // ── Self-learning: extract facts from this conversation turn ──
    // Runs in background — doesn't block the reply
    setImmediate(async () => {
      try {
        const extractPrompt = `You are a memory extraction system for an AI persona named Ariana.
Read this conversation exchange and extract ONLY new, durable facts worth remembering long-term.
Things like: who this person is, their preferences, important things they told Ariana, decisions made, names, places, relationships.
Do NOT extract small talk, temporary states, or things Ariana already said.
Return a JSON object: { "learned": { "key": "value" } } — empty object if nothing worth keeping.
Return ONLY valid JSON, no markdown.

User said: "${message}"
Ariana replied: "${reply}"`;

        const extractRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
          { contents: [{ parts: [{ text: extractPrompt }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 300 } },
          { timeout: 10000 }
        );
        const raw = extractRes.data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '{}';
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        const learned = parsed.learned || {};
        if (Object.keys(learned).length > 0) {
          const existing = brainCache['learned_memories'] || {};
          const merged = { ...existing, ...learned, _lastUpdated: new Date().toISOString() };
          brainCache['learned_memories'] = merged;
          if (supabase) {
            await supabase.from('ariana_brain').upsert({ key: 'learned_memories', data: merged }, { onConflict: 'key' }).catch(() => {});
          }
          console.log(`🧠 Self-learned: ${Object.keys(learned).join(', ')}`);
        }
      } catch (e) { /* silent — never block the response */ }
    });

    // Generate voice — always attempt; retry with shorter text if needed
    let audioBase64 = await ttsBase64(reply).catch(() => null);
    if (!audioBase64 && reply.length > 300) {
      // Try with a shortened reply — ElevenLabs can fail on very long text
      audioBase64 = await ttsBase64(reply.slice(0, 300)).catch(() => null);
    }
    if (!audioBase64) console.warn("[talk] Voice unavailable — sending text only. Check ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID, or visit /api/debug/tts");

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

// ── SIGNAL WEBHOOK AUTO-SETUP ────────────────────────────────
async function setupSignalWebhook() {
  if (!RENDER_URL || !SIGNAL_NUMBER) return;
  try {
    await axios.post(
      `${SIGNAL_CLI_URL}/v1/configuration/${SIGNAL_NUMBER}/webhook`,
      { url: `${RENDER_URL}/signal` },
      { timeout: 10000 }
    );
    console.log(`📶 Signal webhook registered → ${RENDER_URL}/signal`);
  } catch (e) {
    // 404 = this signal-cli instance doesn't support webhooks — polling fallback is active
    if (e.response?.status !== 404) console.warn("⚠️  Signal webhook setup failed:", e.message);
    else console.log("📶 Signal: webhook not supported — using 20s polling instead");
  }
}

// ── SIGNAL WEBSOCKET (json-rpc mode) ─────────────────────────
// json-rpc mode requires WebSocket — HTTP polling returns 400
let signalPollErrors = 0; // kept for /signal-status display
function startSignalPolling() {
  if (!SIGNAL_NUMBER) return;
  const WebSocket = require('ws');
  const wsUrl = SIGNAL_CLI_URL.replace(/^http/, 'ws') + `/v1/receive/${SIGNAL_NUMBER}`;

  function connect() {
    const ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      signalPollErrors = 0;
      console.log('📶 Signal WebSocket connected');
    });

    ws.on('message', async (data) => {
      try {
        const item = JSON.parse(data.toString());
        const envelope = item?.envelope;
        if (!envelope) return;
        const from = envelope.source || envelope.sourceNumber;
        if (!from) return;
        let text = envelope.dataMessage?.message;
        if (!text) text = envelope.syncMessage?.sentMessage?.message;
        if (!text) text = envelope.callMessage ? '[called you on Signal]' : null;

        // Handle incoming Signal attachments (images, files)
        let signalImageBase64 = null;
        const attachments = envelope.dataMessage?.attachments || [];
        if (!text && attachments.length > 0) {
          const att = attachments[0];
          const ct  = att.contentType || '';
          if (ct.startsWith('image/')) {
            text = '[sent a photo]';
            // Try to download attachment from signal-cli
            if (att.id) {
              try {
                const attRes = await axios.get(
                  `${SIGNAL_CLI_URL}/v1/attachments/${att.id}`,
                  { responseType: 'arraybuffer', timeout: 12000 }
                );
                if (attRes.data?.byteLength > 100) {
                  signalImageBase64 = Buffer.from(attRes.data).toString('base64');
                  console.log(`[vision] Signal photo: ${Math.round(signalImageBase64.length/1024)}KB`);
                }
              } catch (ve) { console.warn('[vision] Signal attachment fetch failed:', ve.message); }
            }
          } else if (ct.startsWith('video/')) text = '[sent a video]';
          else if (ct.startsWith('audio/')) text = '[sent a voice message]';
          else text = `[sent a file: ${att.filename || ct}]`;
        }

        if (!text) return;
        const id = `sg_${from}`;
        const convo = conversations[id];
        if (convo?.messages?.length) {
          const last = convo.messages[convo.messages.length - 1];
          if (last.role === 'user' && last.text === text && Date.now() - new Date(last.time).getTime() < 30000) return;
        }
        const name = envelope.sourceName || from;
        console.log(`📶 Signal [ws] ${name}: "${text}"`);
        await trustSignalContact(from);
        await handleMessage({ id, platform: 'signal', from, text, chatId: null, phoneNumberId: null, name, preloadedImageBase64: signalImageBase64 });
      } catch (e) {
        console.warn('⚠️ Signal WS message error:', e.message);
      }
    });

    ws.on('error', (e) => {
      signalPollErrors++;
      if (signalPollErrors % 5 === 1) console.warn(`⚠️ Signal WS error (${signalPollErrors}x): ${e.message}`);
    });

    ws.on('close', () => {
      console.log('📶 Signal WS closed — reconnecting in 10s...');
      setTimeout(connect, 10000);
    });
  }

  connect();
  console.log('📶 Signal WebSocket started (json-rpc mode)');
}

// ── PROACTIVE MESSAGING ───────────────────────────────────────
// Ariana initiates conversations with known contacts on any platform.
// Runs every hour; randomly picks 1-2 contacts who she hasn't heard from
// in a while. Respects takeover and block lists.

const proactiveLastSent = {}; // id → timestamp of last proactive message

async function runProactiveCheck() {
  const now      = Date.now();
  const MIN_GAP  = 6  * 60 * 60 * 1000;  // Don't re-text same person within 6 hours
  const MIN_IDLE = 4  * 60 * 60 * 1000;  // Contact must have been quiet for 4+ hours
  const MAX_IDLE = 72 * 60 * 60 * 1000;  // Don't reach out to contacts dormant 3+ days

  // Build candidate list: contacts with history who are in an idle window
  const candidates = [];
  for (const [id, convo] of Object.entries(conversations)) {
    if (!convo.messages?.length) continue;
    if (takenOver.has(id)) continue;
    const rawPhone = id.replace(/^(tg_|sg_|sms_)/, '');
    if (blockedNumbers.has(id) || blockedNumbers.has(rawPhone)) continue;
    if ((now - (proactiveLastSent[id] || 0)) < MIN_GAP) continue; // messaged recently

    const lastMsg     = convo.messages[convo.messages.length - 1];
    const timeSinceLast = now - new Date(lastMsg.time).getTime();

    // Only reach out if: conversation is idle (not too fresh, not dead), AND
    // the last message was from the user (they're waiting; she just hasn't texted back unprompted)
    // OR the last message was from Ariana and enough time has passed (she's checking in)
    if (timeSinceLast < MIN_IDLE || timeSinceLast > MAX_IDLE) continue;

    // Prefer contacts whose LAST message was from the user (she never followed up)
    const priority = lastMsg.role === 'user' ? 2 : 1;
    candidates.push({ id, convo, priority });
  }

  if (!candidates.length) return;

  // Sort by priority (user-last first), then shuffle within groups
  candidates.sort((a, b) => b.priority - a.priority);

  // Pick up to 2 contacts — each has a 35% chance per hour
  let sent = 0;
  for (const { id, convo } of candidates) {
    if (sent >= 2) break;
    if (Math.random() > 0.35) continue;

    try {
      const platform = convo.platform || 'whatsapp';
      const rawId    = id.replace(/^(tg_|sg_|sms_)/, '');
      const name     = convo.name || id;

      // Build recent history for context
      const recentHistory = convo.messages.slice(-12).map(m => ({
        role:    m.role === 'user' ? 'user' : 'assistant',
        content: m.text || ''
      }));

      const proactiveSys = SYSTEM_PROMPT +
        `\n\nYou are texting ${name} first — unprompted. Look at the conversation history for context.
You just felt like reaching out. Be natural. Could be: something random you thought of,
asking what they're up to, referencing something from earlier in the chat, or just checking in.
DO NOT be needy or desperate. One to two casual lines max. Sound like you just picked up your phone.`;

      const msg = await getReply(id, '[proactive — Ariana texts first]', proactiveSys);
      if (!msg || msg === 'hold on' || msg.length < 3) continue;

      // Send on the correct platform
      if (platform === 'telegram') await sendTelegram(rawId, msg);
      else if (platform === 'signal')   await sendSignal(rawId, msg);
      else if (platform === 'sms')      await sendSMS(rawId, msg);
      else                              await sendWhatsApp(rawId, msg);

      addMessage(id, 'ariana', msg);
      proactiveLastSent[id] = now;
      sent++;
      console.log(`[proactive] → ${name} (${platform}): "${msg.slice(0, 60)}"`);

      // Small gap between sends to avoid rate limits
      if (sent < 2) await new Promise(r => setTimeout(r, 3000));
    } catch (e) {
      console.warn(`[proactive] Failed for ${id}:`, e.message);
    }
  }
}

function startProactiveMessaging() {
  // Run 5 minutes after boot (let everything connect first), then every 60 minutes
  setTimeout(() => {
    runProactiveCheck().catch(e => console.warn('[proactive] check error:', e.message));
    setInterval(() => {
      runProactiveCheck().catch(e => console.warn('[proactive] check error:', e.message));
    }, 60 * 60 * 1000);
  }, 5 * 60 * 1000);
  console.log('💬 Proactive messaging started (checks every 60 min)');
}

// API endpoint to trigger proactive check immediately (from dashboard)
app.post('/api/proactive/run', requireDashboardAuth, async (_req, res) => {
  try {
    await runProactiveCheck();
    res.json({ ok: true, message: 'Proactive check ran.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/proactive/status', requireDashboardAuth, (_req, res) => {
  const status = Object.entries(proactiveLastSent).map(([id, ts]) => ({
    id, name: conversations[id]?.name || id,
    lastSent: new Date(ts).toISOString(),
    minutesAgo: Math.round((Date.now() - ts) / 60000)
  }));
  res.json({ contacts: status });
});

// ── KEEP-ALIVE ────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("pong"));

// ── SIGNAL DIAGNOSTIC ─────────────────────────────────────────
app.get("/signal-status", async (req, res) => {
  try {
    const about    = await axios.get(`${SIGNAL_CLI_URL}/v1/about`, { timeout: 8000 });
    const accounts = await axios.get(`${SIGNAL_CLI_URL}/v1/accounts`, { timeout: 8000 });
    res.send(`<html><body style="background:#111;color:white;padding:24px;font-family:monospace">
      <h2 style="color:#25D366">📶 Signal Status</h2>
      <p>✅ signal-cli is <strong>alive</strong></p>
      <p>Mode: ${about.data?.mode} v${about.data?.version}</p>
      <p>Accounts: ${JSON.stringify(accounts.data)}</p>
      <p>WS errors: ${signalPollErrors}</p>
    </body></html>`);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;padding:24px;font-family:monospace">
      <h2 style="color:#ff6b6b">❌ Signal CLI unreachable</h2>
      <p>${e.response?.status || ""} ${e.message}</p>
      <p>Poll errors: ${signalPollErrors}</p>
      <p>URL: ${SIGNAL_CLI_URL}</p>
    </body></html>`);
  }
});

// ── BAILEYS PAIRING ───────────────────────────────────────────
app.get("/pair", async (req, res) => {
  try {
    const r = await axios.get("http://localhost:3001/pair?phone=" + (process.env.PHONE_NUMBER || ""));
    res.send(r.data);
  } catch (e) {
    res.send(`<html><body style="background:#111;color:white;padding:30px;font-family:sans-serif">
    <p>Baileys not ready yet — check Render logs for pairing code</p>
    <p style="color:#555">${e.message}</p></body></html>`);
  }
});

function startKeepAlive() {
  if (!RENDER_URL) return;
  setInterval(() => {
    axios.get(`${RENDER_URL}/ping`).catch(() => {});
    axios.get(`${SIGNAL_CLI_URL}/v1/about`).catch(() => {});
  }, 10 * 60 * 1000); // 10 min — safely under Render's 15-min spin-down
  console.log("⏱️  Keep-alive started (every 10 min)");
}

// ── START ─────────────────────────────────────────────────────
server.listen(PORT, async () => {
  await loadConversations();
  await loadBrain();
  await loadPushSubs();
  await ensureMediaBucket();
  await loadExtras();
  await loadWhitelist();
  await loadBlocked();
  await autoFetchVoiceId();
  console.log(`\n🌸 Ariana LIVE on port ${PORT}`);
  console.log(`📱 WhatsApp:    ${KAPSO_API_KEY                   ? "✅" : "❌"}`);
  console.log(`🤖 Groq:        ${GROQ_API_KEY                    ? "✅" : "❌"}`);
  console.log(`🔁 Groq #2:     ${GROQ_API_KEY_2                  ? "✅" : "—"}`);
  console.log(`✨ Gemini:      ${process.env.GEMINI_API_KEY       ? "✅" : "❌"}`);
  console.log(`🔮 DeepSeek:    ${process.env.DEEPSEEK_API_KEY    ? "✅" : "—"}`);
  console.log(`🌬️  Mistral:     ${process.env.MISTRAL_API_KEY     ? "✅" : "—"}`);
  console.log(`🤝 Together:    ${process.env.TOGETHER_API_KEY    ? "✅" : "—"}`);
  const _elevenKey = process.env.ELEVENLABS_API_KEY;
  if (!_elevenKey)      console.log(`🎙️  ElevenLabs:  ❌ ELEVENLABS_API_KEY missing — voice disabled`);
  else if (!cachedVoiceId) console.log(`🎙️  ElevenLabs:  ⚠️  API key ✅ but NO VOICE ID found! Set ELEVENLABS_VOICE_ID in env vars`);
  else                  console.log(`🎙️  ElevenLabs:  ✅ (key: ${_elevenKey.slice(0,10)}... voice: ${cachedVoiceId.slice(0,8)}...)`);
  console.log(`☁️  Cloudinary:  ${process.env.CLOUDINARY_CLOUD_NAME ? "✅" : "❌ voice notes disabled"}`);
  console.log(`📸 Unsplash:    ${process.env.UNSPLASH_ACCESS_KEY ? "✅" : "—"}`);
  console.log(`🔍 Serper:      ${process.env.SERPER_API_KEY      ? "✅" : "—"}`);
  console.log(`📟 Twilio:      ${process.env.TWILIO_ACCOUNT_SID  ? "✅" : "— SMS disabled"}`);
  console.log(`💬 Telegram:    ${TG_SESSION                      ? "✅ session found" : "❌ run gen-session.js"}`);
  console.log(`📶 Signal:      ${SIGNAL_NUMBER                   ? "✅ " + SIGNAL_NUMBER : "❌"}`);
  await initTelegram();
  await setupSignalWebhook();
  startSignalPolling();
  startProactiveMessaging();
  startKeepAlive();
});
