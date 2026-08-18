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

// Breakfast insights via Claude
app.post('/api/insights', async (req, res) => {
  const { history = [], items = {}, kids = [], kidFilter = 'All', timeRange = 'month' } = req.body;

  const dayMs = 24 * 60 * 60 * 1000;
  const daysBack = { week: 7, month: 30, quarter: 90, all: Infinity }[timeRange] || 30;
  const cutoff = daysBack === Infinity ? 0 : Date.now() - daysBack * dayMs;

  let filtered = history.filter(e => e.ts >= cutoff);
  if (kidFilter !== 'All') filtered = filtered.filter(e => e.kid === kidFilter);

  if (!filtered.length) {
    return res.json({ insight: "Not enough data for the selected range yet — keep logging breakfasts and check back soon! 🌟" });
  }

  const lines = filtered.map(entry => {
    const d = new Date(entry.ts).toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    const foods = (entry.itemIds || []).map(id => {
      const info = items[id] || entry.snapshot?.[id] || { name: id };
      const sub = entry.suboptsByItem?.[id];
      return sub ? `${info.name} (${sub})` : info.name;
    }).join(', ');
    return `${entry.kid} - ${d}: ${foods}`;
  }).join('\n');

  const kidLabel = kidFilter === 'All' ? 'the kids' : kidFilter;
  const rangeLabel = { week: 'the past week', month: 'the past month', quarter: 'the past 3 months', all: 'all recorded time' }[timeRange] || 'the past month';

  const prompt = `You are a warm, practical nutritionist helping a parent understand their kids' breakfast habits. Here are the breakfast logs for ${kidLabel} over ${rangeLabel}:\n\n${lines}\n\nPlease provide:\n1. A brief nutritional balance summary (protein, carbs, fruit/veg, dairy, treats — what's well represented and what's missing)\n2. Any interesting trends or patterns you notice\n3. Two or three specific, encouraging suggestions the parent could act on\n\nTone: warm, supportive, practical. Not preachy. Use a parent-friendly voice. Keep it under 280 words. Light emoji use is fine.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ insight: response.content[0].text });
  } catch (err) {
    console.error('Insights error:', err.message);
    res.status(500).json({ error: `Error: ${err.message}` });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Aria is online', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aria server running on port ${PORT}`);
});
