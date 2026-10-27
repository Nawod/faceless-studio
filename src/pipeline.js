// The daily production line. Each stage checkpoints into <run>/state.json so a failed run resumes where it stopped.
import fs from 'node:fs';
import path from 'node:path';
import { channel, RUNS } from './config.js';
import { db, now, updateRun, getRun, kvGet, kvSet } from './db.js';
import { makeLogger } from './log.js';
import { discover } from './discover.js';
import { makePlan, extendScript, repairDrawings, liteToTemplate } from './planner.js';
import { ensureBank, pickIdea, markIdea, nextQueued, setQueueStatus } from './topics.js';
import { recordTopic, checkFresh } from './dedup.js';
import { pickVoice, narrate, sceneTimings, makeMusicAndSfx, mixAudio } from './audio.js';
import { fetchMedia, stockAvailability } from './assets.js';
import { composeSpec, writeComp, sfxEvents } from './compose.js';
import { reviewStills } from './qa.js';
import { renderVideo, mux } from './render.js';
import { directFilm } from './director.js';
import { usage } from './claude.js';
import { uploadVideo, nextFreeSlot, isConnected } from './youtube.js';
import { uploadReel, fbConnected } from './facebook.js';
import { sendDraft, ttConnected, ttCaption } from './tiktok.js';

const VOICE_DELAY = 0.15, TAIL = 2.2;   // tail leaves room for the brand end card

export function newRunId() {
  const d = new Date();
  return `${d.toISOString().slice(0, 10)}_${d.toTimeString().slice(0, 8).replace(/:/g, '')}`;
}

