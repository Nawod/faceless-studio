// Dashboard + API + in-process daily scheduler.   npm start → http://localhost:3020
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { channel, saveChannel, env, ROOT, RUNS, bins } from './config.js';
import { db, getRun, kvGet, kvSet } from './db.js';
import { runPipeline, todaysRun, newRunId, reconcileStaleRuns, lockOwnerAlive, STAGES, getProgress, requestCancel, resetRun } from './pipeline.js';
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

// Claude auth = a setup-token in .env, or the CLI's own saved login (~/.claude/.credentials.json).
const claudeAuthPresent = () => !!env('CLAUDE_CODE_OAUTH_TOKEN') || fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));

const stale = reconcileStaleRuns();
if (stale) console.log(`${stale} unfinished run(s) marked as interrupted — resume them from the dashboard`);

let current = null; // { runId, stage, promise }
function start(opts = {}) {
  if (current) throw new Error(`a run is already in progress (${current.runId})`);
  if (lockOwnerAlive()) throw new Error(`a run is already in progress in another window (${kvGet('lock').runId})`);
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
  const runId = current?.runId || (lockOwnerAlive() ? kvGet('lock').runId : null);
  const r = runId ? getRun(runId) : null;
  const prog = getProgress();
  res.json({
    running: runId ? { runId, stage: r?.stage || current?.stage, title: r?.title, topic: r?.topic, style: r?.style, external: !current, progress: prog?.runId === runId ? prog : null, cancelling: kvGet('cancel') === runId } : null,
    stages: STAGES,
    nextRun: nextRunLocal(), nextPublish: nextSlot(cfg.schedule.publishAtUTC, cfg.schedule.leadDays),
    youtube: { connected: isConnected(), channel: kvGet('youtube_channel'), configured: !!(env('YOUTUBE_CLIENT_ID') && env('YOUTUBE_CLIENT_SECRET')) },
    checks: {
      claude: !!bins.claude, claudeToken: claudeAuthPresent(), chrome: !!bins.chrome,
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
// Resume: continue from the last completed stage (keeps topic, script, voice, footage).
const resume = (req, res) => {
  if (!getRun(req.params.id)) return res.status(404).json({ error: 'no such run' });
  try { res.json({ runId: start({ runId: req.params.id, upload: req.body?.upload }) }); }
  catch (e) { res.status(409).json({ error: e.message }); }
};
app.post('/api/runs/:id/resume', resume);
app.post('/api/runs/:id/retry', resume);
// Start over: forget every stage (new topic, new script) but keep the same run slot.
app.post('/api/runs/:id/restart', (req, res) => {
  if (!getRun(req.params.id)) return res.status(404).json({ error: 'no such run' });
  if (current?.runId === req.params.id || (lockOwnerAlive() && kvGet('lock').runId === req.params.id)) return res.status(409).json({ error: 'cancel the run first' });
  resetRun(req.params.id);
  try { res.json({ runId: start({ runId: req.params.id, upload: req.body?.upload }) }); }
  catch (e) { res.status(409).json({ error: e.message }); }
});
app.post('/api/runs/:id/cancel', (req, res) => {
  const active = current?.runId === req.params.id || (lockOwnerAlive() && kvGet('lock').runId === req.params.id);
  if (!active) return res.status(400).json({ error: 'that run is not running' });
  requestCancel(req.params.id);
  res.json({ ok: true, note: 'Stopping at the next safe point (a few seconds while rendering; Claude steps finish their current call first).' });
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
  if (current || lockOwnerAlive() || channel().schedule.enabled === false) return;
  if (!claudeAuthPresent() && !warned) { warned = true; console.warn('scheduler: no Claude login (run `claude` → /login, or set CLAUDE_CODE_OAUTH_TOKEN) — automatic runs are paused'); }
  if (!claudeAuthPresent()) return;
  const [h, m] = channel().schedule.runAtLocal.split(':').map(Number);
  const nowD = new Date();
  if (nowD.getHours() * 60 + nowD.getMinutes() < h * 60 + m) return;
  const today = todaysRun();
  if (!today) {
    console.log('scheduler: starting today\'s run');
    try { start({}); } catch (e) { console.error(e.message); }
  } else if (today.status === 'interrupted') {
    // The PC or app stopped mid-run: pick it up again automatically (at most twice a day).
    const k = `autoresume:${today.id}`, n = kvGet(k, 0);
    if (n < 2) { kvSet(k, n + 1); console.log(`scheduler: resuming interrupted run ${today.id}`); try { start({ runId: today.id }); } catch (e) { console.error(e.message); } }
  }
}, 60_000);

app.listen(PORT, () => console.log(`Faceless Studio dashboard → http://localhost:${PORT}`));
