// Render frames of a film so the director (and reviewer) can SEE it.
//   node src/tools/frames.js <film/index.html> sheet <t1,t2,...>            → review/sheet.jpg  (one frame per time, 4 per row)
//   node src/tools/frames.js <film/index.html> sheet auto                    → one frame per scene (60% into it)
//   node src/tools/frames.js <film/index.html> strip <from> <to> [n=8]       → review/strip_<from>.jpg (n frames: judge motion)
//   node src/tools/frames.js <film/index.html> frame <t>                     → review/frame_<t>.jpg (full size, for detail)
// Script errors on the page are printed and the exit code is 1.
import fs from 'node:fs';
import path from 'node:path';
import { renderStills, contactSheet } from '../render.js';

const [html, mode, a, b, c] = process.argv.slice(2);
if (!html || !mode) { console.error('usage: frames.js <index.html> sheet|strip|frame …'); process.exit(2); }
const filmDir = path.dirname(path.resolve(html));
const review = path.join(path.dirname(filmDir), 'review');
fs.mkdirSync(review, { recursive: true });

function specOf() {
  const s = fs.readFileSync(path.join(filmDir, 'spec.js'), 'utf8');
  return JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;$/, ''));
}

try {
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
    const [f] = await renderStills(html, [+a], path.join(review, 'frame_tmp'));
    const out = path.join(review, `frame_${a}.jpg`); fs.copyFileSync(f, out); console.log(out);
  } else { console.error('mode must be sheet, strip or frame'); process.exit(2); }
  process.exit(0);
} catch (e) {
  console.error('RENDER ERROR:', e.message);
  process.exit(1);
}
