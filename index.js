const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');
const { buildSystemPrompt, getReplyDelay } = require('./brain/engine');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8936370155:AAFVp8IJiua9zGtUYjeehVKcNvS1Ux6Fxl8';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_d8cdecde8064554b78717f3b401bcb77ae558122308e6280';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lUw5v6CxT9ABm7KRDSmo';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });
const userMemory = {};

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

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;
  try {
    await bot.sendChatAction(chatId, 'typing');
    const response = await getResponse(String(chatId), text);
    const delay = getReplyDelay(String(chatId), text.length);
    setTimeout(async () => {
      try {
        if (shouldSendVoice()) {
          await bot.sendChatAction(chatId, 'record_voice');
          const audio = await generateVoice(response);
          if (audio) { await bot.sendVoice(chatId, audio); return; }
        }
        await bot.sendMessage(chatId, response);
      } catch (e) { await bot.sendMessage(chatId, response); }
    }, delay);
  } catch (e) {
    console.error('Error:', e);
    setTimeout(() => bot.sendMessage(chatId, 'one sec 😭'), 2000);
  }
});

bot.on('photo', async (msg) => {
  const replies = ['okay i see you 👀', 'not bad at all 😏', 'you look good ✨', 'i was not expecting that 😭', 'now you have my attention'];
  setTimeout(() => bot.sendMessage(msg.chat.id, replies[Math.floor(Math.random() * replies.length)]), 1500);
});

bot.on('voice', async (msg) => {
  const replies = ['your voice though 😭', 'okay keep talking to me', 'i like that 🥺'];
  setTimeout(() => bot.sendMessage(msg.chat.id, replies[Math.floor(Math.random() * replies.length)]), 1500);
});

console.log('Ariana Reyes - Telegram online');
