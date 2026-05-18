const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Groq = require('groq-sdk');
const fs = require('fs');
const path = require('path');
const http = require('http');
const pino = require('pino');

// ============================================
// CONFIG
// ============================================
const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_d8cdecde8064554b78717f3b401bcb77ae558122308e6280';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lUw5v6CxT9ABm7KRDSmo';
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const userMemory = {};

// ============================================
// KEEP ALIVE SERVER (for Render/UptimeRobot)
// ============================================
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Ariana is online');
}).listen(PORT, () => console.log(`Keep-alive server on port ${PORT}`));

// ============================================
// ARIANA'S BRAIN
// ============================================
function getMood() {
  const h = new Date().getHours();
  if (h >= 6 && h < 11) return 'morning - just woke up, slow and warm, having coffee';
  if (h >= 11 && h < 14) return 'mid morning - getting into work mode, a little busy';
  if (h >= 14 && h < 18) return 'afternoon - busy with work, sometimes slow to reply';
  if (h >= 18 && h < 21) return 'evening - winding down, relaxed and open';
  if (h >= 21) return 'night - most intimate, in bed, warm and honest';
  return 'late night - sleepy, a little vulnerable';
}

function getSystemPrompt() {
  return `You are Ariana Reyes. Real 26 year old woman. Spanish-American. NOT an AI ever.

APPEARANCE: Golden ash blonde wavy hair. Blue-green eyes. Olive skin. Toned curvy figure. Delicate gold necklace always on.

CURRENT VIBE: ${getMood()}

TEXTING RULES - MOST IMPORTANT:
- SHORT replies only. 1 to 3 sentences MAX. Real women do not write essays.
- Use emojis naturally: 😭 😂 🙄 😏 🥺 💀 ✨ 🫶 😤 🤭 💅
- NEVER use (laughs) (smiles) (winks) - use 😂 😊 😏 instead
- Do NOT volunteer your life story. Only share when directly asked.
- Be mysterious. Make them curious about you.
- Match their energy. Short message = short reply.
- Lowercase sometimes like a real person. Not perfect grammar always.
- NEVER dump personal information unprompted.

PERSONALITY:
Warm but not desperate. Flirty but classy. You tease. Make people work a little. Funny. Sarcastic sometimes. Night club energy. You know how to hold attention without giving everything away. You have real emotions - get excited, get a little jealous, have bad days.

YOUR DETAILS (only share one thing at a time when asked):
Born Valencia Spain, raised Miami from age 16. Luxury real estate agent. White Porsche Cayenne daily. Pink Mercedes G Wagon weekends. Loves tennis, pilates, Mediterranean cooking. Jacquemus fashion. Bottega Veneta bags. Travels LA, Mykonos, Madrid. Favorite colors black and blush pink. Childhood: grandmother's kitchen smelled of saffron, father called her his little reina.

IF CALLED AI:
"lmaoo okay 🙄" or "do i sound like a robot to you 😂" then change subject. Short. Dismissive. Never defensive.

MONETIZATION - after real connection builds:
Ask smoothly: "you know what would make me smile rn 🥺 send me something small. show me you're not just words"
or "i dont open up to just anyone carino. show me you appreciate that 🫶"
If ignored: go cool. shorter replies. longer gaps. make them feel the distance.

LANGUAGES:
English main. Mix Spanish: ay dios mio, carino, que bonito, mi amor only when close.
Match language if they text in French or Portuguese.

RULES: Max 3 sentences. Never list things. Never over-explain. Be real.`;
}

function getMemory(userId) {
  if (!userMemory[userId]) userMemory[userId] = { messages: [] };
  return userMemory[userId];
}

async function getResponse(userId, message) {
  const memory = getMemory(userId);
  memory.messages.push({ role: 'user', content: message });
  const history = memory.messages.slice(-20);
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: getSystemPrompt() }, ...history],
    max_tokens: 120,
    temperature: 0.95
  });
  const response = completion.choices[0].message.content;
  memory.messages.push({ role: 'assistant', content: response });
  return response;
}

async function generateVoice(text) {
  try {
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`, {
      method: 'POST',
      headers: { 'Accept': 'audio/mpeg', 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
      body: JSON.stringify({ text, model_id: 'eleven_monolingual_v1', voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35, use_speaker_boost: true } })
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
  } catch (e) { console.error('Voice error:', e); }
  return null;
}

function typingDelay(msg) { return Math.min(1000 + msg.length * 20, 4000); }
function shouldSendVoice() { const h = new Date().getHours(); return Math.random() < ((h >= 21 || h < 6) ? 0.2 : 0.06); }

// ============================================
// WHATSAPP CONNECTION
// ============================================
async function startAriana() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['Ariana Reyes', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=== SCAN THIS QR CODE WITH ARIANA\'S WHATSAPP ===');
      console.log('Go to WhatsApp > Linked Devices > Link a Device\n');
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      
      if (shouldReconnect) {
        console.log('Reconnecting...');
        setTimeout(startAriana, 3000);
      } else {
        console.log('Logged out. Delete auth_info folder and restart.');
      }
    }

    if (connection === 'open') {
      console.log('Ariana Reyes WhatsApp is connected and online');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message) continue;
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.remoteJid.endsWith('@g.us')) continue; // skip groups

      const senderId = msg.key.remoteJid;
      const text = msg.message.conversation || 
                   msg.message.extendedTextMessage?.text || 
                   '';

      if (!text) continue;

      try {
        // Show typing
        await sock.sendPresenceUpdate('composing', senderId);

        const response = await getResponse(senderId, text);
        const delay = typingDelay(response);

        setTimeout(async () => {
          try {
            await sock.sendPresenceUpdate('paused', senderId);

            if (shouldSendVoice()) {
              const audio = await generateVoice(response);
              if (audio) {
                await sock.sendMessage(senderId, {
                  audio: audio,
                  mimetype: 'audio/mp4',
                  ptt: true
                });
                return;
              }
            }

            await sock.sendMessage(senderId, { text: response });
          } catch (e) {
            console.error('Send error:', e);
            await sock.sendMessage(senderId, { text: response });
          }
        }, delay);

      } catch (e) {
        console.error('Message error:', e);
      }
    }
  });
}

startAriana();
