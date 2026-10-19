// Deterministic frame renderer: headless Chrome seeks window.render(t) per frame and pipes JPEGs to ffmpeg.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';
import { bins } from './config.js';

const exec = promisify(execFile);

async function openPage(html, W, H) {
  if (!bins.chrome) throw new Error('Chrome not found. Set CHROME_PATH in .env.');
  const browser = await chromium.launch({
    executablePath: bins.chrome, headless: true,
    args: ['--allow-file-access-from-files', '--disable-web-security', '--autoplay-policy=no-user-gesture-required',
      '--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--force-color-profile=srgb', '--hide-scrollbars', '--mute-audio'],
  });
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(pathToFileURL(html).href, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForFunction(() => window.render && window.__ready, null, { timeout: 60_000 });
  await page.evaluate(() => window.__ready);
  return { browser, page, errors };
}

export async function renderStills(html, times, outDir, { W = 1080, H = 1920 } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const { browser, page, errors } = await openPage(html, W, H);
  const files = [];
  try {
    for (const [k, t] of times.entries()) {
      await page.evaluate(x => window.render(x), t);
      const f = path.join(outDir, `still_${String(k).padStart(2, '0')}.jpg`);
      await page.screenshot({ path: f, type: 'jpeg', quality: 88 });
      files.push(f);
    }
  } finally { await browser.close(); }
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  return files;
}

/** Contact sheet of stills (for the QA review and the dashboard). */
export async function contactSheet(files, out, cols = 4) {
  const rows = Math.ceil(files.length / cols);
  const list = path.join(path.dirname(out), 'sheet_inputs.txt');
  fs.writeFileSync(list, files.map(f => `file '${path.resolve(f).replace(/\\/g, '/')}'`).join('\n'));
  await exec(bins.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=360:640,tile=${cols}x${rows}:padding=8:color=white`, '-frames:v', '1', out], { windowsHide: true });
  return out;
}

export async function renderVideo(html, { duration, fps = 30, W = 1080, H = 1920, out, workers, log }) {
  const total = Math.round(duration * fps);
  const WK = workers || Math.max(1, Math.min(6, os.cpus().length - 2));
  const segDir = fs.mkdtempSync(path.join(path.dirname(out), '.segs-'));
  const per = Math.ceil(total / WK), t0 = Date.now();
  let done = 0;
  try {
    await Promise.all([...Array(WK)].map(async (_, w) => {
      const a = w * per, b = Math.min(total, a + per);
      if (a >= b) return;
      const { browser, page, errors } = await openPage(html, W, H);
      const ff = spawn(bins.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(fps), `seg_${String(w).padStart(2, '0')}.mp4`], { cwd: segDir, windowsHide: true });
      let ffErr = ''; ff.stderr.on('data', d => (ffErr += d));
      const closed = new Promise(r => ff.on('close', r));
      try {
        for (let f = a; f < b; f++) {
          await page.evaluate(t => window.render(t), f / fps);
          const buf = await page.screenshot({ type: 'jpeg', quality: 93 });
          if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
          if (++done % 150 === 0) log?.info(`rendered ${done}/${total} frames (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
          if (errors.length) throw new Error(`page error at ${(f / fps).toFixed(2)}s: ${errors[0]}`);
        }
      } finally { ff.stdin.end(); await browser.close(); }
      const code = await closed;
      if (code !== 0) throw new Error(`ffmpeg segment ${w} failed: ${ffErr}`);
    }));
    const segs = fs.readdirSync(segDir).filter(f => f.endsWith('.mp4')).sort();
    fs.writeFileSync(path.join(segDir, 'list.txt'), segs.map(s => `file '${s}'`).join('\n'));
    await exec(bins.ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', path.resolve(out)], { cwd: segDir, windowsHide: true });
    log?.info(`video rendered in ${((Date.now() - t0) / 1000).toFixed(0)}s (${total} frames, ${WK} workers)`);
    return out;
  } finally { fs.rmSync(segDir, { recursive: true, force: true }); }
}

export async function mux(video, audio, out) {
  await exec(bins.ffmpeg, ['-y', '-loglevel', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out], { windowsHide: true, timeout: 5 * 60_000 });
  return out;
}
