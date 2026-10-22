// Stock footage/photos from Pixabay and/or Pexels (both free for commercial use, no attribution required).
// Whichever keys are set are tried in order. Clips used in the last 90 days are skipped so no two videos share footage.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { env, bins } from './config.js';
import { kvGet, kvSet } from './db.js';

const run = promisify(execFile);

/**
 * Stock files can be huge (4K clips of 250 MB). Every clip is cut to ≤ 10 s, cropped to 1080×1920 and re-encoded
 * small; photos are scaled to ≤ 1600 px. Keeps each render page light so Chrome never runs out of memory.
 */
async function normalise(file, ext) {
  const tmp = file.replace(/(\.\w+)$/, '.raw$1');
  fs.renameSync(file, tmp);
  try {
    const args = ext === 'mp4'
      ? ['-y', '-loglevel', 'error', '-t', '10', '-i', tmp, '-an', '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]
      : ['-y', '-loglevel', 'error', '-i', tmp, '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', file];
    await run(bins.ffmpeg, args, { timeout: 180_000, windowsHide: true });
    fs.rmSync(tmp, { force: true });
  } catch (e) {
    fs.renameSync(tmp, file);                     // keep the original if conversion fails
    throw e;
  }
}

const NEEDS = {
  documentary: () => 'video',
  collage: v => (['image', 'stat', 'icons'].includes(v.kind) && v.broll ? 'photo' : null),
  kinetic: v => (v.kind === 'image' && v.broll ? 'photo' : null),
  crayon: () => null,                      // every crayon frame is hand-drawn
  blueprint3d: v => (v.kind === 'image' && v.broll ? 'photo' : null),
  newsflash: () => 'video',
  mascot: v => (v.kind === 'image' && v.broll ? 'photo' : null),
  globe3d: v => (v.kind === 'image' && v.broll ? 'photo' : null),
};

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

// Stock search engines return loose matches ("wombat standing grass" → a cat). A hit is only accepted
// when its own tags/description contain at least one of the `must` words.
const STOP = new Set('with from that this into over under their about very high close look like near'.split(' '));
export const keyWords = s => [...new Set(String(s || '').toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4 && !STOP.has(w)))];
const stem = w => w.replace(/(ies|es|s)$/, '');
// Brand safety + relevance: stock tagged with people or adult terms is never used unless the query is about people.
const PEOPLE = /\b(woman|women|girl|girls|man|men|boy|boys|lady|guy|people|person|model|models|nude|naked|bikini|lingerie|sexy|erotic|sensual|underwear|swimsuit|topless|portrait|selfie|fashion|beauty)\b/i;
const PEOPLE_QUERY = /\b(people|person|human|man|woman|child|kid|scientist|diver|pilot|astronaut|worker|crowd|doctor|soldier|athlete)\b/i;
let currentQuery = '';

// must = [words]  → any one word must appear;  must = { all: [words] } → every word must appear
const matches = (text, must) => {
  const t = String(text || '').toLowerCase();
  if (PEOPLE.test(t) && !PEOPLE_QUERY.test(currentQuery)) return false;
  if (must && !Array.isArray(must)) return (must.all || []).every(w => t.includes(stem(w)));
  return !must?.length || must.some(w => t.includes(stem(w)));
};

// The words a subject photo MUST be tagged with: "peacock mantis shrimp" → mantis + shrimp, "common wombat" → wombat.
const GENERIC = new Set('common giant great little small tiny huge big wild baby young adult real true famous strange weird deep'.split(' '));
export function subjectMust(name) {
  const w = keyWords(name).filter(x => !GENERIC.has(x));
  return { all: w.slice(-2) };
}

