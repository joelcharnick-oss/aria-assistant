const express = require('express');
const path = require('path');
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

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Aria is online', time: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Aria server running on port ${PORT}`);
});
