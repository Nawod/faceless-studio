// Publishing a finished video to YouTube, the Facebook Page and TikTok drafts. Pure API work — no AI.
// Used by the pipeline's last stages, and by publish tasks that run in parallel (up to 3 at once) outside the
// production lock, so uploads never wait for a video that is being made.
import fs from 'node:fs';
import path from 'node:path';
import { channel, RUNS } from './config.js';
import { updateRun, getRun, kvGet, kvSet } from './db.js';
import { makeLogger } from './log.js';
import { uploadVideo, nextFreeSlot, isConnected } from './youtube.js';
import { uploadReel, fbConnected } from './facebook.js';
import { sendDraft, ttConnected, ttCaption } from './tiktok.js';

const AHEAD = 20 * 60_000;
const future = iso => iso && new Date(iso).getTime() > Date.now() + AHEAD;

/** Reserve a publish slot the moment it is picked, so parallel uploads can never be given the same one. */
function holdSlot(iso) {
  const holds = Object.fromEntries(Object.entries(kvGet('slotHolds') || {}).filter(([, until]) => until > Date.now()));
  holds[new Date(iso).toISOString().slice(0, 16)] = Date.now() + 3 * 3600_000;   // until the upload has recorded it
  kvSet('slotHolds', holds);
}

/**
 * The ONE publish time a video uses on every platform. Once a video has a time (from its first upload, or an earlier
 * attempt), YouTube, Facebook and TikTok all use that same time, also when you resume or upload later. If that time
 * has already passed, the video is published now (returns null). A video without a time gets the next free slot.
 */
export function pickSlot(st, cfg = channel(), runId = null) {
  const r = runId ? getRun(runId) : null;
  const known = st.publishAt || st.youtube?.publishAt || st.facebookPost?.publishAt || st.tiktok?.postAt || r?.publish_at || r?.fb_publish_at;
  if (known) {
    st.publishAt = known;
    return future(known) ? known : null;   // passed → publish now
  }
  st.publishAt = nextFreeSlot(cfg.schedule);
  holdSlot(st.publishAt);
  return st.publishAt;
}
const when = at => (at ? `at ${at}` : 'now (its shared publish time has passed)');

export async function toYouTube(runId, st, log, cfg = channel()) {
  if (!isConnected()) { log.warn('YouTube is not connected — skipping YouTube for this video'); return false; }
  const p = st.plan, publishAt = pickSlot(st, cfg, runId);
  log.info(`youtube: publishing ${when(publishAt)}`);
  const src =(p.sources || []).filter(s => s.url).map(s => `• ${s.title || ''} ${s.url}`.trim()).slice(0, 6).join('\n');
  const description = [p.description.replace(/\s*Sources:[\s\S]*$/i, '').trim(), src ? `\nSources:\n${src}` : '', st.credits?.length ? `\nStock footage — ${st.credits.slice(0, 5).join(', ')}` : '', '\nVoice and animation are AI-assisted; facts checked against the sources above.'].join('\n');
  const tags = [...new Set([...(p.tags || []), ...cfg.youtube.defaultTags])].slice(0, 20);
  const id = await uploadVideo(st.video, { title: p.title, description, tags, categoryId: cfg.youtube.categoryId, publishAt, madeForKids: cfg.youtube.madeForKids, synthetic: cfg.youtube.containsSyntheticMedia }, log);
  const at = publishAt || new Date().toISOString();
  st.youtube = { id, publishAt: at };
  updateRun(runId, { youtube_id: id, publish_at: at });
  return true;
}