// ---------- Pexels ----------
const pexels = {
  name: 'Pexels', enabled: () => !!env('PEXELS_API_KEY'),
  get: url => getJson(url, { Authorization: env('PEXELS_API_KEY') }),
  async video(q, ids, must) {
    let vids = (await this.get(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`)).videos || [];
    if (vids.length < 3) vids = vids.concat((await this.get(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=15`)).videos || []);
    for (const v of vids) {
      if (ids.has(`v${v.id}`) || v.duration < 4 || !matches(v.url, must)) continue;   // the page slug describes the clip
      const f = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && Math.min(f.width, f.height) >= 720 && Math.max(f.width, f.height) <= 1920).sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920))[0];
      if (f) return { id: `v${v.id}`, url: f.link, ext: 'mp4', credit: v.user?.name };
    }
    return null;
  },
  async photo(q, ids, must) {
    for (const p of (await this.get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`)).photos || []) {
      if (!ids.has(`p${p.id}`) && matches(`${p.alt} ${p.url}`, must)) return { id: `p${p.id}`, url: p.src.large2x || p.src.large, ext: 'jpg', credit: p.photographer };
    }
    return null;
  },
};

// ---------- Pixabay (https://pixabay.com/api/docs/) — files must be downloaded, not hot-linked; we always download ----------
const pixabay = {
  name: 'Pixabay', enabled: () => !!env('PIXABAY_API_KEY'),
  async video(q, ids, must) {
    const j = await getJson(`https://pixabay.com/api/videos/?key=${env('PIXABAY_API_KEY')}&q=${encodeURIComponent(q.slice(0, 100))}&safesearch=true&per_page=30`);
    const hits = (j.hits || []).filter(h => !ids.has(`xv${h.id}`) && h.duration >= 4 && matches(h.tags, must))
      .sort((a, b) => (b.videos.large?.height > b.videos.large?.width) - (a.videos.large?.height > a.videos.large?.width)); // portrait first
    for (const h of hits) {
      const f = ['medium', 'large', 'small'].map(k => h.videos[k]).find(f => f?.url && Math.min(f.width, f.height) >= 720 && Math.max(f.width, f.height) <= 1920);
      if (f) return { id: `xv${h.id}`, url: f.url, ext: 'mp4', credit: h.user };
    }
    return null;
  },
  async photo(q, ids, must) {
    const j = await getJson(`https://pixabay.com/api/?key=${env('PIXABAY_API_KEY')}&q=${encodeURIComponent(q.slice(0, 100))}&image_type=photo&safesearch=true&per_page=30`);
    const hits = (j.hits || []).filter(h => !ids.has(`xp${h.id}`) && matches(h.tags, must)).sort((a, b) => (b.imageHeight > b.imageWidth) - (a.imageHeight > a.imageWidth));
    const h = hits[0];
    return h ? { id: `xp${h.id}`, url: h.largeImageURL, ext: 'jpg', credit: h.user } : null;
  },
};

const PROVIDERS = [pixabay, pexels];

function usedSet() {
  const cutoff = Date.now() - 90 * 86400_000;
  const used = (kvGet('pexels_used', []) || []).filter(u => u.at > cutoff);
  return { used, ids: new Set(used.map(u => u.id)) };
}

async function find(kind, q, ids, log, must) {
  for (const p of PROVIDERS.filter(p => p.enabled())) {
    try { const hit = await p[kind](q, ids, must); if (hit) return { ...hit, source: p.name }; }
    catch (e) { log.warn(`${p.name} ${kind} search failed: ${e.message}`); }
  }
  return null;
}

/** Search with a relevance filter; if the full query finds nothing on-topic, retry with just the key words. */
async function findRelevant(kind, q, ids, log, subjectWords, subjectName = '') {
  currentQuery = q;
  const qWords = keyWords(q);
  const aboutSubject = qWords.some(w => subjectWords.includes(w));
  // query is about the subject → the photo must be tagged with the subject's key words (all of them)
  const must = aboutSubject && subjectName ? subjectMust(subjectName) : qWords;
  let hit = await find(kind, q, ids, log, must);
  if (!hit && aboutSubject && subjectName) hit = await find(kind, subjectMust(subjectName).all.join(' '), ids, log, must);
  if (!hit && !aboutSubject && qWords.length) hit = await find(kind, qWords.join(' '), ids, log, qWords);
  return hit;
}

/** How much real stock exists for the subject: { photos, videos } relevant hits (Pixabay, up to 30 each). */
export async function stockAvailability(plan, log) {
  if (!env('PIXABAY_API_KEY') || !plan.subject?.name) return null;
  const must = subjectMust(plan.subject.name), q = encodeURIComponent((plan.subject.broll || plan.subject.name).slice(0, 100));
  const count = async (url, tags) => { try { const j = await getJson(url); return (j.hits || []).filter(h => matches(tags(h), must)).length; } catch (e) { log?.warn(`stock check failed: ${e.message}`); return 0; } };
  const key = env('PIXABAY_API_KEY');
  const [photos, videos] = await Promise.all([
    count(`https://pixabay.com/api/?key=${key}&q=${q}&image_type=photo&safesearch=true&per_page=30`, h => h.tags),
    count(`https://pixabay.com/api/videos/?key=${key}&q=${q}&safesearch=true&per_page=30`, h => h.tags),
  ]);
  return { photos, videos };
}

async function download(url, file) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
}

