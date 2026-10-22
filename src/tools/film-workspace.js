// Create a bespoke-film workspace from a plan WITHOUT voice (fake word timings) — for kit development and tests.
//   node src/tools/film-workspace.js <plan.json> <outDir>   → <outDir>/film/index.html (+ spec.js); you add film/film.js
import fs from 'node:fs';
import path from 'node:path';
import { channel } from '../config.js';
import { composeSpec, writeFilmPage } from '../compose.js';

const [planFile, outDir] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const words = []; let t = 0.1;
const timings = plan.scenes.map(s => {
  const start = t;
  for (const w of s.narration.split(/\s+/)) { const d = 0.17 + w.length * 0.035; words.push({ word: w, start: +t.toFixed(3), end: +(t + d).toFixed(3) }); t += d + (/[.,!?]$/.test(w) ? 0.25 : 0.04); }
  return { start, end: t };
});
const duration = t + 2.2;
timings[timings.length - 1].end = duration;
const spec = composeSpec({ plan, timings, words, voiceDelay: 0, duration, seed: 5, cfg: channel() });
console.log(writeFilmPage(path.resolve(outDir), spec), `${duration.toFixed(1)}s`);
