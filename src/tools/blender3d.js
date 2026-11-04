// 3D layer of a bespoke film: build <workspace>/blender/scene.py in Blender (headless) and render its frames.
//   node blender3d.js <workspace> build                       build scene.py → blender/scene.blend (prints script errors)
//   node blender3d.js <workspace> stills auto|t1,t2… [--scale 50]   half-size stills at film times → blender/stills/ + review/b3d_sheet.jpg
//   node blender3d.js <workspace> strip <from> <to> [n=8]      motion strip → review/b3d_strip_<from>.jpg
//   node blender3d.js <workspace> render [--force]             every frame at full size → blender/frames/ (resumable)
// The 2D film layer (film/film.js) shows these frames under captions/labels via Film.backdrop(); frame f = film time (f-1)/fps.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const KIT = path.join(ROOT, 'engines', 'blender');
export const BLENDER = process.env.BLENDER_PATH || 'N:/Tools/blender-5.2.3-windows-x64/blender.exe';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

function specOf(ws) {
  const s = fs.readFileSync(path.join(ws, 'film', 'spec.js'), 'utf8');
  return JSON.parse(s.slice(s.indexOf('=') + 1).trim().replace(/;$/, ''));
}

/** Run Blender, stream FRAME lines to onFrame, reject with the Python error text on failure. */
function blender(args, { onFrame, cwd, shouldStop } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(BLENDER, ['-b', '--factory-startup', '--python-exit-code', '1', ...args], { cwd, windowsHide: true });
    let out = '', err = '';
    let stopped = false;
    p.stdout.on('data', d => {
      const s = String(d); out += s;
      for (const m of s.matchAll(/^FRAME (\d+) ([\d.]+)/gm)) {
        try { onFrame?.(+m[1], +m[2]); } catch {}
        if (!stopped && shouldStop?.()) { stopped = true; p.kill(); reject(Object.assign(new Error('cancelled by user'), { cancelled: true })); }
      }
    });
    p.stderr.on('data', d => (err += d));
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) return resolve(out);
      const tb = (out + err).split(/\r?\n/).filter(l => /Traceback|File "|Error|error:|BKIT_WARN/.test(l) || /^\s{2,}\S/.test(l)).slice(-25).join('\n');
      reject(new Error(`Blender failed (code ${code}):\n${tb || (out + err).slice(-1500)}`));
    });
  });
}

export function writeSpec(ws) {
  const spec = specOf(ws), bdir = path.join(ws, 'blender');
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'spec.json'), JSON.stringify({ fps: 30, ...spec }));
  return spec;
}

export async function build(ws) {
  writeSpec(ws);
  const bdir = path.join(ws, 'blender');
  if (!fs.existsSync(path.join(bdir, 'scene.py'))) throw new Error('blender/scene.py does not exist yet');
  const out = await blender(['-P', path.join(KIT, 'run_scene.py'), '--', bdir], { cwd: bdir });
  const warn = out.split(/\r?\n/).filter(l => /BKIT_WARN|Warning:/.test(l)).slice(0, 5);
  return [`scene built → ${path.join(bdir, 'scene.blend')}`, ...warn].join('\n');
}

const stale = ws => {
  const b = path.join(ws, 'blender');
  const blend = path.join(b, 'scene.blend');
  if (!fs.existsSync(blend)) return true;
  const t = fs.statSync(blend).mtimeMs;
  return fs.readdirSync(b).some(f => f.endsWith('.py') && fs.statSync(path.join(b, f)).mtimeMs > t);
};

export async function renderFrames(ws, frames, outDir, { scale = 100, force = false, onFrame, shouldStop } = {}) {
  if (stale(ws)) await build(ws);
  const args = [path.join(ws, 'blender', 'scene.blend'), '-P', path.join(KIT, 'render_frames.py'), '--', '--out', outDir, '--scale', String(scale)];
  if (frames) args.push('--frames', frames);
  if (force) args.push('--force');
  return blender(args, { onFrame, shouldStop });
}

function sheet(files, out, cols) {
  const list = out + '.txt';
  fs.writeFileSync(list, files.map(f => `file '${path.resolve(f).replace(/\\/g, '/')}'`).join('\n'));
  execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=360:640,tile=${cols}x${Math.ceil(files.length / cols)}:padding=8:color=white`, '-frames:v', '1', out], { windowsHide: true });
  fs.rmSync(list, { force: true });
  return out;
}

const frameOf = (t, fps = 30) => Math.round(t * fps) + 1;

// ---------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [wsArg, cmd, ...rest] = process.argv.slice(2);
  const ws = path.resolve(wsArg || '.');
  const opt = (k, d) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : d; };
  const review = path.join(ws, 'review'); fs.mkdirSync(review, { recursive: true });
  try {
    if (cmd === 'build') console.log(await build(ws));
    else if (cmd === 'stills') {
      const spec = writeSpec(ws);
      const times = !rest[0] || rest[0] === 'auto' || rest[0].startsWith('--')
        ? spec.scenes.map(s => +Math.min(spec.duration - 0.2, Math.max(0.2, s.start + (s.end - Math.max(0, s.start)) * 0.6)).toFixed(2))
        : rest[0].split(',').map(Number);
      const frames = times.map(t => frameOf(t));
      const dir = path.join(ws, 'blender', 'stills');
      const t0 = Date.now();
      await renderFrames(ws, frames.join(','), dir, { scale: +opt('--scale', 50), force: true });
      const out = sheet(frames.map(f => path.join(dir, `f_${String(f).padStart(4, '0')}.jpg`)), path.join(review, 'b3d_sheet.jpg'), 4);
      console.log(`${out}  (${frames.length} stills at ${times.join(', ')} s, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    } else if (cmd === 'strip') {
      const a = +rest[0], b = +rest[1], n = Math.max(2, Math.min(12, +(rest[2] || 8)));
      const frames = Array.from({ length: n }, (_, k) => frameOf(a + (b - a) * k / (n - 1)));
      const dir = path.join(ws, 'blender', 'stills');
      await renderFrames(ws, frames.join(','), dir, { scale: 50, force: true });
      console.log(sheet(frames.map(f => path.join(dir, `f_${String(f).padStart(4, '0')}.jpg`)), path.join(review, `b3d_strip_${a}.jpg`), Math.min(6, n)));
    } else if (cmd === 'render') {
      let n = 0; const t0 = Date.now();
      await renderFrames(ws, null, path.join(ws, 'blender', 'frames'), { force: rest.includes('--force'), onFrame: () => { if (++n % 100 === 0) console.log(`rendered ${n} frames (${((Date.now() - t0) / 1000).toFixed(0)} s)`); } });
      console.log(`all frames → ${path.join(ws, 'blender', 'frames')} (${n} rendered now)`);
    } else { console.error('usage: blender3d.js <workspace> build | stills [auto|t1,t2…] [--scale 50] | strip <from> <to> [n] | render [--force]'); process.exit(2); }
    process.exit(0);
  } catch (e) { console.error('BLENDER ERROR:', e.message); process.exit(1); }
}
