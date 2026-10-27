// Dashboard + API + in-process daily scheduler.   npm start → http://localhost:3020
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import { channel, saveChannel, env, ROOT, RUNS, bins } from './config.js';
import { db, getRun, kvGet, kvSet } from './db.js';
import { runPipeline, todayStatus, newRunId, reconcileStaleRuns, lockOwnerAlive, STAGES, getProgress, requestCancel, resetRun } from './pipeline.js';
import { authUrl, exchangeCode, isConnected, channelInfo, nextFreeSlot } from './youtube.js';
import { recentTopics } from './dedup.js';
import { publishRun } from './publish.js';
import { addIdea, generateIdeas, enqueue, listQueue, dequeue, moveQueued, retryQueued, bankCount, markIdea } from './topics.js';
import { makeLogger } from './log.js';
import { LANGUAGES, byId, rotationChoices } from './languages.js';
import { ttConfigured, ttConnected, ttAccount, ttAuthUrl, ttExchangeCode, ttCheck, ttDisconnect, ttCaption } from './tiktok.js';
import { fbConfigured, fbConnected, fbPage, fbPages, fbAuthUrl, fbExchangeCode, fbSelectPage, fbUseToken, fbDisconnect, fbCheck } from './facebook.js';

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
app.use('/kit-refs', express.static(path.join(ROOT, 'engines', 'kit', 'refs')));   // reference sheets for the style gallery

// Claude auth = a setup-token in .env, or the CLI's own saved login (~/.claude/.credentials.json).
const claudeAuthPresent = () => !!env('CLAUDE_CODE_OAUTH_TOKEN') || fs.existsSync(path.join(os.homedir(), '.claude', '.credentials.json'));

const stale = reconcileStaleRuns();
if (stale) console.log(`${stale} unfinished run(s) marked as interrupted — resume them from the dashboard`);
// a queue item left "running" by a run that is no longer running goes back to waiting
db.prepare("UPDATE queue SET status = 'waiting' WHERE status = 'running' AND (run_id IS NULL OR run_id NOT IN (SELECT id FROM runs WHERE status = 'running'))").run();
let generating = null;   // background topic-pool research

let current = null; // { runId, stage, promise, jobId }
function start(opts = {}, jobId = null) {
  if (current) throw new Error(`a run is already in progress (${current.runId})`);
  if (lockOwnerAlive()) throw new Error(`a run is already in progress in another window (${kvGet('lock').runId})`);
  const runId = opts.runId || newRunId();
  current = { runId, stage: 'starting', jobId };
  current.promise = runPipeline({ ...opts, runId, onStage: s => { if (current) current.stage = s; } })
    .then(() => finishJob(jobId, 'done'), e => finishJob(jobId, e.cancelled ? 'done' : 'failed', e.message))
    .finally(() => { current = null; setTimeout(pump, 500); });
  return runId;
}

// ---------- task list: every action runs one at a time, in the order you clicked ----------
const jobGet = id => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
function finishJob(id, status, error = null) {
  if (id) db.prepare('UPDATE jobs SET status = ?, error = ?, ended_at = ? WHERE id = ?').run(status, error ? String(error).slice(0, 400) : null, new Date().toISOString(), id);
}
// a task left "running" by a dashboard that was closed mid-run: its run is now "interrupted" (Resume it from Runs)
// tasks left "running" by a dashboard that was closed: an upload is simply tried again; a production run is now
// "interrupted" (Resume it from Runs)
db.prepare("UPDATE jobs SET status = 'waiting', started_at = NULL WHERE status = 'running' AND kind IN ('upload','facebook','tiktok','publish')").run();
db.prepare("UPDATE jobs SET status = 'done', error = 'the dashboard was closed while it ran', ended_at = ? WHERE status = 'running'").run(new Date().toISOString());

