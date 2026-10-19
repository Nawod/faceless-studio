// The daily production line. Each stage checkpoints into <run>/state.json so a failed run resumes where it stopped.
import fs from 'node:fs';
import path from 'node:path';
import { channel, RUNS } from './config.js';
import { db, now, updateRun, getRun, kvGet, kvSet } from './db.js';
import { makeLogger } from './log.js';
import { discover } from './discover.js';
import { makePlan, extendScript } from './planner.js';
import { recordTopic, checkFresh } from './dedup.js';
import { pickVoice, narrate, sceneTimings, makeMusicAndSfx, mixAudio } from './audio.js';
import { fetchMedia } from './assets.js';
import { composeSpec, writeComp, sfxEvents } from './compose.js';
import { reviewStills } from './qa.js';
import { renderVideo, mux } from './render.js';
import { uploadVideo, nextFreeSlot, isConnected } from './youtube.js';

const VOICE_DELAY = 0.15, TAIL = 2.2;   // tail leaves room for the brand end card

export function newRunId() {
  const d = new Date();
  return `${d.toISOString().slice(0, 10)}_${d.toTimeString().slice(0, 8).replace(/:/g, '')}`;
}

// Stages in order, with rough share of the total time (for the dashboard progress bar).
export const STAGES = [
  { id: 'discover', label: 'Find trends', weight: 3 },
  { id: 'plan', label: 'Research & script', weight: 24 },
  { id: 'voice', label: 'Voiceover', weight: 6 },
  { id: 'media', label: 'Footage', weight: 7 },
  { id: 'qa', label: 'Quality check', weight: 10 },
  { id: 'render', label: 'Render & mix', weight: 44 },
  { id: 'upload', label: 'Upload', weight: 6 },
];

// Live progress for the dashboard (one run at a time, so one key).
export function setProgress(patch) { kvSet('progress', { ...(kvGet('progress') || {}), ...patch, at: Date.now() }); }
export const getProgress = () => kvGet('progress');

// Cancellation: the dashboard sets a flag; the pipeline checks it between stages and every few frames.
export class Cancelled extends Error { constructor() { super('cancelled by user'); this.cancelled = true; } }
export const requestCancel = runId => kvSet('cancel', runId);
const cancelRequested = runId => kvGet('cancel') === runId;

const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
// A live run refreshes its lock every 20 s; Windows reuses PIDs, so the heartbeat is what proves the owner is alive.
const HEARTBEAT_MS = 20_000, STALE_MS = 120_000;
const lockLive = l => !!(l && Date.now() - l.at < STALE_MS && alive(l.pid));

/** Runs left "running" by a process that died (server stopped, PC restarted) become "interrupted" and can be resumed. */
export function reconcileStaleRuns() {
  const l = kvGet('lock');
  const owner = lockLive(l) ? l.runId : null;
  const stale = db.prepare("SELECT id FROM runs WHERE status = 'running'").all().filter(r => r.id !== owner);
  for (const r of stale) updateRun(r.id, { status: 'interrupted', error: 'Stopped before finishing (the app was closed). Resume to continue from the last completed stage.' });
  if (l && !owner) { kvSet('lock', null); kvSet('progress', null); }
  return stale.length;
}

export function lockOwnerAlive() { return lockLive(kvGet('lock')); }

// One pipeline at a time (dashboard + Task Scheduler may both try).
let heartbeat = null;
function takeLock(runId) {
  const l = kvGet('lock');
  if (l && l.runId !== runId && lockLive(l)) throw new Error(`another run (${l.runId}) is in progress`);
  kvSet('lock', { runId, pid: process.pid, at: Date.now() });
  clearInterval(heartbeat);
  heartbeat = setInterval(() => { const c = kvGet('lock'); if (c?.runId === runId && c.pid === process.pid) kvSet('lock', { ...c, at: Date.now() }); }, HEARTBEAT_MS);
  heartbeat.unref?.();
}
const releaseLock = runId => { clearInterval(heartbeat); heartbeat = null; const l = kvGet('lock'); if (l?.runId === runId) kvSet('lock', null); };

