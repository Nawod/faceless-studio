// Builds the composition folder for a run: index.html + spec.js consumed by engines/<style>.js
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.js';

const ENGINES = path.join(ROOT, 'engines');
const PALETTES = {
  kinetic: ['#FF4A1C', '#2F6BFF', '#00A86B', '#7B3FF2', '#FF2D55', '#FF9500'],
  collage: ['#E63B2E', '#F5C518', '#1FA39A', '#6B4EFF', '#2D5BFF', '#FF7A1A'],
  crayon: ['#E4572E', '#29A3D6', '#F2B134', '#5BA84F', '#C45AB3'],
  documentary: ['#FFD60A', '#FFD60A', '#7CFF6B', '#FFB703'],
  blueprint3d: ['#7FE7FF', '#FFD166', '#9BF6A0'],
  mascot: ['#FF5A36', '#7B4DFF', '#00B37E', '#FF2E88', '#1E88FF'],
  globe3d: ['#FFD23F', '#3DF5A7', '#FF5DA2', '#5CE1E6'],
  newsflash: ['#E10600', '#E10600', '#FFB800'],
};

// A scene that asks for a picture but has none gets the subject's photo / drawing, never an empty frame.
const FOOTAGE = ['documentary', 'newsflash'];
function withSubject(v = {}, subject, style) {
  if (!subject) return v;
  if (FOOTAGE.includes(style) && !v.img && !v.video && subject.img) return { ...v, img: subject.img };
  if (v.kind === 'image' && !v.img && !v.video && subject.img) return { ...v, img: subject.img };
  if (v.kind === 'image' && !v.img && !v.video && !subject.img && subject.svg) return { ...v, kind: 'drawing', svg: subject.svg };
  if (v.kind === 'drawing' && !(v.svg || '').trim() && subject.svg) return { ...v, svg: subject.svg };
  return v;
}

export function composeSpec({ plan, timings, words, voiceDelay, duration, seed, cfg }) {
  const pal = PALETTES[plan.style] || PALETTES.kinetic;
  const accent = /^#[0-9a-f]{6}$/i.test(plan.accent || '') && !['blueprint3d', 'documentary', 'newsflash'].includes(plan.style) ? plan.accent : pal[seed % pal.length];
  return {
    W: cfg.video.width, H: cfg.video.height, fps: cfg.video.fps,
    style: plan.style, accent, seed, duration, title: plan.title, mood: plan.mood,
    keywords: plan.keywords || [],
    sources: (plan.sources || []).slice(0, 3),
    cta: 'Follow for more',
    brand: cfg.brand ? {
      name: cfg.channelName, handle: cfg.brand.handle,
      globe: pathToFileURL(path.join(ROOT, cfg.brand.watermark)).href,
      wordmark: pathToFileURL(path.join(ROOT, cfg.brand.wordmark)).href,
    } : null,
    subject: plan.subject ? { name: plan.subject.name, img: plan.subject.img || null, svg: plan.subject.svg || '' } : null,
    scenes: plan.scenes.map((s, i) => ({ narration: s.narration, visual: withSubject(s.visual, plan.subject, plan.style), start: timings[i].start + (i ? voiceDelay : 0), end: timings[i].end + voiceDelay })),
    words: words.map(w => ({ word: w.word, start: +(w.start + voiceDelay).toFixed(3), end: +(w.end + voiceDelay).toFixed(3) })),
  };
}

// Extra scripts some engines need before they load (Three.js via its CommonJS build + an exports shim).
const DEPS = {
  globe3d: eng => [`data:text/javascript,window.exports={};`, pathToFileURL(path.join(ROOT, 'node_modules', 'three', 'build', 'three.cjs')).href, `data:text/javascript,window.THREE=window.exports;`, `${eng}/data/land.js`],
};

export function writeComp(dir, spec) {
  const comp = path.join(dir, 'comp');
  fs.mkdirSync(comp, { recursive: true });
  const eng = pathToFileURL(ENGINES).href;
  const deps = (DEPS[spec.style]?.(eng) || []).map(src => `<script src="${src}"></script>`).join('\n');
  fs.writeFileSync(path.join(comp, 'spec.js'), `window.SPEC = ${JSON.stringify(spec)};`);
  fs.writeFileSync(path.join(comp, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${eng}/fonts/fonts.css">
<style>html,body{margin:0;width:${spec.W}px;height:${spec.H}px;overflow:hidden;background:#000}#stage{position:relative;width:${spec.W}px;height:${spec.H}px;overflow:hidden}</style>
<script src="spec.js"></script><script src="${eng}/common.js"></script>
</head><body><div id="stage"></div>
${deps}
<script src="${eng}/${spec.style}.js"></script>
<script src="${eng}/brand.js"></script>
<script src="${eng}/preview.js"></script>
</body></html>`);
  return path.join(comp, 'index.html');
}

/** Sound design cues derived from the timeline: whoosh on cuts, pops for list items, ticks for counters, a riser into the payoff. */
export function sfxEvents(spec) {
  const ev = [];
  spec.scenes.forEach((s, i) => {
    if (i > 0) ev.push({ t: s.start, type: spec.style === 'crayon' ? 'pop' : 'whoosh', gain: 0.7 });
    const v = s.visual || {}, dur = s.end - s.start;
    if (v.kind === 'list' || v.kind === 'timeline') {
      const n = Math.min(4, (v.items || []).length), step = Math.max(0.45, (dur - 0.8) / Math.max(1, n));
      for (let k = 0; k < n; k++) ev.push({ t: s.start + 0.25 + k * step, type: 'pop', gain: 0.6 });
    }
    if (v.kind === 'stat') { ev.push({ t: s.start + 0.15, type: 'riser', gain: 0.35 }); ev.push({ t: s.start + Math.min(1.8, dur * 0.55) + 0.1, type: 'ding', gain: 0.5 }); }
    if (v.kind === 'compare') ev.push({ t: s.start + 0.5, type: 'thud', gain: 0.7 });
    if (v.kind === 'icons') ev.push({ t: s.start + 0.1, type: 'pop', gain: 0.5 });
  });
  const last = spec.scenes[spec.scenes.length - 1];
  if (last) ev.push({ t: last.start, type: 'riser', gain: 0.4 });
  return ev;
}