const titleOf = runId => { const r = getRun(runId); return r?.title || r?.topic || runId; };
function jobLabel(kind, p) {
  const style = p.style ? ` · ${p.style.startsWith('film:') ? (byId(p.style.slice(5))?.name || p.style) : p.style.slice(4)}` : '';
  if (kind === 'make') return `New video${style || ' · auto style'}`;
  if (kind === 'queue') return `Queued topic: ${db.prepare('SELECT topic FROM queue WHERE id = ?').get(p.queueId)?.topic || '?'}`;
  return `${{ resume: 'Resume', restart: 'Start over', upload: 'Upload to YouTube', facebook: 'Schedule on Facebook', tiktok: 'Send to TikTok drafts', publish: 'Resume publishing' }[kind]}: ${titleOf(p.runId)}`;
}

/** Add a task. Returns { jobId, position } — position 0 = it starts right away. */
function addJob(kind, params = {}) {
  const dup = params.runId
    ? db.prepare("SELECT id FROM jobs WHERE status = 'waiting' AND kind = ? AND run_id = ?").get(kind, params.runId)
    : params.queueId ? db.prepare("SELECT id FROM jobs WHERE status = 'waiting' AND kind = 'queue' AND json_extract(params, '$.queueId') = ?").get(params.queueId) : null;
  if (dup) { const e = new Error('that task is already waiting in the task list'); e.status = 409; throw e; }
  if (params.runId && ['resume', 'restart'].includes(kind) && (producingRun() === params.runId)) {
    const e = new Error('that video is being made right now'); e.status = 409; throw e;
  }
  const id = Number(db.prepare('INSERT INTO jobs (created_at, kind, run_id, params, label) VALUES (?, ?, ?, ?, ?)')
    .run(new Date().toISOString(), kind, params.runId || null, JSON.stringify(params), jobLabel(kind, params)).lastInsertRowid);
  const pub = PUBLISH_KINDS.includes(kind);
  const waitingAhead = db.prepare(`SELECT COUNT(*) n FROM jobs WHERE status = 'waiting' AND id < ? AND kind ${pub ? '' : 'NOT'} IN ('upload','facebook','tiktok','publish')`).get(id).n;
  const ahead = pub ? Math.max(0, waitingAhead + publishing.size - publishSlots() + 1) : waitingAhead + (current || lockOwnerAlive() ? 1 : 0);
  setTimeout(pump, 0);
  return { jobId: id, position: ahead };
}

// Turn a task into a pipeline start. Checks run here (at start time), since things may have changed while it waited.
function runJob(j) {
  const p = JSON.parse(j.params || '{}');
  if (j.kind === 'make') return start({ upload: p.upload, language: p.style?.startsWith('film:') ? p.style.slice(5) : undefined, style: p.style?.startsWith('tpl:') ? p.style.slice(4) : undefined }, j.id);
  if (j.kind === 'queue') {
    const q = db.prepare('SELECT * FROM queue WHERE id = ?').get(p.queueId);
    if (!q || q.status === 'done') throw new Error('that queued topic is gone or already made');
    return start({ queueId: p.queueId, upload: p.upload }, j.id);
  }
  const r = getRun(p.runId);
  if (!r) throw new Error('that run no longer exists');
  if (j.kind === 'resume') return start({ runId: r.id, upload: p.upload }, j.id);
  if (j.kind === 'restart') { resetRun(r.id); return start({ runId: r.id, upload: p.upload }, j.id); }
  throw new Error(`not a production task: ${j.kind}`);
}

// Two lanes. Production (make / queue / resume / start over) runs one video at a time under the production lock.
// Publishing (YouTube / Facebook / TikTok) is network work with no AI, so up to `publishing.parallel` (3) uploads run
// side by side — also while a video is being made. Within each lane tasks start in click order. A video is never
// published while it is being produced, and never by two tasks at once.
const PUBLISH_KINDS = ['upload', 'facebook', 'tiktok', 'publish'];   // 'publish' = Resume of a finished video
const publishing = new Map();   // jobId → runId
const publishSlots = () => Math.max(1, Math.min(5, channel().publishing?.parallel ?? 3));
const producingRun = () => current?.runId || (lockOwnerAlive() ? kvGet('lock').runId : null);

