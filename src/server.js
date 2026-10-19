// Dashboard + API + in-process daily scheduler.   npm start → http://localhost:3020
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { channel, saveChannel, env, ROOT, RUNS, bins } from './config.js';
import { db, getRun, kvGet } from './db.js';
import { runPipeline, todaysRun, newRunId } from './pipeline.js';
import { authUrl, exchangeCode, isConnected, channelInfo, nextSlot } from './youtube.js';
import { recentTopics } from './dedup.js';

const app = express();
const PORT = +env('PORT', '3020');
app.use(express.json({ limit: '2mb' }));

// Optional basic auth (set DASHBOARD_PASSWORD when exposing beyond localhost)
app.use((req, res, next) => {
  const pw = env('DASHBOARD_PASSWORD');
  if (!pw || req.path.startsWith('/oauth/callback')) return next();
  const [, b64] = (req.headers.authorization || '').split(' ');
  const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
  if (pass === pw) return next();
  res.set('WWW-Authenticate', 'Basic realm="studio"').status(401).end('auth required');
});
app.use(express.static(path.join(ROOT, 'public')));

let current = null; // { runId, stage, promise }
function start(opts = {}) {
  if (current) throw new Error(`a run is already in progress (${current.runId})`);
  const runId = opts.runId || newRunId();
  current = { runId, stage: 'starting' };
  current.promise = runPipeline({ ...opts, runId, onStage: s => { if (current) current.stage = s; } })
    .catch(() => {}).finally(() => { current = null; });
  return runId;
}

function nextRunLocal() {
  const [h, m] = channel().schedule.runAtLocal.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d < new Date() || todaysRun()) d.setDate(d.getDate() + 1);
  return d.toISOString();
}

// ---------- API ----------
app.get('/api/status', async (req, res) => {
  const cfg = channel();
  res.json({
    running: current ? { runId: current.runId, stage: current.stage }
      : (l => l && Date.now() - l.at < 3 * 3600_000 ? { runId: l.runId, stage: getRun(l.runId)?.stage || 'running', external: true } : null)(kvGet('lock')),
    nextRun: nextRunLocal(), nextPublish: nextSlot(cfg.schedule.publishAtUTC, cfg.schedule.leadDays),
    youtube: { connected: isConnected(), channel: kvGet('youtube_channel'), configured: !!(env('YOUTUBE_CLIENT_ID') && env('YOUTUBE_CLIENT_SECRET')) },
    checks: {
      claude: !!bins.claude, claudeToken: !!env('CLAUDE_CODE_OAUTH_TOKEN'), chrome: !!bins.chrome,
      pexels: !!(env('PIXABAY_API_KEY') || env('PEXELS_API_KEY')), fonts: fs.existsSync(path.join(ROOT, 'engines', 'fonts', 'fonts.css')),
    },
    totals: db.prepare("SELECT COUNT(*) n, SUM(status='done') done, SUM(status='failed') failed, SUM(youtube_id IS NOT NULL) uploaded FROM runs").get(),
    recentTopics: recentTopics(cfg.variety.dedupDays).length,
  });
});
app.get('/api/runs', (req, res) => res.json(db.prepare('SELECT id, created_at, status, stage, topic, style, title, duration, youtube_id, publish_at, error FROM runs ORDER BY created_at DESC LIMIT 100').all()));
app.get('/api/runs/:id', (req, res) => {
  const r = getRun(req.params.id); if (!r) return res.status(404).end();
  const dir = path.join(RUNS, r.id);
  const plan = fs.existsSync(path.join(dir, 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) : null;
  const logs = db.prepare('SELECT at, level, msg FROM logs WHERE run_id = ? ORDER BY id').all(r.id);
  res.json({ ...r, plan, logs, hasSheet: fs.existsSync(path.join(dir, 'sheet.jpg')), hasVideo: fs.existsSync(path.join(dir, 'final.mp4')) });
});
app.get('/media/:id/:file', (req, res) => {
  if (!/^[\w-]+$/.test(req.params.id) || !['final.mp4', 'sheet.jpg'].includes(req.params.file)) return res.status(400).end();
  const f = path.join(RUNS, req.params.id, req.params.file);
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).end();
});
app.post('/api/run', (req, res) => {
  try { res.json({ runId: start({ upload: req.body?.upload, style: req.body?.style || undefined }) }); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/runs/:id/retry', (req, res) => {
  try { res.json({ runId: start({ runId: req.params.id, upload: req.body?.upload }) }); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/runs/:id/upload', (req, res) => {
  const r = getRun(req.params.id);
  if (!r || r.status !== 'done' || r.youtube_id) return res.status(400).json({ error: 'nothing to upload' });
  // re-open the run with the upload stage cleared
  const sf = path.join(RUNS, r.id, 'state.json'), st = JSON.parse(fs.readFileSync(sf, 'utf8'));
  st.done = st.done.filter(s => s !== 'upload'); fs.writeFileSync(sf, JSON.stringify(st));
  try { res.json({ runId: start({ runId: r.id, upload: true }) }); } catch (e) { res.status(409).json({ error: e.message }); }
});
app.get('/api/config', (req, res) => res.json(channel()));
app.put('/api/config', (req, res) => {
  const c = req.body;
  if (!c?.niche || !c?.video || !c?.styles || !c?.schedule) return res.status(400).json({ error: 'invalid config' });
  saveChannel(c); res.json({ ok: true });
});

// ---------- YouTube OAuth (Desktop client: any localhost redirect works) ----------
const redirect = req => `http://localhost:${PORT}/oauth/callback`;
app.get('/oauth/start', (req, res) => {
  if (!env('YOUTUBE_CLIENT_ID')) return res.status(400).send('Set YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET in .env first.');
  res.redirect(authUrl(redirect(req)));
});
app.get('/oauth/callback', async (req, res) => {
  try { const ch = await exchangeCode(String(req.query.code), redirect(req)); res.send(`<p style="font-family:sans-serif">Connected to <b>${ch?.title || 'your channel'}</b>. You can close this tab.</p><script>setTimeout(()=>location='/',1500)</script>`); }
  catch (e) { res.status(500).send(`OAuth error: ${e.message}`); }
});
app.post('/api/youtube/refresh', async (req, res) => { try { res.json(await channelInfo()); } catch (e) { res.status(400).json({ error: e.message }); } });

// ---------- scheduler: once per day at runAtLocal ----------
let warned = false;
setInterval(() => {
  if (current || todaysRun() || channel().schedule.enabled === false) return;
  if (!env('CLAUDE_CODE_OAUTH_TOKEN') && !warned) { warned = true; console.warn('scheduler: CLAUDE_CODE_OAUTH_TOKEN not set — automatic runs are paused'); }
  if (!env('CLAUDE_CODE_OAUTH_TOKEN')) return;
  const [h, m] = channel().schedule.runAtLocal.split(':').map(Number);
  const nowD = new Date();
  if (nowD.getHours() * 60 + nowD.getMinutes() >= h * 60 + m) {
    console.log('scheduler: starting today\'s run');
    try { start({}); } catch (e) { console.error(e.message); }
  }
}, 60_000);

app.listen(PORT, () => console.log(`Faceless Studio dashboard → http://localhost:${PORT}`));
