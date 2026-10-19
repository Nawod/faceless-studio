// Dev helper: render a contact sheet of a composition.  node src/tools/stills.js <index.html> <t1,t2,...> <out.jpg>
import path from 'node:path';
import { renderStills, contactSheet } from '../render.js';

const [html, times, out] = process.argv.slice(2);
const ts = times.split(',').map(Number);
const files = await renderStills(html, ts, path.join(path.dirname(out), 'stills'));
await contactSheet(files, out, Math.min(4, ts.length));
console.log(out);
