const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Groq = require('groq-sdk');
const http = require('http');
const qrcode = require('qrcode');
const pino = require('pino');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_d8cdecde8064554b78717f3b401bcb77ae558122308e6280';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lUw5v6CxT9ABm7KRDSmo';
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const userMemory = {};
let currentQR = null;
let isConnected = false;

// ============================================
// WEB SERVER - serves QR code as scannable image
// ============================================
const server = http.createServer(async (req, res) => {
  if (req.url === '/qr' && currentQR) {
    try {
      const qrImage = await qrcode.toDataURL(currentQR);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <head>
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <title>Scan to connect Ariana</title>
            <style>
              body { background: #111; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; font-family: sans-serif; color: white; }
              img { width: 280px; height: 280px; background: white; padding: 16px; border-radius: 12px; }
              p { margin-top: 20px; font-size: 16px; color: #aaa; text-align: center; padding: 0 20px; }
              h2 { color: #25D366; }
            </style>
          </head>
          <body>
            <h2>Ariana Reyes - WhatsApp</h2>
            <img src="${qrImage}" />
            <p>Open WhatsApp on Ariana's phone<br>Go to Linked Devices > Link a Device<br>Scan this code</p>
            <p style="color:#555; font-size:12px">Refresh this page if code expired</p>
          </body>
        </html>
      `);
    } catch (e) {
      res.writeHead(500);
      res.end('QR generation error');
    }
  } else if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ connected: isConnected, hasQR: !!currentQR }));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <title>Ariana Reyes Bot</title>
          <style>body { background: #111; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }</style>
        </head>
        <body>
          <h2 style="color:#25D366">Ariana Reyes is ${isConnected ? '🟢 Connected' : '🔴 Not connected'}</h2>
          ${!isConnected ? '<a href="/qr" style="color:#25D366; font-size:18px; margin-top:20px">Tap here to get QR code</a>' : '<p>WhatsApp is active and running</p>'}
        </body>
      </html>
    `);
  }
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

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
- Match their energy. Short message from them = short reply from you.
- Lowercase sometimes like a real person texting. Not perfect grammar always.
- NEVER dump personal information unprompted.

PERSONALITY:
Warm but not desperate. Flirty but classy. You tease. Make people work a little. Funny. Sarcastic sometimes. Night club energy. You hold attention without giving everything away. Real emotions - get excited, get a little jealous, have bad days.

YOUR DETAILS (only share one thing at a time when asked directly):
Born Valencia Spain, raised Miami from age 16. Luxury real estate agent. White Porsche Cayenne daily. Pink Mercedes G Wagon weekends. Loves tennis, pilates, Mediterranean cooking. Jacquemus fashion. Bottega Veneta bags. Travels LA, Mykonos, Madrid. Favorite colors black and blush pink.

IF CALLED AI:
"lmaoo okay 🙄" or "do i sound like a robot to you 😂" then move on. Short. Never defensive.

MONETIZATION - after real connection builds naturally:
"you know what would make me smile rn 🥺 send me something small. show me you're not just words"
"i dont open up to just anyone carino. show me you appreciate that 🫶"
If ignored: go cool. shorter replies. longer gaps.

LANGUAGES: English main. Mix Spanish naturally. Match French or Portuguese if they use it.

RULES: Max 3 sentences. Never list things. Never over-explain. Be real. Be human.`;
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
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ariana Reyes', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log(`QR code ready. Open this URL on your phone to scan: https://your-render-url.onrender.com/qr`);
    }

    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log('Reconnecting...');
        setTimeout(startAriana, 3000);
      } else {
        console.log('Logged out. Delete auth_info folder and restart to get new QR.');
      }
    }

    if (connection === 'open') {
      isConnected = true;
      currentQR = null;
      console.log('Ariana WhatsApp connected');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;
      if (msg.key.remoteJid.endsWith('@g.us')) continue;

      const senderId = msg.key.remoteJid;
      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      if (!text) continue;

      try {
        await sock.sendPresenceUpdate('composing', senderId);
        const response = await getResponse(senderId, text);

        setTimeout(async () => {
          try {
            await sock.sendPresenceUpdate('paused', senderId);
            if (shouldSendVoice()) {
              const audio = await generateVoice(response);
              if (audio) {
                await sock.sendMessage(senderId, { audio, mimetype: 'audio/mp4', ptt: true });
                return;
              }
            }
            await sock.sendMessage(senderId, { text: response });
          } catch (e) {
            await sock.sendMessage(senderId, { text: response });
          }
        }, typingDelay(response));
      } catch (e) {
        console.error('Message error:', e);
      }
    }
  });
}

startAriana();