export async function runPipeline({ runId = newRunId(), upload, planFile, style, onStage, forceUpload = false } = {}) {
  const cfg = channel();
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir, { recursive: true });
  const log = makeLogger(runId);
  const stateFile = path.join(dir, 'state.json');
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { done: [] };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(st, null, 1));
  const stage = async (name, fn) => {
    if (cancelRequested(runId)) throw new Cancelled();
    if (st.done.includes(name)) return;
    log.info(`▶ ${name}`); onStage?.(name);
    updateRun(runId, { stage: name });
    setProgress({ runId, stage: name, stagePct: 0, detail: '', stageStartedAt: Date.now() });
    await fn();
    st.done.push(name); save();
  };
  if (!getRun(runId)) db.prepare('INSERT INTO runs (id, created_at, status) VALUES (?, ?, ?)').run(runId, now(), 'running');
  updateRun(runId, { status: 'running', error: null });
  upload ??= cfg.youtube.autoUpload;
  takeLock(runId);
  if (cancelRequested(runId)) kvSet('cancel', null);
  kvSet('progress', { runId, done: [...st.done], startedAt: Date.now(), at: Date.now() });
  try {
    await stage('discover', async () => { st.candidates = planFile ? [] : await discover(log); });

    await stage('plan', async () => {
      if (planFile) {
        st.plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        const fresh = checkFresh(st.plan.topic, st.plan.angle, st.plan.keywords, cfg.variety.dedupDays, cfg.variety.similarityThreshold);
        if (!fresh.ok) log.warn(`supplied plan is close to past topic "${fresh.match.topic}" (${fresh.score.toFixed(2)})`);
      } else {
        setProgress({ detail: 'Claude is choosing a topic and fact-checking it with web search — usually 3–8 min' });
        st.plan = await makePlan({ candidates: st.candidates, log, cwd: dir });
      }
      if (style) st.plan.style = style;
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
      updateRun(runId, { topic: st.plan.topic, style: st.plan.style, title: st.plan.title });
    });

    await stage('voice', async () => {
      const voice = pickVoice(runId);
      let rate = voice.rate;
      for (let attempt = 0; attempt < 3; attempt++) {
        const text = st.plan.scenes.map(s => s.narration).join(' ');
        setProgress({ detail: `Recording narration (${voice.voice.replace(/^\w\w-\w\w-|Multilingual|Neural/g, '')})` });
        const v = await narrate(text, dir, { ...voice, rate }, log);
        const total = v.duration + VOICE_DELAY + TAIL;
        log.info(`narration ${v.duration.toFixed(1)}s with ${voice.voice} @ ${rate} → video ${total.toFixed(1)}s`);
        st.voice = { ...v, voice: voice.voice, rate, total };
        if (total >= cfg.video.minSeconds && total <= cfg.video.maxSeconds + 10) break;
        if (total < cfg.video.minSeconds) {
          if (rate !== '-4%' && total * 1.1 >= cfg.video.minSeconds) { rate = '-4%'; continue; }
          if (planFile) { log.warn('video is under the minimum length; extending a supplied plan is skipped'); break; }
          st.plan = await extendScript(st.plan, cfg.video.minSeconds + 3 - total, log, dir);
          fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
          rate = voice.rate;
        } else { rate = '+14%'; }
      }
    });

    await stage('media', async () => { st.credits = await fetchMedia(st.plan, dir, log); fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2)); });

    const build = () => {
      const timings = sceneTimings(st.plan.scenes, st.voice.words, st.voice.duration + TAIL);
      const seed = Math.abs([...runId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 100000;
      const spec = composeSpec({ plan: st.plan, timings, words: st.voice.words, voiceDelay: VOICE_DELAY, duration: +st.voice.total.toFixed(2), seed, cfg });
      return { spec, html: writeComp(dir, spec), seed };
    };

    await stage('qa', async () => {
      setProgress({ detail: 'Rendering one still per scene and asking Claude to review them' });
      let { spec, html } = build();
      let r = await reviewStills(html, spec, st.plan, dir, log);
      st.qa = { score: r.score, pass: r.pass, issues: r.issues, rounds: 0 };
      // Up to two fix rounds: apply Claude's replacement visuals, fetch any new photos, review again.
      for (let round = 1; round <= 2 && !r.pass && r.patches?.length; round++) {
        for (const p of r.patches) {
          const s = st.plan.scenes[p.scene - 1];
          if (!s || !p.visual?.kind) continue;
          const newBroll = p.visual.broll && p.visual.broll !== s.visual.broll;
          s.visual = { ...p.visual, broll: p.visual.broll || s.visual.broll, img: newBroll ? undefined : s.visual.img, video: newBroll ? undefined : s.visual.video };
        }
        setProgress({ detail: `Fixing ${r.patches.length} scene(s) flagged by QA (round ${round})` });
        const more = await fetchMedia(st.plan, dir, log);
        st.credits = [...new Set([...(st.credits || []), ...more])];
        fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
        ({ spec, html } = build());
        r = await reviewStills(html, spec, st.plan, dir, log);
        st.qa = { score: r.score, pass: r.pass, issues: r.issues, rounds: round };
      }
      if (!r.skipped && r.score != null && r.score < 5) {
        st.held = `QA score ${r.score}/10 after fixes: ${(r.issues || []).slice(0, 3).map(x => `#${x.scene} ${x.problem}`).join('; ')}`;
        log.warn(`video held back from upload — ${st.held}`);
      }
    });

    await stage('render', async () => {
      const { spec, html, seed } = build();
      const silent = path.join(dir, 'video_silent.mp4');
      await renderVideo(html, {
        duration: spec.duration, fps: cfg.video.fps, W: spec.W, H: spec.H, out: silent, log,
        shouldCancel: () => cancelRequested(runId) && new Cancelled(),
        onProgress: (done, total, etaS) => setProgress({ stagePct: 0.9 * done / total, detail: `Rendering frames ${done.toLocaleString()} / ${total.toLocaleString()}`, eta: etaS }),
      });
      setProgress({ stagePct: 0.92, detail: 'Composing music and sound effects', eta: null });
      const { music, sfx } = await makeMusicAndSfx(dir, spec.duration, st.plan.mood || 'curious', seed, sfxEvents(spec), log);
      setProgress({ stagePct: 0.96, detail: 'Mixing voice, music and SFX' });
      const mixed = await mixAudio({ voice: path.join(dir, 'voice.mp3'), music, sfx, voiceDelay: VOICE_DELAY, seconds: spec.duration, out: path.join(dir, 'mix.wav') });
      st.video = await mux(silent, mixed, path.join(dir, 'final.mp4'));
      fs.rmSync(silent, { force: true });
      updateRun(runId, { video_path: st.video, duration: spec.duration });
    });

    await stage('upload', async () => {
      if (!upload) { log.info('upload disabled for this run — video ready in the dashboard'); return; }
      if (st.held && !forceUpload) { log.warn('not uploading: held for review (use "Upload & schedule" in the dashboard to publish it anyway)'); return; }
      if (!isConnected()) throw new Error('YouTube is not connected');
      setProgress({ detail: 'Uploading to YouTube and scheduling' });
      const p = st.plan;
      const publishAt = nextFreeSlot(cfg.schedule);
      const src = (p.sources || []).filter(s => s.url).map(s => `• ${s.title || ''} ${s.url}`.trim()).slice(0, 6).join('\n');
      const description = [p.description.replace(/\s*Sources:[\s\S]*$/i, '').trim(), src ? `\nSources:\n${src}` : '', st.credits?.length ? `\nStock footage — ${st.credits.slice(0, 5).join(', ')}` : '', '\nVoice and animation are AI-assisted; facts checked against the sources above.'].join('\n');
      const tags = [...new Set([...(p.tags || []), ...cfg.youtube.defaultTags])].slice(0, 20);
      const title = /#shorts/i.test(p.title) ? p.title : p.title;
      const id = await uploadVideo(st.video, { title, description, tags, categoryId: cfg.youtube.categoryId, publishAt, madeForKids: cfg.youtube.madeForKids, synthetic: cfg.youtube.containsSyntheticMedia }, log);
      st.youtube = { id, publishAt };
      updateRun(runId, { youtube_id: id, publish_at: publishAt });
    });

    if (!st.recorded) { recordTopic(runId, st.plan); st.recorded = true; save(); }
    const held = st.held && !st.youtube;
    updateRun(runId, { status: held ? 'held' : 'done', stage: 'done', error: held ? `Held for review — ${st.held}` : null, meta: { qa: st.qa, voice: st.voice?.voice, sources: st.plan.sources, credits: st.credits } });
    log.info('✔ run complete');
    return getRun(runId);
  } catch (e) {
    if (e.cancelled) { log.warn('run cancelled — resume it later or start over'); updateRun(runId, { status: 'cancelled', error: 'Cancelled by you. Resume continues from the last completed stage.' }); }
    else { log.error(e.stack || e.message); updateRun(runId, { status: 'failed', error: String(e.message).slice(0, 2000) }); }
    throw e;
  } finally { save(); releaseLock(runId); kvSet('progress', null); if (cancelRequested(runId)) kvSet('cancel', null); }
}

/** Forget all completed stages so the next start redoes everything (new topic). */
export function resetRun(runId) {
  fs.rmSync(path.join(RUNS, runId, 'state.json'), { force: true });
  updateRun(runId, { stage: null, topic: null, style: null, title: null, error: null });
}

/** Today's runs (local calendar day) and what the daily quota still needs. */
export function todayStatus(cfg = channel()) {
  const day = new Date().toDateString();
  const runs = db.prepare('SELECT id, status, created_at FROM runs ORDER BY created_at').all().filter(r => new Date(r.created_at).toDateString() === day);
  const target = Math.max(1, cfg.schedule.videosPerDay || 1);
  const made = runs.filter(r => r.status === 'done').length;
  return {
    target, made, attempts: runs.length, runs,
    interrupted: runs.find(r => r.status === 'interrupted') || null,
    needMore: made < target && runs.length < target + 3,
  };
}

export function todaysRun() {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT * FROM runs WHERE id LIKE ? AND status IN ('running','done','interrupted') ORDER BY created_at DESC").get(`${today}%`);
}