function platformsFor(j, r) {
  if (j.kind === 'facebook') return ['facebook'];
  if (j.kind === 'tiktok') return ['tiktok'];
  if (j.kind === 'publish') return ['youtube', 'facebook', 'tiktok'];   // finish whatever platforms are still missing
  return r?.status === 'held' ? ['youtube', 'facebook', 'tiktok'] : ['youtube'];   // "Upload anyway" on a held video → everywhere
}
function startPublish(j) {
  const p = JSON.parse(j.params || '{}'), r = getRun(p.runId);
  if (!r) throw new Error('that run no longer exists');
  if (!fs.existsSync(path.join(RUNS, r.id, 'final.mp4'))) throw new Error('this run has no finished video');
  db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), j.id);
  publishing.set(j.id, r.id);
  publishRun(r.id, platformsFor(j, r))
    .then(done => finishJob(j.id, 'done', done.length ? null : 'nothing new to publish'), e => finishJob(j.id, 'failed', e.message))
    .finally(() => { publishing.delete(j.id); setTimeout(pump, 200); });
}

/** Start every waiting task that may run now (called after each click, each finished task, and every 5 s). */
function pump() {
  const waiting = db.prepare("SELECT * FROM jobs WHERE status = 'waiting' ORDER BY id").all();
  let productionBlocked = !!(current || lockOwnerAlive());
  for (const j of waiting) {
    const p = JSON.parse(j.params || '{}');
    if (PUBLISH_KINDS.includes(j.kind)) {
      if (publishing.size >= publishSlots()) continue;
      if (p.runId === producingRun() || [...publishing.values()].includes(p.runId)) continue;   // that video is busy: wait
      try { startPublish(j); } catch (e) { finishJob(j.id, 'failed', e.message); }
      continue;
    }
    if (productionBlocked) continue;
    if (p.runId && [...publishing.values()].includes(p.runId)) continue;   // its video is being uploaded right now
    db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").run(new Date().toISOString(), j.id);
    try {
      const runId = runJob(j);
      db.prepare('UPDATE jobs SET run_id = ? WHERE id = ?').run(runId, j.id);
      productionBlocked = true;
    } catch (e) { finishJob(j.id, 'failed', e.message); }   // skip it and try the next task
  }
}
setInterval(pump, 5000).unref?.();