export async function toFacebook(runId, st, log, cfg = channel()) {
  if (cfg.facebook?.enabled === false) return false;
  if (!fbConnected()) { log.warn('Facebook Page is not connected — skipping Facebook for this video'); return false; }
  if (st.voice?.total > 90) { log.warn(`video is ${st.voice.total.toFixed(0)} s; Facebook Reels allow at most 90 s — skipping Facebook`); return false; }
  const p = st.plan, publishAt = pickSlot(st, cfg, runId);
  log.info(`facebook: publishing ${when(publishAt)}`);
  const tags = [...new Set([...(p.tags || []).slice(0, 5), ...(cfg.facebook?.hashtags || [])])].map(t => '#' + t.replace(/[^\p{L}\p{N}]/gu, '')).join(' ');
  const src = (p.sources || []).filter(s => s.url).slice(0, 4).map(s => `• ${s.url}`).join('\n');
  const body = p.description.replace(/\s*Sources:[\s\S]*$/i, '').replace(/#\w+/g, '').trim();
  const credits = st.credits?.length ? `\n\nStock footage: ${st.credits.slice(0, 5).join('; ')}` : '';
  const description = `${p.title}\n\n${body}${src ? `\n\nSources:\n${src}` : ''}${credits}\n\nVoice and animation are AI-assisted; facts checked against the sources above.\n\n${tags}`;
  const r = await uploadReel(st.video, { title: p.title, description, publishAt }, log);
  st.facebookPost = r;
  // the Reel's slot is recorded on its own, so the next video can't be given the same slot
  updateRun(runId, { facebook_id: r.id, fb_publish_at: r.publishAt, ...(st.youtube ? {} : { publish_at: r.publishAt }) });
  return true;
}

// TikTok: the video goes to your TikTok inbox as a draft (open the notification in TikTok, paste the caption, post)
export async function toTikTok(runId, st, log, cfg = channel()) {
  if (cfg.tiktok?.enabled === false) return false;
  if (!ttConnected()) { log.warn('TikTok is not connected — skipping TikTok for this video'); return false; }
  const r = await sendDraft(st.video, log);
  // a draft can't be scheduled: post it at the shared time (or now, if that has passed)
  st.tiktok = { ...r, caption: ttCaption(st.plan, cfg), postAt: pickSlot(st, cfg, runId) || new Date().toISOString(), at: new Date().toISOString() };
  updateRun(runId, { tiktok_id: r.id });
  return true;
}

const PLATFORMS = { youtube: { stage: 'upload', fn: toYouTube, has: r => r.youtube_id }, facebook: { stage: 'facebook', fn: toFacebook, has: r => r.facebook_id }, tiktok: { stage: 'tiktok', fn: toTikTok, has: r => r.tiktok_id } };

/**
 * A publish task for a finished video (no production lock, no AI): publish to the given platforms that don't have it
 * yet, one after another, saving progress after each. Several of these run side by side for different videos.
 */
export async function publishRun(runId, platforms = ['youtube', 'facebook', 'tiktok']) {
  const dir = path.join(RUNS, runId), sf = path.join(dir, 'state.json');
  const log = makeLogger(runId);
  if (!fs.existsSync(path.join(dir, 'final.mp4'))) throw new Error('this run has no finished video');
  const st = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, 'utf8')) : { done: [] };
  st.video = path.join(dir, 'final.mp4');
  const save = () => fs.writeFileSync(sf, JSON.stringify(st, null, 1));
  const done = [];
  try {
    for (const name of platforms) {
      const pl = PLATFORMS[name], r = getRun(runId);
      if (!pl || pl.has(r)) continue;
      log.info(`▶ publishing to ${name}`);
      if (await pl.fn(runId, st, log)) done.push(name);
      st.done = [...new Set([...(st.done || []), pl.stage])]; save();
    }
  } finally { save(); }
  const r = getRun(runId);
  // a held, failed or interrupted video that is now out on a platform is finished
  if (['held', 'failed', 'interrupted', 'cancelled'].includes(r.status) && (r.youtube_id || r.facebook_id || r.tiktok_id)) updateRun(runId, { status: 'done', stage: 'done', error: null });
  log.info(done.length ? `✔ published to ${done.join(', ')}` : 'nothing new to publish');
  return done;
}
