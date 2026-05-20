const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Groq = require('groq-sdk');
const http = require('http');
const qrcode = require('qrcode');
const pino = require('pino');
const { createClient } = require('@supabase/supabase-js');
const { useSupabaseAuthState } = require('./supabase-auth');
const { buildSystemPrompt, getReplyDelay } = require('./brain/engine');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_d8cdecde8064554b78717f3b401bcb77ae558122308e6280';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lUw5v6CxT9ABm7KRDSmo';
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: GROQ_API_KEY });
const userMemory = {};
let currentQR = null;
let isConnected = false;
let sockGlobal = null;
let pairingCode = null;

// ============================================
// WEB SERVER - QR + Phone number pairing
// ============================================
http.createServer(async (req, res) => {

  // QR code page
  if (req.url === '/qr') {
    if (currentQR) {
      const qrImage = await qrcode.toDataURL(currentQR);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Ariana QR</title>
        <style>body{background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:white}
        img{width:260px;height:260px;background:white;padding:16px;border-radius:12px}
        p{color:#aaa;text-align:center;padding:0 20px;font-size:14px}
        h2{color:#25D366}a{color:#25D366;font-size:16px;margin-top:16px;display:block;text-align:center}</style>
        </head><body>
        <h2>Scan QR Code</h2>
        <img src="${qrImage}"/>
        <p>WhatsApp > Linked Devices > Link a Device > Scan</p>
        <p style="color:#555;font-size:12px">Refresh page if code expired</p>
        <a href="/">Back</a>
        </body></html>
      `);
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#111;color:white;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh"><p>QR not ready yet. Refresh in a moment.</p></body></html>');
    }
    return;
  }

  // Request pairing code via phone number
  if (req.url.startsWith('/pair?phone=')) {
    const phone = req.url.split('phone=')[1].replace(/\D/g, '');
    if (sockGlobal && phone) {
      try {
        const code = await sockGlobal.requestPairingCode(phone);
        pairingCode = code;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
          <title>Pairing Code</title>
          <style>body{background:#111;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;font-family:sans-serif;color:white}
          .code{font-size:48px;font-weight:bold;color:#25D366;letter-spacing:8px;margin:20px 0;background:#1a1a1a;padding:20px 30px;border-radius:12px}
          p{color:#aaa;text-align:center;padding:0 20px;font-size:14px}h2{color:#25D366}</style>
          </head><body>
          <h2>Your Pairing Code</h2>
          <div class="code">${code}</div>
          <p>Open WhatsApp on Ariana's phone</p>
          <p>Go to: <strong style="color:white">Linked Devices > Link a Device > Link with phone number</strong></p>
          <p>Enter this code when prompted</p>
          <p style="color:#555;font-size:12px">Code expires in a few minutes</p>
          </body></html>
        `);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<html><body style="background:#111;color:white;padding:20px;font-family:sans-serif"><p>Error: ${e.message}</p><p>Make sure the phone number includes country code. Example: 2348012345678</p></body></html>`);
      }
    } else {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#111;color:white;padding:20px;font-family:sans-serif"><p>Bot not ready yet. Try again in a moment.</p></body></html>');
    }
    return;
  }

  // Home page
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Ariana Reyes</title>
    <style>body{background:#111;color:white;font-family:sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;box-sizing:border-box}
    h2{color:#25D366;text-align:center}
    .status{font-size:18px;margin:10px 0;text-align:center}
    .card{background:#1a1a1a;border-radius:12px;padding:20px;margin:12px 0;width:100%;max-width:360px;box-sizing:border-box}
    h3{color:#25D366;margin-top:0}
    input{width:100%;padding:12px;border-radius:8px;border:1px solid #333;background:#222;color:white;font-size:16px;box-sizing:border-box;margin:8px 0}
    button{width:100%;padding:12px;border-radius:8px;border:none;background:#25D366;color:white;font-size:16px;cursor:pointer;margin-top:8px}
    a{color:#25D366;text-decoration:none;display:block;text-align:center;margin-top:8px;font-size:15px}</style>
    </head><body>
    <h2>Ariana Reyes Bot</h2>
    <div class="status">${isConnected ? '🟢 WhatsApp Connected' : '🔴 Not Connected'}</div>

    ${!isConnected ? `
    <div class="card">
      <h3>Option 1 - Phone Number</h3>
      <p style="color:#aaa;font-size:14px">No QR scan needed. Enter Ariana's WhatsApp number with country code.</p>
      <input type="tel" id="phone" placeholder="e.g. 2348012345678" />
      <button onclick="getPairingCode()">Get Pairing Code</button>
    </div>

    <div class="card">
      <h3>Option 2 - QR Code</h3>
      <p style="color:#aaa;font-size:14px">Open WhatsApp > Linked Devices > Link a Device > Scan QR</p>
      <a href="/qr">View QR Code</a>
    </div>
    ` : '<div class="card"><p style="color:#aaa;text-align:center">Ariana is active and responding to messages 🎉</p></div>'}

    <script>
    function getPairingCode() {
      const phone = document.getElementById('phone').value.replace(/\D/g,'');
      if (!phone) { alert('Enter a phone number'); return; }
      window.location.href = '/pair?phone=' + phone;
    }
    </script>
    </body></html>
  `);

}).listen(PORT, () => console.log(`Server on port ${PORT}`));

// ============================================
// ARIANA BRAIN
// ============================================
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
  } catch (e) {}
  return null;
}

function shouldSendVoice() {
  const h = new Date().getHours();
  return Math.random() < ((h >= 21 || h < 6) ? 0.2 : 0.06);
}

// ============================================
// WHATSAPP
// ============================================
async function startAriana() {
  const { state, saveCreds } = await useSupabaseAuthState(supabase);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Ariana Reyes', 'Chrome', '1.0.0'],
    usePairingCode: true
  });

  sockGlobal = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { currentQR = qr; isConnected = false; }
    if (connection === 'close') {
      isConnected = false;
      sockGlobal = null;
      const shouldReconnect = (lastDisconnect?.error instanceof Boom) &&
        lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(startAriana, 3000);
      else console.log('Logged out. Delete auth_info folder and restart.');
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
