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
  crayon: () => null,
  blueprint3d: () => null,
  newsflash: () => 'video',
  mascot: v => (v.kind === 'image' && v.broll ? 'photo' : null),
  globe3d: v => (v.kind === 'image' && v.broll ? 'photo' : null),
};

async function getJson(url, headers = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

// ---------- Pexels ----------
const pexels = {
  name: 'Pexels', enabled: () => !!env('PEXELS_API_KEY'),
  get: url => getJson(url, { Authorization: env('PEXELS_API_KEY') }),
  async video(q, ids) {
    let vids = (await this.get(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`)).videos || [];
    if (vids.length < 3) vids = vids.concat((await this.get(`https://api.pexels.com/videos/search?query=${encodeURIComponent(q)}&per_page=15`)).videos || []);
    for (const v of vids) {
      if (ids.has(`v${v.id}`) || v.duration < 4) continue;
      const f = (v.video_files || []).filter(f => f.file_type === 'video/mp4' && f.height >= 720).sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920))[0];
      if (f) return { id: `v${v.id}`, url: f.link, ext: 'mp4', credit: v.user?.name };
    }
    return null;
  },
  async photo(q, ids) {
    for (const p of (await this.get(`https://api.pexels.com/v1/search?query=${encodeURIComponent(q)}&orientation=portrait&per_page=15`)).photos || []) {
      if (!ids.has(`p${p.id}`)) return { id: `p${p.id}`, url: p.src.large2x || p.src.large, ext: 'jpg', credit: p.photographer };
    }
    return null;
  },
};

// ---------- Pixabay (https://pixabay.com/api/docs/) — files must be downloaded, not hot-linked; we always download ----------
const pixabay = {
  name: 'Pixabay', enabled: () => !!env('PIXABAY_API_KEY'),
  async video(q, ids) {
    const j = await getJson(`https://pixabay.com/api/videos/?key=${env('PIXABAY_API_KEY')}&q=${encodeURIComponent(q.slice(0, 100))}&safesearch=true&per_page=20`);
    const hits = (j.hits || []).filter(h => !ids.has(`xv${h.id}`) && h.duration >= 4)
      .sort((a, b) => (b.videos.large?.height > b.videos.large?.width) - (a.videos.large?.height > a.videos.large?.width)); // portrait first
    for (const h of hits) {
      const f = ['large', 'medium'].map(k => h.videos[k]).find(f => f?.url && Math.min(f.width, f.height) >= 720);
      if (f) return { id: `xv${h.id}`, url: f.url, ext: 'mp4', credit: h.user };
    }
    return null;
  },
  async photo(q, ids) {
    const j = await getJson(`https://pixabay.com/api/?key=${env('PIXABAY_API_KEY')}&q=${encodeURIComponent(q.slice(0, 100))}&image_type=photo&safesearch=true&per_page=20`);
    const hits = (j.hits || []).filter(h => !ids.has(`xp${h.id}`)).sort((a, b) => (b.imageHeight > b.imageWidth) - (a.imageHeight > a.imageWidth));
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

async function find(kind, q, ids, log) {
  for (const p of PROVIDERS.filter(p => p.enabled())) {
    try { const hit = await p[kind](q, ids); if (hit) return { ...hit, source: p.name }; }
    catch (e) { log.warn(`${p.name} ${kind} search failed: ${e.message}`); }
  }
  return null;
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
  if (!wanted.some(Boolean)) return [];
  if (!PROVIDERS.some(p => p.enabled())) { log.warn('no stock media key (PIXABAY_API_KEY / PEXELS_API_KEY) — scenes fall back to graphics'); return []; }
  const adir = path.join(dir, 'assets'); fs.mkdirSync(adir, { recursive: true });
  const { used, ids } = usedSet();
  const credits = [];
  for (const [i, s] of plan.scenes.entries()) {
    const kind = wanted[i]; if (!kind) continue;
    const q = s.visual.broll || s.visual.heading || plan.topic;
    try {
      let hit = await find(kind, q, ids, log);
      if (!hit && kind === 'video') hit = await find('video', plan.keywords?.[0] || plan.topic, ids, log);
      if (!hit && kind === 'video') hit = await find('photo', q, ids, log);
      if (!hit) { log.warn(`no stock media for "${q}"`); continue; }
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
