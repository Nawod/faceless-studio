// Stock footage/photos from Pixabay and/or Pexels (both free for commercial use, no attribution required).
// Whichever keys are set are tried in order. Clips used in the last 90 days are skipped so no two videos share footage.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { env } from './config.js';
import { kvGet, kvSet } from './db.js';

const NEEDS = {
  documentary: () => 'video',
  collage: v => (['image', 'stat', 'icons'].includes(v.kind) && v.broll ? 'photo' : null),
  kinetic: v => (v.kind === 'image' && v.broll ? 'photo' : null),
  crayon: v => (v.kind === 'image' && v.broll ? 'photo' : null),
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
const matches = (text, must) => !must?.length || must.some(w => String(text || '').toLowerCase().includes(stem(w)));

// ---------- Pexels ----------
const pexels = {
  name: 'Pexels', enabled: () => !!env('PEXELS_API_KEY'),
  get: url => getJson(url, { Authorization: env('PEXELS_API_KEY') }),
  async video(q, ids, must) {
    let vids = (await this.get(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`)).videos || [];
    if (vids.length < 3) vids = vids.concat((await this.get(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=15`)).videos || []);
    for (const v of vids) {
      if (ids.has(`v${v.id}`) || v.duration < 4 || !matches(v.url, must)) continue;   // the page slug describes the clip
      const f = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.height >= 720).sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920))[0];
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
      const f = ['large', 'medium'].map(k => h.videos[k]).find(f => f?.url && Math.min(f.width, f.height) >= 720);
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
async function findRelevant(kind, q, ids, log, subjectWords) {
  const qWords = keyWords(q);
  const about = qWords.filter(w => subjectWords.includes(w));
  const must = about.length ? about : qWords;          // query mentions the subject → the subject must be in the tags
  let hit = await find(kind, q, ids, log, must);
  if (!hit && must.length) hit = await find(kind, must.join(' '), ids, log, must);
  return hit;
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
  if (plan.subject?.broll && !plan.subject.img) {
    try {
      // the subject photo may repeat across videos, but it must really be the subject
      const hit = await findRelevant('photo', plan.subject.broll, new Set(), log, subjectWords.length ? subjectWords : keyWords(plan.subject.broll));
      if (hit) {
        const file = path.join(adir, `subject.${hit.ext}`);
        await download(hit.url, file);
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
      let hit = await findRelevant(kind, q, ids, log, subjectWords);
      if (!hit && kind === 'video') hit = await findRelevant('photo', q, ids, log, subjectWords);
      if (!hit && kind === 'video' && plan.subject?.name) hit = await findRelevant('video', plan.subject.name, ids, log, subjectWords);
      if (!hit) { log.warn(`no on-topic stock media for "${q}" — the scene uses the subject photo/drawing instead`); continue; }
      const file = path.join(adir, `${String(i).padStart(2, '0')}.${hit.ext}`);
      await download(hit.url, file);
      s.visual[hit.ext === 'mp4' ? 'video' : 'img'] = pathToFileURL(file).href;
      ids.add(hit.id); used.push({ id: hit.id, at: Date.now() });
      if (hit.credit) credits.push(`${hit.source}: ${hit.credit}`);
      log.info(`scene ${i + 1}: ${hit.source} ${hit.ext === 'mp4' ? 'video' : 'photo'} for "${q}"`);
    } catch (e) { log.warn(`stock media failed for "${q}": ${e.message}`); }
  }
  kvSet('pexels_used', used);
  return [...new Set(credits)];
}