// every action button: add a task and say where it stands
const jobRoute = (kind, paramsOf) => (req, res) => {
  try {
    const params = paramsOf(req);
    if (params.runId && !getRun(params.runId)) return res.status(404).json({ error: 'no such run' });
    const { jobId, position } = addJob(kind, params);
    res.json({ jobId, position, note: position ? `Added to the task list (#${position + 1}) — it starts after ${position === 1 ? 'the current task' : `the ${position} tasks ahead of it`}.` : 'Started.' });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
};

function nextRunLocal() {
  const [h, m] = channel().schedule.runAtLocal.split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  if (d < new Date()) { if (todayStatus().needMore) return new Date().toISOString(); d.setDate(d.getDate() + 1); }
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
    autoRuns: cfg.schedule.enabled !== false, nextRun: nextRunLocal(), nextPublish: nextFreeSlot(cfg.schedule), today: (({ target, made, attempts }) => ({ target, made, attempts }))(todayStatus(cfg)),
    pool: { fresh: bankCount(), generating: !!generating },
    queue: listQueue().filter(q => q.status === 'waiting').length,
    jobs: db.prepare("SELECT COUNT(*) n FROM jobs WHERE status = 'waiting'").get().n,
    publishing: publishing.size,
    youtube: { connected: isConnected(), channel: kvGet('youtube_channel'), configured: !!(env('YOUTUBE_CLIENT_ID') && env('YOUTUBE_CLIENT_SECRET')) },
    tiktok: { enabled: cfg.tiktok?.enabled !== false, configured: ttConfigured(), connected: ttConnected(), name: ttAccount()?.name || null },
    facebook: { enabled: cfg.facebook?.enabled !== false, configured: fbConfigured(), connected: fbConnected(), page: fbPage() ? { id: fbPage().id, name: fbPage().name } : null, pages: fbPages() },
    checks: {
      claude: !!bins.claude, claudeToken: claudeAuthPresent(), chrome: !!bins.chrome,
      pexels: !!(env('PIXABAY_API_KEY') || env('PEXELS_API_KEY')), fonts: fs.existsSync(path.join(ROOT, 'engines', 'fonts', 'fonts.css')),
    },
    totals: db.prepare("SELECT COUNT(*) n, SUM(status='done') done, SUM(status='failed') failed, SUM(youtube_id IS NOT NULL OR facebook_id IS NOT NULL) uploaded FROM runs").get(),
    recentTopics: recentTopics(cfg.variety.dedupDays).length,
  });
});
app.get('/api/runs', (req, res) => res.json(db.prepare('SELECT id, created_at, status, stage, topic, style, title, duration, youtube_id, facebook_id, tiktok_id, publish_at, fb_publish_at, error FROM runs ORDER BY created_at DESC LIMIT 100').all()
  .map(r => ({ ...r, hasVideo: fs.existsSync(path.join(RUNS, r.id, 'final.mp4')) }))));
app.get('/api/runs/:id', (req, res) => {
  const r = getRun(req.params.id); if (!r) return res.status(404).end();
  const dir = path.join(RUNS, r.id);
  const plan = fs.existsSync(path.join(dir, 'plan.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8')) : null;
  const logs = db.prepare('SELECT at, level, msg FROM logs WHERE run_id = ? ORDER BY id').all(r.id);
  res.json({ ...r, plan, logs, hasSheet: fs.existsSync(path.join(dir, 'sheet.jpg')), hasVideo: fs.existsSync(path.join(dir, 'final.mp4')), ttCaption: plan ? ttCaption(plan, channel()) : null });
});
app.get('/media/:id/:file', (req, res) => {
  if (!/^[\w-]+$/.test(req.params.id) || !['final.mp4', 'sheet.jpg'].includes(req.params.file)) return res.status(400).end();
  const f = path.join(RUNS, req.params.id, req.params.file);
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).end();
});
// style: '' = automatic, 'film:<language-id>' = director with that language, 'tpl:<engine>' = a fast template engine
app.post('/api/run', jobRoute('make', req => {
  const style = String(req.body?.style || '');
  if (style.startsWith('film:') && !byId(style.slice(5))) throw new Error('unknown animation style');
  return { upload: req.body?.upload, style };
}));
// automatic daily videos on/off (the in-dashboard scheduler and the daily worker both respect it)
app.put('/api/schedule', (req, res) => { const c = channel(); c.schedule.enabled = !!req.body?.enabled; saveChannel(c); res.json({ enabled: c.schedule.enabled }); });
app.get('/api/jobs', (req, res) => res.json(db.prepare("SELECT * FROM jobs WHERE status IN ('waiting','running') OR (status = 'failed' AND ended_at > ?) ORDER BY id").all(new Date(Date.now() - 6 * 3600_000).toISOString())));
app.delete('/api/jobs/:id', (req, res) => {
  const j = jobGet(+req.params.id);
  if (!j || j.status !== 'waiting') return res.status(400).json({ error: j?.status === 'running' ? 'it is running — use Cancel on the video' : 'not waiting' });
  db.prepare("UPDATE jobs SET status = 'removed', ended_at = ? WHERE id = ?").run(new Date().toISOString(), j.id);
  res.json({ ok: true });
});
app.post('/api/jobs/clear-failed', (req, res) => { db.prepare("UPDATE jobs SET status = 'removed' WHERE status = 'failed'").run(); res.json({ ok: true }); });

