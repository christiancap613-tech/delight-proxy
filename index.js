const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

const CLARI_KEY = process.env.CLARI_KEY || 'lhD8kbRF1C9IyIDf519zJrcyZgyN9PE3e1qKIYTb';
const CLARI_SECRET = process.env.CLARI_SECRET || '88a827b8-2098-4938-92e1-f3e3e6c961bb';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const CLARI_BASE = 'https://rest-api.copilot.clari.com';

const CLARI_HEADERS = {
  'Content-Type': 'application/json',
  'X-Api-Key': CLARI_KEY,
  'X-Api-Password': CLARI_SECRET
};

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Delight Proxy' });
});

// ── DEBUG: See raw call structure ──
app.get('/clari/debug', async (req, res) => {
  try {
    const url = `${CLARI_BASE}/calls?limit=1&filterStatus=POST_PROCESSING_DONE`;
    const response = await fetch(url, { headers: CLARI_HEADERS });
    const text = await response.text();
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLARI: Get users ──
app.get('/clari/users', async (req, res) => {
  try {
    const response = await fetch(`${CLARI_BASE}/users`, { headers: CLARI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: text });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLARI: List calls ──
app.get('/clari/calls', async (req, res) => {
  try {
    const { from, limit = 50, user_id } = req.query;
    let url = `${CLARI_BASE}/calls?limit=${limit}&filterStatus=POST_PROCESSING_DONE&sortTime=desc`;
    if (from) url += `&filterTimeGt=${from}`;
    const response = await fetch(url, { headers: CLARI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: text });
    const data = JSON.parse(text);
    
    // Filter by user_id (Clari user ID) if provided
    if (user_id && data.calls) {
      data.calls = data.calls.filter(call => {
        const participants = call.users || call.participants || call.internal_participants || [];
        return participants.some(p => 
          p.id === user_id || 
          p.user_id === user_id ||
          p.userId === user_id
        );
      });
    }
    
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLARI: Get call details + transcript ──
app.get('/clari/calls/:callId/transcript', async (req, res) => {
  try {
    const url = `${CLARI_BASE}/call-details?id=${req.params.callId}`;
    const response = await fetch(url, { headers: CLARI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: text });
    res.json(JSON.parse(text));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANTHROPIC: AI analysis ──
app.post('/ai/analyze', async (req, res) => {
  try {
    const { system, transcript } = req.body;
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not configured' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system,
        messages: [{ role: 'user', content: `Transcript:\n${transcript}` }]
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Delight proxy running on port ${PORT}`));
