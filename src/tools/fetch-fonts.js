// Downloads the OFL fonts the engines use into engines/fonts/ so renders work offline.
// Run once: npm run fonts
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const FAMILIES = [
  'Inter:wght@400;600;800;900',
  'Anton',
  'Archivo+Black',
  'Patrick+Hand',
  'Gaegu:wght@400;700',
  'Space+Mono:wght@400;700',
  'DM+Serif+Display',
  'Courier+Prime:wght@700',
];
const OUT = path.join(ROOT, 'engines', 'fonts');
fs.mkdirSync(OUT, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

let css = '';
for (const fam of FAMILIES) {
  const r = await fetch(`https://fonts.googleapis.com/css2?family=${fam}&display=block`, { headers: { 'User-Agent': UA } });
  if (!r.ok) { console.error('failed', fam, r.status); continue; }
  const text = await r.text();
  // keep only the latin + latin-ext blocks
  const blocks = text.split('/*').filter(b => /^\s*latin(-ext)?\s*\*\//.test(b));
  for (const b of blocks) {
    const url = b.match(/url\((https:[^)]+\.woff2)\)/)?.[1];
    if (!url) continue;
    const file = path.basename(new URL(url).pathname);
    if (!fs.existsSync(path.join(OUT, file))) {
      const buf = Buffer.from(await (await fetch(url)).arrayBuffer());
      fs.writeFileSync(path.join(OUT, file), buf);
    }
    css += '/*' + b.replace(url, file);
  }
  console.log('ok', fam);
}
fs.writeFileSync(path.join(OUT, 'fonts.css'), css);
console.log(`wrote ${path.join(OUT, 'fonts.css')}`);