// ---------- topic pool ----------
app.get('/api/pool', (req, res) => {
  const status = String(req.query.status || 'new');
  res.json(db.prepare("SELECT * FROM bank WHERE status = ? ORDER BY source = 'manual' DESC, id DESC LIMIT 300").all(status));
});
app.post('/api/pool', (req, res) => {
  try { res.json({ id: addIdea({ ...req.body, source: 'manual' }, { force: !!req.body?.force }) }); }
  catch (e) { res.status(e.duplicate ? 409 : 400).json({ error: e.message }); }
});
app.post('/api/pool/research', (req, res) => {
  if (generating) return res.status(409).json({ error: 'already researching a batch' });
  const log = makeLogger(null);
  generating = generateIdeas(Math.min(30, Math.max(5, +req.body?.n || 0)) || undefined, log)
    .catch(e => log.warn(`topic research failed: ${e.message}`)).finally(() => { generating = null; });
  res.json({ ok: true, note: 'Researching a batch of ideas (about 2–5 minutes).' });
});
app.post('/api/pool/:id/queue', (req, res) => { try { res.json({ queueId: enqueue({ bankId: +req.params.id, style: req.body?.style || '' }) }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/pool/:id/reject', (req, res) => { markIdea(+req.params.id, 'rejected'); res.json({ ok: true }); });
app.post('/api/pool/:id/restore', (req, res) => { markIdea(+req.params.id, 'new'); res.json({ ok: true }); });

// ---------- queue ----------
app.get('/api/queue', (req, res) => res.json(listQueue()));
app.post('/api/queue', (req, res) => {
  const st = String(req.body?.style || '');
  if (st.startsWith('film:') && !byId(st.slice(5))) return res.status(400).json({ error: 'unknown animation style' });
  try { res.json({ queueId: enqueue(req.body || {}) }); } catch (e) { res.status(e.duplicate ? 409 : 400).json({ error: e.message }); }
});
app.delete('/api/queue/:id', (req, res) => { try { dequeue(+req.params.id); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/queue/:id/move', (req, res) => { moveQueued(+req.params.id, req.body?.dir === 'up' ? 'up' : 'down'); res.json({ ok: true }); });
app.post('/api/queue/:id/retry', (req, res) => { retryQueued(+req.params.id); res.json({ ok: true }); });
app.post('/api/queue/:id/run', jobRoute('queue', req => ({ queueId: +req.params.id, upload: req.body?.upload })));
// Resume: continue from the last completed stage (keeps topic, script, voice, footage).
// Resume: a video that is already rendered only has publishing left → it joins the parallel upload lane
// ('publish' task). Anything earlier continues production in the one-at-a-time lane.
const isRendered = id => {
  const sf = path.join(RUNS, id, 'state.json');
  return fs.existsSync(path.join(RUNS, id, 'final.mp4')) && fs.existsSync(sf) && JSON.parse(fs.readFileSync(sf, 'utf8')).done?.includes('render');
};
const resume = (req, res) => (getRun(req.params.id) && isRendered(req.params.id)
  ? jobRoute('publish', r => ({ runId: r.params.id }))
  : jobRoute('resume', r => ({ runId: r.params.id, upload: r.body?.upload })))(req, res);
app.post('/api/runs/:id/resume', resume);
app.post('/api/runs/:id/retry', resume);
// Start over: forget every stage (new topic, new script) but keep the same run slot.
app.post('/api/runs/:id/restart', jobRoute('restart', req => ({ runId: req.params.id, upload: req.body?.upload })));
app.post('/api/runs/:id/cancel', (req, res) => {
  const active = current?.runId === req.params.id || (lockOwnerAlive() && kvGet('lock').runId === req.params.id);
  if (!active) return res.status(400).json({ error: 'that run is not running' });
  requestCancel(req.params.id);
  res.json({ ok: true, note: 'Stopping at the next safe point (a few seconds while rendering; Claude steps finish their current call first).' });
});
app.post('/api/runs/:id/upload', jobRoute('upload', req => {
  const r = getRun(req.params.id), fbWanted = channel().facebook?.enabled !== false && fbConnected();
  if (r && (!['done', 'held'].includes(r.status) || (r.youtube_id && (r.facebook_id || !fbWanted)))) throw new Error('nothing to upload');
  return { runId: req.params.id };
}));
app.get('/api/config', (req, res) => res.json(channel()));
app.get('/api/languages', (req, res) => {
  const on = channel().direction?.languages || {}, { choices, recent } = rotationChoices();
  res.json(LANGUAGES.map(l => ({ ...l, enabled: on[l.id] !== false, upNext: choices.some(c => c.id === l.id), recentlyUsed: recent.includes(l.name) })));
});
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
// Schedule just the Facebook Reel for any finished video (also when its YouTube upload failed or was held/skipped)
app.post('/api/runs/:id/facebook', jobRoute('facebook', req => {
  const r = getRun(req.params.id);
  if (r?.facebook_id) throw new Error('this video is already scheduled on Facebook');
  if (r && !fs.existsSync(path.join(RUNS, r.id, 'final.mp4'))) throw new Error('this run has no finished video yet');
  if (!fbConnected()) throw new Error('connect your Facebook Page first (Facebook Page card)');
  if (channel().facebook?.enabled === false) throw new Error('Facebook is switched off (Facebook Page card)');
  return { runId: req.params.id };
}));


app.post('/api/runs/:id/tiktok', jobRoute('tiktok', req => {
  const r = getRun(req.params.id);
  if (r?.tiktok_id) throw new Error('this video is already in your TikTok drafts');
  if (r && !fs.existsSync(path.join(RUNS, r.id, 'final.mp4'))) throw new Error('this run has no finished video yet');
  if (!ttConnected()) throw new Error('connect TikTok first (TikTok card)');
  if (channel().tiktok?.enabled === false) throw new Error('TikTok is switched off (TikTok card)');
  return { runId: req.params.id };
}));

// ---------- TikTok (Login Kit → drafts in your TikTok inbox) ----------
const ttRedirect = () => `http://localhost:${PORT}/tt/callback`;
app.get('/tt/start', (req, res) => {
  if (!ttConfigured()) return res.status(400).send('Set TIKTOK_CLIENT_KEY and TIKTOK_CLIENT_SECRET in .env first (see README → TikTok).');
  res.redirect(ttAuthUrl(ttRedirect(), crypto.randomBytes(12).toString('hex')));
});
app.get('/tt/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    const r = await ttExchangeCode(String(req.query.code), ttRedirect(), String(req.query.state || ''));
    res.send(`<p style="font-family:sans-serif">Connected to TikTok${r.name ? ` as <b>${r.name.replace(/</g, '&lt;')}</b>` : ''}. You can close this tab.</p><script>setTimeout(()=>location='/',1500)</script>`);
  } catch (e) { res.status(500).send(`<p style="font-family:sans-serif">TikTok login error: ${String(e.message).replace(/</g, '&lt;')}</p>`); }
});
app.post('/api/tiktok/check', async (req, res) => { try { res.json(await ttCheck()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/tiktok/disconnect', (req, res) => { ttDisconnect(); res.json({ ok: true }); });
app.put('/api/tiktok', (req, res) => { const c = channel(); c.tiktok = { ...(c.tiktok || {}), enabled: !!req.body?.enabled }; saveChannel(c); res.json(c.tiktok); });

// ---------- Facebook Page (Facebook Login → never-expiring Page token; or paste a Page token) ----------
const fbRedirect = () => `http://localhost:${PORT}/fb/callback`;
app.get('/fb/start', (req, res) => {
  if (!fbConfigured()) return res.status(400).send('Set FB_APP_ID and FB_APP_SECRET in .env first (see README → Facebook).');
  const state = crypto.randomBytes(12).toString('hex'); kvSet('fb_state', state);
  res.redirect(fbAuthUrl(fbRedirect(), state));
});
app.get('/fb/callback', async (req, res) => {
  try {
    if (req.query.error) throw new Error(String(req.query.error_description || req.query.error));
    if (!req.query.state || req.query.state !== kvGet('fb_state')) throw new Error('login state mismatch — start again from the dashboard');
    const r = await fbExchangeCode(String(req.query.code), fbRedirect(), channel().channelName);
    res.send(`<p style="font-family:sans-serif">${r.selected ? `Connected to the Facebook Page <b>${r.selected.name}</b>.` : `Found ${r.pages.length} Pages — pick one in the dashboard (Facebook Page card).`} You can close this tab.</p><script>setTimeout(()=>location='/',1500)</script>`);
  } catch (e) { res.status(500).send(`<p style="font-family:sans-serif">Facebook login error: ${String(e.message).replace(/</g, '&lt;')}</p>`); }
});
app.post('/api/facebook/page', (req, res) => { try { res.json(fbSelectPage(req.body?.id)); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/facebook/token', async (req, res) => { try { res.json(await fbUseToken(String(req.body?.token || '').trim())); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/facebook/check', async (req, res) => { try { res.json(await fbCheck()); } catch (e) { res.status(400).json({ error: e.message }); } });
app.post('/api/facebook/disconnect', (req, res) => { fbDisconnect(); res.json({ ok: true }); });
app.put('/api/facebook', (req, res) => { const c = channel(); c.facebook = { ...(c.facebook || {}), enabled: !!req.body?.enabled }; saveChannel(c); res.json(c.facebook); });
app.post('/api/youtube/refresh', async (req, res) => { try { res.json(await channelInfo()); } catch (e) { res.status(400).json({ error: e.message }); } });

// ---------- scheduler: once per day at runAtLocal ----------
let warned = false;
setInterval(() => {
  if (current || lockOwnerAlive() || channel().schedule.enabled === false) return;
  if ((kvGet('claudeLimitUntil') || 0) > Date.now()) return;
  if (db.prepare("SELECT 1 FROM jobs WHERE status = 'waiting'").get()) return;   // your tasks go first   // paused until the Claude usage limit resets
  if (!claudeAuthPresent() && !warned) { warned = true; console.warn('scheduler: no Claude login (run `claude` → /login, or set CLAUDE_CODE_OAUTH_TOKEN) — automatic runs are paused'); }
  if (!claudeAuthPresent()) return;
  const [h, m] = channel().schedule.runAtLocal.split(':').map(Number);
  const nowD = new Date();
  // 10-minute grace: the Windows "FacelessStudio Daily" task starts at the exact time and takes the run lock;
  // the dashboard only steps in if that task didn't run (not installed, or the PC was busy).
  if (nowD.getHours() * 60 + nowD.getMinutes() < h * 60 + m + 10) return;
  const t = todayStatus();
  if (t.interrupted) {
    // The PC or app stopped mid-run: pick it up again automatically (at most twice per run).
    const k = `autoresume:${t.interrupted.id}`, n = kvGet(k, 0);
    if (n < 2) { kvSet(k, n + 1); console.log(`scheduler: resuming interrupted run ${t.interrupted.id}`); try { start({ runId: t.interrupted.id }); } catch (e) { console.error(e.message); } return; }
  }
  if (t.needMore) {
    console.log(`scheduler: making video ${t.made + 1} of ${t.target} for today`);
    try { start({}); } catch (e) { console.error(e.message); }
  }
}, 60_000);

app.listen(PORT, () => console.log(`Faceless Studio dashboard → http://localhost:${PORT}`));
