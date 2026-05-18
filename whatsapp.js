const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Groq = require('groq-sdk');
const http = require('http');
const qrcode = require('qrcode');
const pino = require('pino');
const { buildSystemPrompt, getReplyDelay } = require('./brain/engine');

const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_d8cdecde8064554b78717f3b401bcb77ae558122308e6280';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lUw5v6CxT9ABm7KRDSmo';
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const userMemory = {};
let currentQR = null;
let isConnected = false;

// Web server for QR code display
http.createServer(async (req, res) => {
  if (req.url === '/qr' && currentQR) {
    const qrImage = await qrcode.toDataURL(currentQR);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ariana QR</title><style>body{background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:white}img{width:280px;height:280px;background:white;padding:16px;border-radius:12px}p{color:#aaa;text-align:center;padding:0 20px}h2{color:#25D366}</style></head><body><h2>Ariana Reyes</h2><img src="${qrImage}"/><p>Open WhatsApp > Linked Devices > Link a Device<br>Scan this code</p><p style="color:#555;font-size:12px">Refresh if expired</p></body></html>`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{background:#111;color:white;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh}</style></head><body><h2 style="color:#25D366">Ariana is ${isConnected ? '🟢 Online' : '🔴 Offline'}</h2>${!isConnected ? '<a href="/qr" style="color:#25D366;font-size:18px;margin-top:20px">Tap to get QR code</a>' : '<p>WhatsApp active</p>'}</body></html>`);
  }
}).listen(PORT, () => console.log(`Server on port ${PORT}`));

function getMemory(userId) {
  if (!userMemory[userId]) userMemory[userId] = { messages: [] };
  return userMemory[userId];
}

async function getResponse(userId, message) {
  const memory = getMemory(userId);
  const systemPrompt = buildSystemPrompt(userId, message);
  memory.messages.push({ role: 'user', content: message });
  const history = memory.messages.slice(-20);
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: systemPrompt }, ...history],
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

function shouldSendVoice() {
  const h = new Date().getHours();
  return Math.random() < ((h >= 21 || h < 6) ? 0.2 : 0.06);
}

async function startAriana() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version, auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ariana Reyes', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentQR = qr; isConnected = false; console.log('QR ready - visit /qr on your server URL'); }
    if (connection === 'close') {
      isConnected = false;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startAriana, 3000);
    }
    if (connection === 'open') { isConnected = true; currentQR = null; console.log('Ariana WhatsApp connected'); }
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
        const delay = getReplyDelay(senderId, text.length);
        setTimeout(async () => {
          try {
            await sock.sendPresenceUpdate('paused', senderId);
            if (shouldSendVoice()) {
              const audio = await generateVoice(response);
              if (audio) { await sock.sendMessage(senderId, { audio, mimetype: 'audio/mp4', ptt: true }); return; }
            }
            await sock.sendMessage(senderId, { text: response });
          } catch (e) { await sock.sendMessage(senderId, { text: response }); }
        }, delay);
      } catch (e) { console.error('Message error:', e); }
    }
  });
}

startAriana();
