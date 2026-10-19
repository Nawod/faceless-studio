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
import { uploadVideo, nextSlot, isConnected } from './youtube.js';

const VOICE_DELAY = 0.15, TAIL = 2.2;   // tail leaves room for the brand end card

export function newRunId() {
  const d = new Date();
  return `${d.toISOString().slice(0, 10)}_${d.toTimeString().slice(0, 8).replace(/:/g, '')}`;
}

// One pipeline at a time (dashboard + Task Scheduler may both try).
function takeLock(runId) {
  const l = kvGet('lock');
  if (l && l.runId !== runId && Date.now() - l.at < 3 * 3600_000) {
    try { process.kill(l.pid, 0); throw new Error(`another run (${l.runId}) is in progress`); } catch (e) { if (e.code !== 'ESRCH') throw e; }
  }
  kvSet('lock', { runId, pid: process.pid, at: Date.now() });
}
const releaseLock = runId => { const l = kvGet('lock'); if (l?.runId === runId) kvSet('lock', null); };

export async function runPipeline({ runId = newRunId(), upload, planFile, style, onStage } = {}) {
  const cfg = channel();
  const dir = path.join(RUNS, runId);
  fs.mkdirSync(dir, { recursive: true });
  const log = makeLogger(runId);
  const stateFile = path.join(dir, 'state.json');
  const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { done: [] };
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(st, null, 1));
  const stage = async (name, fn) => {
    if (st.done.includes(name)) return;
    log.info(`▶ ${name}`); onStage?.(name);
    updateRun(runId, { stage: name });
    await fn();
    st.done.push(name); save();
  };
  if (!getRun(runId)) db.prepare('INSERT INTO runs (id, created_at, status) VALUES (?, ?, ?)').run(runId, now(), 'running');
  updateRun(runId, { status: 'running', error: null });
  upload ??= cfg.youtube.autoUpload;
  takeLock(runId);
  try {
    await stage('discover', async () => { st.candidates = planFile ? [] : await discover(log); });

    await stage('plan', async () => {
      if (planFile) {
        st.plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
        const fresh = checkFresh(st.plan.topic, st.plan.angle, st.plan.keywords, cfg.variety.dedupDays, cfg.variety.similarityThreshold);
        if (!fresh.ok) log.warn(`supplied plan is close to past topic "${fresh.match.topic}" (${fresh.score.toFixed(2)})`);
      } else st.plan = await makePlan({ candidates: st.candidates, log, cwd: dir });
      if (style) st.plan.style = style;
      fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
      updateRun(runId, { topic: st.plan.topic, style: st.plan.style, title: st.plan.title });
    });

    await stage('voice', async () => {
      const voice = pickVoice(runId);
      let rate = voice.rate;
      for (let attempt = 0; attempt < 3; attempt++) {
        const text = st.plan.scenes.map(s => s.narration).join(' ');
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
      let { spec, html } = build();
      const r = await reviewStills(html, spec, st.plan, dir, log);
      st.qa = { score: r.score, pass: r.pass, issues: r.issues };
      if (!r.pass && r.patches?.length) {
        for (const p of r.patches) {
          const s = st.plan.scenes[p.scene - 1];
          if (s && p.visual?.kind) s.visual = { ...p.visual, broll: s.visual.broll, img: s.visual.img, video: s.visual.video };
        }
        fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
        ({ spec, html } = build());
        const r2 = await reviewStills(html, spec, st.plan, dir, log);
        st.qa.after = { score: r2.score, pass: r2.pass, issues: r2.issues };
      }
    });

    await stage('render', async () => {
      const { spec, html, seed } = build();
      const silent = path.join(dir, 'video_silent.mp4');
      await renderVideo(html, { duration: spec.duration, fps: cfg.video.fps, W: spec.W, H: spec.H, out: silent, log });
      const { music, sfx } = await makeMusicAndSfx(dir, spec.duration, st.plan.mood || 'curious', seed, sfxEvents(spec), log);
      const mixed = await mixAudio({ voice: path.join(dir, 'voice.mp3'), music, sfx, voiceDelay: VOICE_DELAY, seconds: spec.duration, out: path.join(dir, 'mix.wav') });
      st.video = await mux(silent, mixed, path.join(dir, 'final.mp4'));
      fs.rmSync(silent, { force: true });
      updateRun(runId, { video_path: st.video, duration: spec.duration });
    });

    await stage('upload', async () => {
      if (!upload) { log.info('upload disabled for this run — video ready in the dashboard'); return; }
      if (!isConnected()) throw new Error('YouTube is not connected');
      const p = st.plan;
      const publishAt = nextSlot(cfg.schedule.publishAtUTC, cfg.schedule.leadDays);
      const src = (p.sources || []).filter(s => s.url).map(s => `• ${s.title || ''} ${s.url}`.trim()).slice(0, 6).join('\n');
      const description = [p.description.replace(/\s*Sources:[\s\S]*$/i, '').trim(), src ? `\nSources:\n${src}` : '', st.credits?.length ? `\nStock footage — ${st.credits.slice(0, 5).join(', ')}` : '', '\nVoice and animation are AI-assisted; facts checked against the sources above.'].join('\n');
      const tags = [...new Set([...(p.tags || []), ...cfg.youtube.defaultTags])].slice(0, 20);
      const title = /#shorts/i.test(p.title) ? p.title : p.title;
      const id = await uploadVideo(st.video, { title, description, tags, categoryId: cfg.youtube.categoryId, publishAt, madeForKids: cfg.youtube.madeForKids, synthetic: cfg.youtube.containsSyntheticMedia }, log);
      st.youtube = { id, publishAt };
      updateRun(runId, { youtube_id: id, publish_at: publishAt });
    });

    if (!st.recorded) { recordTopic(runId, st.plan); st.recorded = true; save(); }
    updateRun(runId, { status: 'done', stage: 'done', meta: { qa: st.qa, voice: st.voice?.voice, sources: st.plan.sources, credits: st.credits } });
    log.info('✔ run complete');
    return getRun(runId);
  } catch (e) {
    log.error(e.stack || e.message);
    updateRun(runId, { status: 'failed', error: String(e.message).slice(0, 2000) });
    throw e;
  } finally { save(); releaseLock(runId); }
}

export function todaysRun() {
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare("SELECT * FROM runs WHERE id LIKE ? AND status IN ('running','done') ORDER BY created_at DESC").get(`${today}%`);
}
