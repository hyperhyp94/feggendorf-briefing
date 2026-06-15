import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBriefing } from './lib/aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// Canonical briefing JSON — this is what the Hermes agent consumes.
app.get('/api/briefing', async (req, res) => {
  try {
    const briefing = await buildBriefing();
    res.set('Cache-Control', 'public, max-age=300'); // 5 min edge cache
    res.json(briefing);
  } catch (e) {
    res.status(502).json({ error: 'briefing build failed', detail: String(e) });
  }
});

// Lightweight health check for the agent / uptime monitors.
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Feggendorf briefing -> http://localhost:${PORT}`);
  console.log(`Agent JSON          -> http://localhost:${PORT}/api/briefing`);
});
