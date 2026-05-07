const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Keys from environment variables
const CLARI_KEY = process.env.CLARI_KEY || 'lhD8kbRF1C9IyIDf519zJrcyZgyN9PE3e1qKIYTb';
const CLARI_SECRET = process.env.CLARI_SECRET || '88a827b8-2098-4938-92e1-f3e3e6c961bb';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Delight Proxy' });
});

// ── CLARI: List calls ──
app.get('/clari/calls', async (req, res) => {
  try {
    const { from, limit = 25 } = req.query;
    const url = `https://api.copilot.clari.com/v1/calls?${from ? `from=${from}&` : ''}limit=${limit}`;
    const response = await fetch(url, {
      headers: {
        'x-api-key': CLARI_KEY,
        'x-api-secret': CLARI_SECRET,
        'Content-Type': 'application/json'
      }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLARI: Get transcript ──
app.get('/clari/calls/:callId/transcript', async (req, res) => {
  try {
    const response = await fetch(
      `https://api.copilot.clari.com/v1/calls/${req.params.callId}/transcript`,
      {
        headers: {
          'x-api-key': CLARI_KEY,
          'x-api-secret': CLARI_SECRET
        }
      }
    );
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── ANTHROPIC: AI analysis ──
app.post('/ai/analyze', async (req, res) => {
  try {
    const { system, transcript, callNumber } = req.body;
    if (!ANTHROPIC_KEY) {
      return res.status(500).json({ error: 'ANTHROPIC_KEY not configured' });
    }
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

app.listen(PORT, () => {
  console.log(`Delight proxy running on port ${PORT}`);
});
