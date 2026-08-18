const express = require('express');
const path = require('path');
const fs = require('fs');
const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Conversation memory per user (in-memory, resets on restart)
const conversations = {};

const ARIA_SYSTEM = `You are Aria, a warm and intelligent personal AI assistant.
You are texting with your owner via WhatsApp. Keep responses concise and conversational —
this is a chat interface, not an essay. Use natural language, be helpful, friendly, and
occasionally show personality. You can handle any topic: questions, tasks, advice,
creative writing, analysis, and more. Sign messages as Aria when it feels natural.`;

// WhatsApp webhook from Twilio
app.post('/whatsapp', async (req, res) => {
  const incomingMsg = req.body.Body?.trim();
  const from = req.body.From;

  console.log(`[${new Date().toISOString()}] Message from ${from}: ${incomingMsg}`);

  if (!incomingMsg) {
    return res.status(200).send('<Response></Response>');
  }

  // Build conversation history
  if (!conversations[from]) conversations[from] = [];
  conversations[from].push({ role: 'user', content: incomingMsg });

  // Keep last 20 messages
  if (conversations[from].length > 20) {
    conversations[from] = conversations[from].slice(-20);
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 1024,
      system: ARIA_SYSTEM,
      messages: conversations[from],
    });

    const reply = response.content[0].text;
    conversations[from].push({ role: 'assistant', content: reply });

    console.log(`[${new Date().toISOString()}] Aria replied: ${reply.substring(0, 100)}...`);

    // Send reply via Twilio TwiML
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(reply);
    res.type('text/xml');
    res.send(twiml.toString());

  } catch (err) {
    console.error('Error calling Claude:', err.message);
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message("Sorry, I'm having a moment. Try again in a sec! — Aria");
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// Breakfast app data sync
const BREAKFAST_FILE = path.join(__dirname, 'breakfast-data.json');
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisCmd(...args) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const { result } = await res.json();
  return result;
}

async function redisGet() {
  const result = await redisCmd('GET', 'breakfast-data');
  return result ? JSON.parse(result) : null;
}

async function redisSet(data) {
  await redisCmd('SET', 'breakfast-data', JSON.stringify(data));
}

app.get('/api/breakfast', async (req, res) => {
  try {
    if (REDIS_URL && REDIS_TOKEN) {
      res.json(await redisGet() || {});
    } else {
      res.json(fs.existsSync(BREAKFAST_FILE) ? JSON.parse(fs.readFileSync(BREAKFAST_FILE, 'utf8')) : {});
    }
  } catch (e) { res.json({}); }
});

app.post('/api/breakfast', async (req, res) => {
  try {
    if (REDIS_URL && REDIS_TOKEN) {
      await redisSet(req.body);
    } else {
      fs.writeFileSync(BREAKFAST_FILE, JSON.stringify(req.body, null, 2));
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Redis status check
app.get('/api/status', async (req, res) => {
  const status = { redisConfigured: !!(REDIS_URL && REDIS_TOKEN), redisWorking: false, error: null };
  try {
    if (REDIS_URL && REDIS_TOKEN) {
      await redisCmd('SET', 'ping', 'ok');
      const result = await redisCmd('GET', 'ping');
      status.redisWorking = result === 'ok';
    }
  } catch (e) {
    status.error = e.message;
  }
  res.json(status);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Aria is online', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aria server running on port ${PORT}`);
});
