// Render frames of a film so the director (and reviewer) can SEE it.
//   node src/tools/frames.js <film/index.html> sheet <t1,t2,...>            → review/sheet.jpg  (one frame per time, 4 per row)
//   node src/tools/frames.js <film/index.html> sheet auto                    → one frame per scene (60% into it)
//   node src/tools/frames.js <film/index.html> strip <from> <to> [n=8]       → review/strip_<from>.jpg (n frames: judge motion)
//   node src/tools/frames.js <film/index.html> frame <t> [t2 …]             → review/frame_<t>.jpg (full size, for detail)
// Several jobs in ONE command (cheaper for the director than one call each):
//   node src/tools/frames.js film/index.html strip 3 5 8 strip 20 22 frame 12.5 30 sheet auto
// Script errors on the page are printed and the exit code is 1.
import fs from 'node:fs';
import path from 'node:path';
import { renderStills, contactSheet } from '../render.js';

const [html, ...rest] = process.argv.slice(2);
if (!html || !rest.length) { console.error('usage: frames.js <index.html> sheet|strip|frame … [more jobs]'); process.exit(2); }
// split the arguments into jobs: each starts with a mode keyword
const jobs = [];
for (const t of rest) { if (['sheet', 'strip', 'frame'].includes(t)) jobs.push([t]); else if (jobs.length) jobs[jobs.length - 1].push(t); }
const filmDir = path.dirname(path.resolve(html));
const review = path.join(path.dirname(filmDir), 'review');
fs.mkdirSync(review, { recursive: true });

function specOf() {
  const s = fs.readFileSync(path.join(filmDir, 'spec.js'), 'utf8');
  return JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;$/, ''));
}

async function job([mode, a, b, c]) {
  if (mode === 'sheet') {
    const spec = specOf();
    const times = a === 'auto' || !a
      ? spec.scenes.map(s => +Math.min(spec.duration - 0.2, Math.max(0.2, s.start + (s.end - Math.max(0, s.start)) * 0.6)).toFixed(2))
      : a.split(',').map(Number);
    const files = await renderStills(html, times, path.join(review, 'sheet_frames'));
    const out = await contactSheet(files, path.join(review, 'sheet.jpg'), 4);
    console.log(`${out}  (${times.length} frames at ${times.join(', ')})`);
  } else if (mode === 'strip') {
    const t0 = +a, t1 = +b, n = Math.max(2, Math.min(12, +(c || 8)));
    const times = Array.from({ length: n }, (_, k) => +(t0 + (t1 - t0) * k / (n - 1)).toFixed(3));
    const files = await renderStills(html, times, path.join(review, `strip_frames_${t0}`));
    const out = await contactSheet(files, path.join(review, `strip_${t0}.jpg`), Math.min(6, n));
    console.log(`${out}  (${n} frames ${t0}s → ${t1}s)`);
  } else if (mode === 'frame') {
    const ts = [a, b, c].filter(x => x != null);
    const files = await renderStills(html, ts.map(Number), path.join(review, 'frame_tmp'));
    files.forEach((f, k) => { const out = path.join(review, `frame_${ts[k]}.jpg`); fs.copyFileSync(f, out); console.log(out); });
  }
}

try {
  for (const j of jobs) {
    // "frame" may list any number of times
    if (j[0] === 'frame' && j.length > 4) { for (let k = 1; k < j.length; k += 3) await job(['frame', ...j.slice(k, k + 3)]); }
    else await job(j);
  }
  process.exit(0);
} catch (e) {
  console.error('RENDER ERROR:', e.message);
  process.exit(1);
}
