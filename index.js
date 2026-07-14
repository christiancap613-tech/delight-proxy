const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const Busboy = require('busboy');

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
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Delight Proxy' });
});

// ── CLARI routes (unchanged) ──
app.get('/clari/debug', async (req, res) => {
  try {
    const url = `${CLARI_BASE}/calls?limit=1&filterStatus=POST_PROCESSING_DONE`;
    const response = await fetch(url, { headers: CLARI_HEADERS });
    const text = await response.text();
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/clari/users', async (req, res) => {
  try {
    const response = await fetch(`${CLARI_BASE}/users`, { headers: CLARI_HEADERS });
    const text = await response.text();
    if (!response.ok) return res.status(response.status).json({ error: text });
    res.json(JSON.parse(text));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
      const filtered = user_id
        ? calls.filter(call => (call.users || []).some(u => u.userId === user_id))
        : calls;
      allCalls = allCalls.concat(filtered);
      if (!data.pagination?.hasMore || allCalls.length >= 25) break;
      skip += batchSize;
    }
    res.json({ calls: allCalls.slice(0, 25) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/clari/calls/:callId/transcript', async (req, res) => {
  try {
    const transcriptUrl = `${CLARI_BASE}/call-transcript?id=${req.params.callId}`;
    const transcriptResp = await fetch(transcriptUrl, { headers: CLARI_HEADERS });
    if (transcriptResp.ok) {
      const text = await transcriptResp.text();
      try { return res.json(JSON.parse(text)); } catch(e) { return res.json({ transcript: text }); }
    }
    const detailsUrl = `${CLARI_BASE}/call-details?id=${req.params.callId}`;
    const detailsResp = await fetch(detailsUrl, { headers: CLARI_HEADERS });
    const detailsText = await detailsResp.text();
    if (!detailsResp.ok) return res.status(detailsResp.status).json({ error: detailsText });
    const details = JSON.parse(detailsText);
    const transcript = details.transcript || details.transcription || details.call_transcript
      || (details.utterances && details.utterances.map(u => `${u.speaker||u.name||''}: ${u.text||u.content||''}`).join('\n'))
      || (details.segments && details.segments.map(s => `${s.speaker||''}: ${s.text||''}`).join('\n'));
    if (transcript) return res.json({ transcript });
    res.json(details);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANTHROPIC: AI analysis (scoring app) ──
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ANTHROPIC: Pipeline review via multipart upload ──
// Accepts multipart/form-data with fields: system (string), files (PDF buffers)
app.post('/anthropic/pipeline', (req, res) => {
  if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not configured' });

  const busboy = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } });
  let systemPrompt = '';
  const fileBuffers = [];
  const fileNames = [];

  busboy.on('field', (name, val) => {
    if (name === 'system') systemPrompt = val;
  });

  busboy.on('file', (name, file, info) => {
    const chunks = [];
    fileNames.push(info.filename);
    file.on('data', chunk => chunks.push(chunk));
    file.on('end', () => fileBuffers.push(Buffer.concat(chunks)));
  });

  busboy.on('finish', async () => {
    try {
      const contentBlocks = fileBuffers.map((buf, i) => ({
        type: 'document',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          data: buf.toString('base64')
        },
        title: fileNames[i] || `document-${i}`
      }));

      contentBlocks.push({
        type: 'text',
        text: 'Analyze all attached Salesforce opportunity documents and return the pipeline review JSON.'
      });

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'pdfs-2024-09-25'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{ role: 'user', content: contentBlocks }]
        })
      });

      const data = await response.json();
      res.json(data);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  req.pipe(busboy);
});

// ── ANTHROPIC: Legacy JSON passthrough (kept for compatibility) ──
app.post('/anthropic', async (req, res) => {
  try {
    if (!ANTHROPIC_KEY) return res.status(500).json({ error: 'ANTHROPIC_KEY not configured' });
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'pdfs-2024-09-25'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const server = app.listen(PORT, () => console.log(`Delight proxy running on port ${PORT}`));
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use, retrying...`);
    setTimeout(() => server.listen(PORT), 1000);
  } else {
    throw err;
  }
});