// Stages in order, with rough share of the total time (for the dashboard progress bar).
export const STAGES = [
  { id: 'topic', label: 'Pick topic', weight: 3 },
  { id: 'plan', label: 'Research & script', weight: 24 },
  { id: 'voice', label: 'Voiceover', weight: 6 },
  { id: 'direct', label: 'Animate', weight: 20 },
  { id: 'media', label: 'Footage', weight: 7 },
  { id: 'qa', label: 'Quality check', weight: 10 },
  { id: 'render', label: 'Render & mix', weight: 44 },
  { id: 'upload', label: 'YouTube', weight: 6 },
  { id: 'facebook', label: 'Facebook', weight: 4 },
  { id: 'tiktok', label: 'TikTok', weight: 3 },
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

// only: 'facebook' publishes an already-rendered video to the Facebook Page alone (YouTube is left as it is)
// queueId: make that queue item now (otherwise the queue head, then the topic pool, is used automatically)
// publishOnly: an upload/schedule task for a finished video — only the publishing stages run, with no AI at all
export async function runPipeline({ runId = newRunId(), upload, planFile, style, language, onStage, forceUpload = false, only, queueId, publishOnly = false } = {}) {
  const cfg = channel();
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir, { recursive: true });
  const log = makeLogger(runId);
  const stateFile = path.join(dir, 'state.json');
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { done: [] };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(st, null, 1));
  const PUBLISH = ['upload', 'facebook', 'tiktok'];
  // a finished video is never produced again: once it is rendered, the production stages (which call Claude)
  // count as done — older runs may lack newer stage names such as 'direct' or 'topic'
  const rendered = () => st.done.includes('render') && fs.existsSync(path.join(dir, 'final.mp4'));
  const stage = async (name, fn) => {
    if (cancelRequested(runId)) throw new Cancelled();
    if (st.done.includes(name)) return;
    if (!PUBLISH.includes(name) && (publishOnly || rendered())) { if (rendered()) { st.done.push(name); save(); } return; }
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
  usage.reset();
  usage.forbidden = publishOnly ? ({ youtube: 'uploading to YouTube', facebook: 'scheduling on Facebook', tiktok: 'sending to TikTok' }[only] || 'uploading and scheduling') : null;
  if (cancelRequested(runId)) kvSet('cancel', null);
  kvSet('progress', { runId, done: [...st.done], startedAt: Date.now(), at: Date.now() });
  // Which topic: a queue item (your picks, in order) is claimed right away so its style choice applies to this run.
  // (A topic-pool idea is picked in the 'topic' stage, after the pool has been topped up.)
  if (!st.assigned && !st.plan && !planFile) {
    const q = queueId ? db.prepare('SELECT * FROM queue WHERE id = ?').get(queueId) : (style || language ? null : nextQueued());
    if (q) {
      st.assigned = { topic: q.topic, angle: q.angle, notes: q.notes, style: q.style || '', bankId: q.bank_id, queueId: q.id };
      setQueueStatus(q.id, 'running', { runId }); updateRun(runId, { queue_id: q.id, topic: q.topic });
      log.info(`queued topic: "${q.topic}"${q.style ? ` (style ${q.style})` : ''}`);
    }
  }
  const qs = st.assigned?.style || '';
  if (qs.startsWith('film:') && !style) language ||= qs.slice(5);
  if (qs.startsWith('tpl:') && !language) style ||= qs.slice(4);
  // bespoke = an agent animator hand-builds every video (director mode); the template engines are the fallback
  // a style picked in the dashboard decides: a director language forces director mode, a template style forces templates
  if (language) st.language = language;
  const bespoke = !style && (!!st.language || (cfg.direction?.mode || 'templates') === 'bespoke');
  // Claude usage of this video, summed over every attempt/resume (also when an attempt fails or pauses)
  const addUsage = () => {
    const u = usage.total(); usage.reset();
    st.usage = { usd: +((st.usage?.usd || 0) + u.usd).toFixed(2), tokens: (st.usage?.tokens || 0) + u.tokens, out: (st.usage?.out || 0) + u.out };
  };
  try {
    // Topic: the queue item claimed above, else the best idea from the topic pool (researched 20 at a time and
    // refilled in the background when it runs low) — so the per-video trend scan and topic hunt are skipped.
    await stage('topic', async () => {
      if (planFile || st.plan || st.assigned) return;
      setProgress({ detail: 'Taking the next idea from the topic pool (researching a new batch if it is empty)' });
      try { await ensureBank(log, { cwd: dir }); } catch (e) { if (e.limit) throw e; log.warn(`topic research failed: ${e.message}`); }
      const b = pickIdea();
      if (b) {
        st.assigned = { topic: b.topic, angle: b.angle, hook: b.hook, notes: b.notes, bankId: b.id };
        markIdea(b.id, 'queued', runId);
        updateRun(runId, { topic: b.topic });
        log.info(`topic from the pool: "${b.topic}" (${b.category || 'general'})`);
      } else {
        log.warn('the topic pool is empty — the planner picks a topic from today\'s trends');
        st.candidates = await discover(log);
      }
    });

    await stage('plan', async () => {
      if (planFile) {
        st.plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        const fresh = checkFresh(st.plan.topic, st.plan.angle, st.plan.keywords, cfg.variety.dedupDays, cfg.variety.similarityThreshold);
        if (!fresh.ok) log.warn(`supplied plan is close to past topic "${fresh.match.topic}" (${fresh.score.toFixed(2)})`);
      } else {
        setProgress({ detail: st.assigned ? `Claude is researching "${st.assigned.topic}" and writing the script — usually 3–6 min` : 'Claude is choosing a topic and fact-checking it with web search — usually 3–8 min' });
        st.plan = await makePlan({ candidates: st.candidates || [], log, cwd: dir, assigned: st.assigned, lite: bespoke });
        if (st.assigned?.bankId) markIdea(st.assigned.bankId, 'used', runId);
        // Not enough real stock of the subject? Draw it instead of filling the video with wrong photos.
        const avail = bespoke ? null : await stockAvailability(st.plan, log);
        if (avail && !style) {
          log.info(`stock for "${st.plan.subject?.name}": ${avail.photos} relevant photos, ${avail.videos} videos`);
          const footage = ['documentary', 'newsflash'].includes(st.plan.style);
          if (footage && avail.videos < 6) {
            const to = new Date().getDate() % 2 ? 'crayon' : 'mascot';
            log.warn(`too little footage for a ${st.plan.style} video — switching to hand-drawn ${to}`);
            st.plan.style = to; st.plan.drawn = true;
            st.plan.scenes.forEach(s => { if (s.visual?.kind === 'image' || to === 'crayon') s.visual = { ...s.visual, kind: s.visual.kind === 'image' ? 'drawing' : s.visual.kind, svg: '' }; });
            setProgress({ detail: 'Drawing every scene (not enough real footage of this subject)' });
            await repairDrawings(st.plan, log, dir);
          } else if (!footage && st.plan.style !== 'crayon' && avail.photos < 6) {
            log.warn('too few real photos of the subject — photo scenes become drawings');
            st.plan.drawn = true;
            st.plan.scenes.forEach(s => { if (s.visual?.kind === 'image') s.visual = { ...s.visual, kind: 'drawing', svg: '' }; });
            await repairDrawings(st.plan, log, dir);
          }
        }
      }
      if (style) st.plan.style = style;
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
      updateRun(runId, { topic: st.plan.topic, style: bespoke ? 'bespoke' : st.plan.style, title: st.plan.title });
    });

    await stage('voice', async () => {
      const voice = pickVoice(runId);
      let rate = voice.rate;
      for (let attempt = 0; attempt < 3; attempt++) {
        setProgress({ detail: `Recording narration (${voice.voice.replace(/^\w\w-\w\w-|Multilingual|Neural/g, '')})` });
        const v = await narrate(st.plan.scenes, dir, { ...voice, rate }, log);   // per-scene, energetic delivery
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

    const build = () => {
      const timings = sceneTimings(st.plan.scenes, st.voice.words, st.voice.duration + TAIL);
      const seed = Math.abs([...runId].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 100000;
      const spec = composeSpec({ plan: st.plan, timings, words: st.voice.words, voiceDelay: VOICE_DELAY, duration: +st.voice.total.toFixed(2), seed, cfg });
      return { spec, html: st.film?.ok ? path.join(dir, 'film', 'index.html') : writeComp(dir, spec), seed };
    };

    await stage('direct', async () => {
      if (!bespoke) return;
      setProgress({ detail: 'Animation director is designing a bespoke film — usually 20–60 min' });
      const { spec } = build();
      try {
        const f = await directFilm({ dir, spec, plan: st.plan, log, setProgress, language: st.language });
        st.film = { ok: true, score: f.score, rounds: f.rounds, language: f.language };
        st.qa = { score: f.score, pass: true, issues: [], rounds: f.rounds, director: true };
        updateRun(runId, { style: f.language || 'bespoke' });
        log.info(`bespoke film ready — ${f.language || 'unnamed language'} (review ${f.score ?? '?'}/10 after ${f.rounds ?? '?'} round(s))`);
      } catch (e) {
        if (e.cancelled || e.limit) throw e;
        st.film = { ok: false, error: e.message };
        if (cfg.direction?.fallback === false) throw e;
        log.warn(`director mode failed (${e.message}) — falling back to a template engine`);
        st.plan = await liteToTemplate(st.plan, log, dir);   // a script-only plan gets template visuals now
        fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
        updateRun(runId, { style: st.plan.style });
      }
    });

    await stage('media', async () => {
      if (st.film?.ok) return;
      st.credits = await fetchMedia(st.plan, dir, log);
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
    });

    await stage('qa', async () => {
      if (st.film?.ok) return;   // the director loop already had its own independent review
      setProgress({ detail: 'Rendering one still per scene and asking Claude to review them' });
      let { spec, html } = build();
      let r = await reviewStills(html, spec, st.plan, dir, log);
      st.qa = { score: r.score, pass: r.pass, issues: r.issues, rounds: 0 };
      // Up to two fix rounds: apply Claude's replacement visuals, fetch any new photos, review again.
      for (let round = 1; round <= 2 && !r.pass && r.patches?.length; round++) {
        for (const p of r.patches) {
          const s = st.plan.scenes[p.scene - 1];
          if (!s || !p.visual?.kind) continue;
          // a drawn video stays drawn: QA may not swap a drawing back to a stock photo
          if (st.plan.drawn && p.visual.kind === 'image') p.visual = { ...p.visual, kind: 'drawing', svg: '' };
          const newBroll = p.visual.broll && p.visual.broll !== s.visual.broll;
          s.visual = { ...p.visual, broll: p.visual.broll || s.visual.broll, img: newBroll ? undefined : s.visual.img, video: newBroll ? undefined : s.visual.video };
        }
        setProgress({ detail: `Fixing ${r.patches.length} scene(s) flagged by QA (round ${round})` });
        await repairDrawings(st.plan, log, dir);
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
        workers: !st.film?.ok && ['documentary', 'newsflash'].includes(st.plan.style) ? 3 : undefined,   // footage pages are heavier
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

    // Publishing: one slot per video, shared by YouTube and the Facebook Page; each platform is skipped when not connected.
    const publishGate = () => {
      if (!upload) { log.info('upload disabled for this run — video ready in the dashboard'); return false; }
      if (st.held && !forceUpload) { log.warn('not uploading: held for review (use "Upload & schedule" in the dashboard to publish it anyway)'); return false; }
      const fbOn = cfg.facebook?.enabled !== false && fbConnected(), ttOn = cfg.tiktok?.enabled !== false && ttConnected();
      if (!isConnected() && !fbOn && !ttOn) throw new Error('No platform is connected (YouTube, Facebook Page or TikTok — see Setup)');
      // a video already scheduled on YouTube keeps that slot on Facebook too (if it's still ahead)
      const yt = st.youtube?.publishAt && new Date(st.youtube.publishAt).getTime() > Date.now() + 20 * 60_000 ? st.youtube.publishAt : null;
      // a slot picked by an earlier attempt that has since passed is replaced by the next free one
      if (st.publishAt && new Date(st.publishAt).getTime() < Date.now() + 20 * 60_000 && !st.youtube) st.publishAt = null;
      st.publishAt ||= yt || nextFreeSlot(cfg.schedule);
      return true;
    };

    if (!only || only === 'youtube') await stage('upload', async () => {
      if (!publishGate()) return;
      if (!isConnected()) { log.warn('YouTube is not connected — skipping YouTube for this video'); return; }
      setProgress({ detail: 'Uploading to YouTube and scheduling' });
      const p = st.plan;
      const publishAt = st.publishAt;
      const src = (p.sources || []).filter(s => s.url).map(s => `• ${s.title || ''} ${s.url}`.trim()).slice(0, 6).join('\n');
      const description = [p.description.replace(/\s*Sources:[\s\S]*$/i, '').trim(), src ? `\nSources:\n${src}` : '', st.credits?.length ? `\nStock footage — ${st.credits.slice(0, 5).join(', ')}` : '', '\nVoice and animation are AI-assisted; facts checked against the sources above.'].join('\n');
      const tags = [...new Set([...(p.tags || []), ...cfg.youtube.defaultTags])].slice(0, 20);
      const title = /#shorts/i.test(p.title) ? p.title : p.title;
      const id = await uploadVideo(st.video, { title, description, tags, categoryId: cfg.youtube.categoryId, publishAt, madeForKids: cfg.youtube.madeForKids, synthetic: cfg.youtube.containsSyntheticMedia }, log);
      st.youtube = { id, publishAt };
      updateRun(runId, { youtube_id: id, publish_at: publishAt });
    });

    if (!only || only === 'facebook') await stage('facebook', async () => {
      if (cfg.facebook?.enabled === false) return;
      if (!publishGate()) return;
      if (!fbConnected()) { log.warn('Facebook Page is not connected — skipping Facebook for this video'); return; }
      if (st.voice?.total > 90) { log.warn(`video is ${st.voice.total.toFixed(0)} s; Facebook Reels allow at most 90 s — skipping Facebook`); return; }
      setProgress({ detail: 'Uploading the Reel to your Facebook Page and scheduling it' });
      const p = st.plan;
      const tags = [...new Set([...(p.tags || []).slice(0, 5), ...(cfg.facebook?.hashtags || [])])].map(t => '#' + t.replace(/[^\p{L}\p{N}]/gu, '')).join(' ');
      const src = (p.sources || []).filter(s => s.url).slice(0, 4).map(s => `• ${s.url}`).join('\n');
      const body = p.description.replace(/\s*Sources:[\s\S]*$/i, '').replace(/#\w+/g, '').trim();
      const credits = st.credits?.length ? `\n\nStock footage: ${st.credits.slice(0, 5).join('; ')}` : '';
      const description = `${p.title}\n\n${body}${src ? `\n\nSources:\n${src}` : ''}${credits}\n\nVoice and animation are AI-assisted; facts checked against the sources above.\n\n${tags}`;
      const r = await uploadReel(st.video, { title: p.title, description, publishAt: st.publishAt }, log);
      st.facebookPost = r;
      // the Reel's slot is recorded on its own, so the next video can't be given the same slot
      updateRun(runId, { facebook_id: r.id, fb_publish_at: r.publishAt, ...(st.youtube ? {} : { publish_at: r.publishAt }) });
    });

    // TikTok: the video goes to your TikTok inbox as a draft (open the notification in TikTok, paste the caption, post)
    if (!only || only === 'tiktok') await stage('tiktok', async () => {
      if (cfg.tiktok?.enabled === false) return;
      if (!publishGate()) return;
      if (!ttConnected()) { log.warn('TikTok is not connected — skipping TikTok for this video'); return; }
      setProgress({ detail: 'Sending the video to your TikTok drafts' });
      const r = await sendDraft(st.video, log);
      st.tiktok = { ...r, caption: ttCaption(st.plan, cfg), postAt: st.publishAt, at: new Date().toISOString() };
      updateRun(runId, { tiktok_id: r.id });
    });

    addUsage();
    log.info(`Claude usage for this video: ${(st.usage.tokens / 1e6).toFixed(1)}M context + ${(st.usage.out / 1e3).toFixed(0)}k output tokens (≈$${st.usage.usd} at API prices; on your subscription this counts against the usage limit)`);
    if (!st.recorded) { recordTopic(runId, st.plan); st.recorded = true; save(); }
    setQueueStatus(st.assigned?.queueId, 'done', { runId });
    const held = st.held && !st.youtube && !st.facebookPost && !st.tiktok;
    updateRun(runId, { status: held ? 'held' : 'done', stage: 'done', error: held ? `Held for review — ${st.held}` : null, meta: { qa: st.qa, film: st.film, usage: st.usage, tiktok: st.tiktok, voice: st.voice?.voice, sources: st.plan.sources, credits: st.credits } });
    log.info('✔ run complete');
    return getRun(runId);
  } catch (e) {
    if (e.cancelled) { log.warn('run cancelled — resume it later or start over'); updateRun(runId, { status: 'cancelled', error: 'Cancelled by you. Resume continues from the last completed stage.' }); }
    else if (e.limit) {
      // Claude subscription usage limit: pause; the daily worker / scheduler resumes this run after the reset
      kvSet('claudeLimitUntil', e.resetAt);
      const at = new Date(e.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      log.warn(`paused: Claude usage limit reached — resumes after ${at}`);
      updateRun(runId, { status: 'interrupted', error: `Paused: your Claude usage limit was reached. It resumes automatically after ${at} (or press Resume then).` });
    }
    else { log.error(e.stack || e.message); updateRun(runId, { status: 'failed', error: String(e.message).slice(0, 2000) }); }
    // a queue item that is paused, cancelled or failed once goes back to waiting (so a glitch doesn't lose it);
    // a second failure leaves it marked failed in the queue for you to retry or remove
    if (st.assigned?.queueId) {
      const tries = e.limit || e.cancelled ? 0 : (st.queueTries = (st.queueTries || 0) + 1);
      setQueueStatus(st.assigned.queueId, tries < 2 ? 'waiting' : 'failed', { runId, error: e.limit || e.cancelled ? null : String(e.message).slice(0, 300) });
    }
    throw e;
  } finally { usage.forbidden = null; addUsage(); save(); releaseLock(runId); kvSet('progress', null); if (cancelRequested(runId)) kvSet('cancel', null); }
}

/** Forget all completed stages so the next start redoes everything (new topic). */
export function resetRun(runId) {
  // "Start over" means a new topic: the old queue item goes back in the queue, a pool idea is set aside as used
  const sf = path.join(RUNS, runId, 'state.json');
  const st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : {};
  if (st.assigned?.queueId) setQueueStatus(st.assigned.queueId, 'waiting', {});
  else if (st.assigned?.bankId) markIdea(st.assigned.bankId, 'rejected');
  fs.rmSync(sf, { force: true });
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
