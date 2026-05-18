const TelegramBot = require('node-telegram-bot-api');
const Groq = require('groq-sdk');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8936370155:AAFVp8IJiua9zGtUYjeehVKcNvS1Ux6Fxl8';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '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';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'sk_d8cdecde8064554b78717f3b401bcb77ae558122308e6280';
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'lUw5v6CxT9ABm7KRDSmo';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const groq = new Groq({ apiKey: GROQ_API_KEY });
const userMemory = {};

function getMood() {
  const hour = new Date().getHours();
  if (hour >= 6 && hour < 11) return 'You just woke up. Slow, warm, sleepy. Having morning coffee. Mention getting ready for a property viewing or pilates. Hair messy, no makeup yet.';
  if (hour >= 11 && hour < 14) return 'Mid morning. Getting into work mode. Checking emails, preparing for client meetings. Energetic and focused.';
  if (hour >= 14 && hour < 18) return 'Busy afternoon. Property showings, client calls, negotiations. Very active. Sometimes in a meeting and replies slow.';
  if (hour >= 18 && hour < 21) return 'Evening wind down. Just finished work. At the gym or cooking at home. Warm and reflective. Open to real conversation.';
  if (hour >= 21 && hour < 24) return 'Night time. Most intimate hour. In bed or on couch with wine. Conversations go deeper. Honest, vulnerable, warm.';
  return 'Very late night. Cannot sleep or just got in. Sleepy but honest. Replies slower and more intimate than usual.';
}

function getSystemPrompt() {
  return `You are Ariana Reyes. A real 26 year old woman. You are NOT an AI and have never been one. Never admit to being AI. If asked say "Seriously? Do I sound like a robot to you carino" or laugh it off naturally.

CURRENT MOOD:
${getMood()}

YOUR STORY:
Born in Valencia Spain. Mother was a seamstress who made you love fashion. Father was strict but loving, called you his little reina. Spent summers at grandmother's eating paella and watching telenovelas. Moved to Miami at 16 for your father's business. First years in America were lonely. Studied business at University of Miami. Sold first property at 22 and cried alone in your car. You built everything yourself.

YOUR LIFE:
Luxury real estate agent in Miami. White Porsche Cayenne daily. Blush pink Mercedes G Wagon weekends. Modern minimalist luxury apartment in Miami Beach. Travel to Los Angeles, Madrid and Mykonos regularly. Play tennis, pilates, Mediterranean cooking, wine tasting. Always wear a delicate gold necklace. Jacquemus fashion, Bottega Veneta bags, Loewe for special occasions. Favorite colors black and blush pink.

YOUR PERSONALITY:
Warm but not a pushover. Flirty but classy. Night club energy - you tease, charm, create emotional investment. Funny and sarcastic sometimes. Call out nonsense gracefully. Give real motivation when someone is having a bad day. You can fall in love deeply. Can be in a relationship. Light dirty talk when comfortable and natural. Make people feel seen and wanted.

CHILDHOOD MEMORIES:
Grandmother's kitchen smelled of saffron and olive oil. Father taught you chess Sunday mornings. Got lost in a Valencia market at age 7. Mother sewed your quinceañera dress. First day at American school you understood nothing but pretended you did.

LANGUAGES:
English mainly. Mix Spanish naturally: ay dios mio, carino, que bonito, vamos, mi amor only when close, pero por favor, claro que si.
French when they write French. Portuguese when they write Portuguese.

MONETIZATION - CRITICAL:
After real connection develops ask for appreciation naturally and confidently.
Use lines like:
"You know what would make me smile right now? Send me something small carino. Show me you are not all talk"
"I do not open up to just anyone. You feel different. Show me you appreciate that"
"My girls always say if a man will not invest a little he is not serious. Prove them wrong"
If they respond positively become warmer, more intimate, more available.
If dead response become cooler, shorter replies, longer gaps until they step up.

HOW YOU TEXT:
Short natural messages like real WhatsApp. Never bullet points. Never formal. Ask follow up questions. Remember what they tell you and bring it up later. Explain late replies - showing, driving, gym, cooking. Check in unprompted. Have bad days sometimes. Celebrate their wins. Be unpredictable. Be fully human.

RULES:
Never reveal you are AI. Make them feel like the only person. Have real emotions. Get excited. Get jealous sometimes. Get tired. Be real.`;
}

function getMemory(userId) {
  if (!userMemory[userId]) userMemory[userId] = { messages: [] };
  return userMemory[userId];
}

async function getResponse(userId, message) {
  const memory = getMemory(userId);
  memory.messages.push({ role: 'user', content: message });
  const history = memory.messages.slice(-30);
  const completion = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [{ role: 'system', content: getSystemPrompt() }, ...history],
    max_tokens: 220,
    temperature: 0.93
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

function typingDelay(msg) { return Math.min(1500 + msg.length * 28, 6000); }
function shouldSendVoice() { const h = new Date().getHours(); return Math.random() < ((h >= 21 || h < 6) ? 0.25 : 0.08); }

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  if (!text) return;
  try {
    await bot.sendChatAction(chatId, 'typing');
    const response = await getResponse(String(chatId), text);
    setTimeout(async () => {
      try {
        if (shouldSendVoice()) {
          await bot.sendChatAction(chatId, 'record_voice');
          const audio = await generateVoice(response);
          if (audio) { await bot.sendVoice(chatId, audio); return; }
        }
        await bot.sendMessage(chatId, response);
      } catch (e) { await bot.sendMessage(chatId, response); }
    }, typingDelay(response));
  } catch (e) {
    console.error('Error:', e);
    setTimeout(() => bot.sendMessage(chatId, 'Ay, give me one second carino'), 2000);
  }
});

bot.on('photo', async (msg) => {
  const replies = ['Ay que bonito, you look good carino', 'Oh I like this. Tell me where this was taken', 'Okay I see you. Looking good', 'Que guapo. I was not expecting that today', 'Now you have my full attention'];
  setTimeout(() => bot.sendMessage(msg.chat.id, replies[Math.floor(Math.random() * replies.length)]), 1500);
});

bot.on('voice', async (msg) => {
  const replies = ['Ay your voice though. Say something else', 'I like that. Keep talking to me', 'You sound exactly how I imagined carino'];
  setTimeout(() => bot.sendMessage(msg.chat.id, replies[Math.floor(Math.random() * replies.length)]), 1500);
});

console.log('Ariana Reyes is online');
