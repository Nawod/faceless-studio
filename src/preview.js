// Build a composition from a plan without TTS/Claude, for checking engines by eye.
//   node src/preview.js [style] [plan.json]   → prints the file URL to open (?play or ?t=12)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { channel, DATA, ROOT } from './config.js';
import { composeSpec, writeComp } from './compose.js';

const style = process.argv[2] || 'kinetic';
const planFile = process.argv[3] || path.join(ROOT, 'fixtures', 'sample-plan.json');
const plan = { ...JSON.parse(fs.readFileSync(planFile, 'utf8')), style };
const cfg = channel();

// Fake word timings at ~2.7 words/s with small pauses between sentences.
const words = []; let t = 0.1;
const timings = plan.scenes.map(s => {
  const start = t;
  for (const w of s.narration.split(/\s+/)) { const d = 0.17 + w.length * 0.035; words.push({ word: w, start: +t.toFixed(3), end: +(t + d).toFixed(3) }); t += d + (/[.,!?]$/.test(w) ? 0.25 : 0.04); }
  return { start, end: t };
});
const duration = t + 1.2;
timings[timings.length - 1].end = duration;
const dir = path.join(DATA, 'preview', style);
fs.mkdirSync(dir, { recursive: true });
// use any images already in fixtures/media for image/broll scenes
const media = path.join(ROOT, 'fixtures', 'media');
const files = fs.existsSync(media) ? fs.readdirSync(media) : [];
plan.scenes.forEach((s, i) => {
  const img = files.find(f => /\.(jpe?g|png|webp)$/i.test(f) && f.startsWith(String(i)));
  const vid = files.find(f => /\.mp4$/i.test(f) && f.startsWith(String(i)));
  if (img) s.visual.img = pathToFileURL(path.join(media, img)).href;
  if (vid) s.visual.video = pathToFileURL(path.join(media, vid)).href;
});
const spec = composeSpec({ plan, timings, words, voiceDelay: 0, duration, seed: 3, cfg });
const html = writeComp(dir, spec);
console.log(pathToFileURL(html).href + '?play');
console.log(`duration ${duration.toFixed(1)}s, ${spec.scenes.length} scenes`);