/** Mutates plan.scenes[].visual adding img/video file URLs. Returns credits like "Pixabay (name)". */
export async function fetchMedia(plan, dir, log) {
  const need = NEEDS[plan.style] || (() => null);
  const wanted = plan.scenes.map(s => need(s.visual || {}));
  if (!PROVIDERS.some(p => p.enabled())) { log.warn('no stock media key (PIXABAY_API_KEY / PEXELS_API_KEY) — scenes fall back to graphics'); return []; }
  const adir = path.join(dir, 'assets'); fs.mkdirSync(adir, { recursive: true });
  const { used, ids } = usedSet();
  const credits = [];
  // A real photo of the main subject, for every style: used wherever a scene asks for an image it couldn't get.
  const subjectWords = keyWords(plan.subject?.name || plan.subject?.broll);
  if (plan.subject?.broll && !plan.subject.img && plan.style !== 'crayon' && !plan.drawn) {
    try {
      // the subject photo may repeat across videos, but it must really be the subject
      const hit = await findRelevant('photo', plan.subject.broll, new Set(), log, subjectWords.length ? subjectWords : keyWords(plan.subject.broll), plan.subject.name);
      if (hit) {
        const file = path.join(adir, `subject.${hit.ext}`);
        await download(hit.url, file); await normalise(file, hit.ext);
        plan.subject.img = pathToFileURL(file).href;
        if (hit.credit) credits.push(`${hit.source}: ${hit.credit}`);
        log.info(`subject photo: ${hit.source} for "${plan.subject.broll}"`);
      } else log.warn(`no subject photo for "${plan.subject.broll}"`);
    } catch (e) { log.warn(`subject photo failed: ${e.message}`); }
  }
  for (const [i, s] of plan.scenes.entries()) {
    const kind = wanted[i]; if (!kind || s.visual.img || s.visual.video) continue;   // already has media
    const q = s.visual.broll || s.visual.heading || plan.topic;
    try {
      let hit = await findRelevant(kind, q, ids, log, subjectWords, plan.subject?.name);
      if (!hit && kind === 'video') hit = await findRelevant('photo', q, ids, log, subjectWords, plan.subject?.name);
      if (!hit && kind === 'video' && plan.subject?.name) hit = await findRelevant('video', plan.subject.name, ids, log, subjectWords, plan.subject?.name);
      if (!hit) { log.warn(`no on-topic stock media for "${q}" — the scene uses the subject photo/drawing instead`); continue; }
      const file = path.join(adir, `${String(i).padStart(2, '0')}.${hit.ext}`);
      await download(hit.url, file); await normalise(file, hit.ext);
      s.visual[hit.ext === 'mp4' ? 'video' : 'img'] = pathToFileURL(file).href;
      ids.add(hit.id); used.push({ id: hit.id, at: Date.now() });
      if (hit.credit) credits.push(`${hit.source}: ${hit.credit}`);
      log.info(`scene ${i + 1}: ${hit.source} ${hit.ext === 'mp4' ? 'video' : 'photo'} for "${q}"`);
    } catch (e) { log.warn(`stock media failed for "${q}": ${e.message}`); }
  }
  kvSet('pexels_used', used);
  return [...new Set(credits)];
}
