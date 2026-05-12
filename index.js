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
    const { from, user_id } = req.query;
    let allCalls = [];
    let skip = 0;
    const batchSize = 100;
    const maxCalls = 500;

    while (allCalls.length < maxCalls) {
      let url = `${CLARI_BASE}/calls?limit=${batchSize}&skip=${skip}&filterStatus=POST_PROCESSING_DONE&sortTime=desc`;
      if (from) url += `&filterTimeGt=${from}`;
      const response = await fetch(url, { headers: CLARI_HEADERS });
      if (!response.ok) {
        const text = await response.text();
        return res.status(response.status).json({ error: text });
      }
      const data = await response.json();
      const calls = data.calls || [];
      if (!calls.length) break;

      // Filter by userId if provided
      const filtered = user_id
        ? calls.filter(call => (call.users || []).some(u => u.userId === user_id))
        : calls;

      allCalls = allCalls.concat(filtered);

      // Stop if we have enough filtered results or no more pages
      if (!data.pagination?.hasMore || allCalls.length >= 25) break;
      skip += batchSize;
    }

    res.json({ calls: allCalls.slice(0, 25) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DEBUG: See raw call details ──
app.get('/clari/debug-call/:callId', async (req, res) => {
  try {
    const endpoints = [
      `${CLARI_BASE}/call-details?id=${req.params.callId}`,
      `${CLARI_BASE}/call-transcript?callId=${req.params.callId}`,
      `${CLARI_BASE}/transcript?id=${req.params.callId}`,
      `${CLARI_BASE}/calls?id=${req.params.callId}`,
    ];
    const results = {};
    for (const url of endpoints) {
      const response = await fetch(url, { headers: CLARI_HEADERS });
      const text = await response.text();
      results[url] = { status: response.status, body: text.slice(0, 800) };
    }
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLARI: Get call details + transcript ──
app.get('/clari/calls/:callId/transcript', async (req, res) => {
  try {
    // Try transcript endpoint first
    const transcriptUrl = `${CLARI_BASE}/call-transcript?id=${req.params.callId}`;
    const transcriptResp = await fetch(transcriptUrl, { headers: CLARI_HEADERS });
    
    if (transcriptResp.ok) {
      const text = await transcriptResp.text();
      try {
        const data = JSON.parse(text);
        return res.json(data);
      } catch(e) {
        // Return as plain text transcript
        return res.json({ transcript: text });
      }
    }

    // Fallback: try call-details
    const detailsUrl = `${CLARI_BASE}/call-details?id=${req.params.callId}`;
    const detailsResp = await fetch(detailsUrl, { headers: CLARI_HEADERS });
    const detailsText = await detailsResp.text();
    
    if (!detailsResp.ok) return res.status(detailsResp.status).json({ error: detailsText });
    
    const details = JSON.parse(detailsText);
    
    // Try to extract transcript from various possible fields
    const transcript = details.transcript 
      || details.transcription 
      || details.call_transcript
      || (details.utterances && details.utterances.map(u => `${u.speaker||u.name||''}: ${u.text||u.content||''}`).join('\n'))
      || (details.segments && details.segments.map(s => `${s.speaker||''}: ${s.text||''}`).join('\n'));
    
    if (transcript) {
      return res.json({ transcript });
    }
    
    // Return raw so the app can try to parse it
    res.json(details);
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
