import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bins, channel, env, ROOT } from './config.js';

const exec = promisify(execFile);
const PY = path.join(ROOT, 'py');

async function py(args, log, { timeout = 10 * 60_000 } = {}) {
  const { stdout } = await exec(bins.python, args, { timeout, maxBuffer: 1 << 24, windowsHide: true });
  return stdout.trim();
}

export async function probeDuration(file) {
  const { stdout } = await exec(bins.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { windowsHide: true });
  return parseFloat(stdout);
}

/** Pick a voice deterministically per run (variety across days, stable on retries). */
export function pickVoice(runId) {
  const cfg = channel();
  const engine = env('TTS_ENGINE', 'edge');
  const list = cfg.voice[engine] || cfg.voice.edge;
  let h = 0; for (const c of runId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { engine, voice: list[h % list.length], rate: cfg.voice.rate };
}

const pct = r => parseInt(String(r).replace(/[^\d-]/g, ''), 10) || 0;
const fmtRate = n => `${n >= 0 ? '+' : ''}${n}%`;

/**
 * Energetic, varied delivery: each scene is voiced on its own. The hook is fast and bright, the middle keeps
 * momentum, questions lift, and the payoff gets a beat of silence before it and a slightly heavier read.
 */
export function deliveryPlan(scenes, baseRate) {
  const base = pct(baseRate), n = scenes.length;
  return scenes.map((s, i) => {
    const text = s.narration.trim();
    let rate = base + 4, pitch = 0, gap = 0.07;
    if (i === 0) { rate = base + 8; pitch = 3; gap = 0.18; }                              // the hook: punchy, then a breath
    else if (i >= n - 2) { rate = base; pitch = -1; gap = i === n - 1 ? 0 : 0.12; }       // payoff + CTA: land it
    if (/\?\s*$/.test(text)) pitch += 2;                                                // questions lift
    if (/!\s*$/.test(text)) { rate += 3; pitch += 2; }
    if (/^(but|then|and then|here's|now)\b/i.test(text)) gap = Math.max(gap, 0.1);
    if (i === n - 3) gap = 0.32;                                                        // dramatic pause before the payoff
    return { text, rate: fmtRate(rate), pitch: `${pitch >= 0 ? '+' : ''}${pitch}Hz`, gap };
  });
}

export async function narrate(textOrScenes, dir, { engine, voice, rate }, log) {
  const txt = path.join(dir, 'narration.txt'), mp3 = path.join(dir, 'voice.mp3'), json = path.join(dir, 'words.json');
  let args;
  if (Array.isArray(textOrScenes)) {
    const segs = path.join(dir, 'segments.json');
    fs.writeFileSync(segs, JSON.stringify(deliveryPlan(textOrScenes, rate)));
    fs.writeFileSync(txt, textOrScenes.map(s => s.narration).join(' '));
    args = [path.join(PY, 'tts.py'), '--segments', segs, mp3, json, '--engine', engine, '--voice', voice];
  } else {
    fs.writeFileSync(txt, textOrScenes);
    args = [path.join(PY, 'tts.py'), txt, mp3, json, '--engine', engine, '--voice', voice, '--rate', rate];
  }
  try {
    log.info(await py(args, log));
  } catch (e) {
    if (engine === 'edge' && /403|Handshake/i.test(String(e.stderr || e.message))) {
      log.warn('edge-tts rejected (403) — upgrading edge-tts and retrying');
      await exec(bins.python, ['-m', 'pip', 'install', '-q', '-U', 'edge-tts'], { timeout: 180_000, windowsHide: true });
      log.info(await py(args, log));
    } else throw new Error(`TTS failed: ${e.stderr || e.message}`);
  }
  const words = JSON.parse(fs.readFileSync(json, 'utf8'));
  const duration = await probeDuration(mp3);
  return { mp3, words, duration };
}

const norm = w => w.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Map each scene to [start, end] using the TTS word timings (robust to punctuation/number differences). */
export function sceneTimings(scenes, words, totalDur) {
  // Per-scene voicing: every word knows its scene, so timings are exact.
  if (words.length && words.every(w => Number.isInteger(w.seg))) {
    return scenes.map((s, i) => {
      const ws = words.filter(w => w.seg === i), next = words.find(w => w.seg > i);
      const start = i === 0 ? 0 : Math.max(0, (ws[0]?.start ?? 0) - 0.08);
      const end = i === scenes.length - 1 ? totalDur : (next ? next.start - 0.08 : totalDur);
      return { start, end: Math.max(start + 0.4, end) };
    });
  }
  const tokens = scenes.map(s => s.narration.split(/\s+/).map(norm).filter(Boolean));
  const counts = tokens.map(t => t.length);
  const totalTokens = counts.reduce((a, b) => a + b, 0);
  // Edge splits/merges some tokens (numbers, hyphens), so scale cumulative counts to the word list length.
  const scale = words.length / totalTokens;
  let acc = 0;
  const bounds = counts.map(c => { acc += c; return Math.min(words.length, Math.round(acc * scale)); });
  let prevEnd = 0;
  return scenes.map((s, i) => {
    const firstIdx = i === 0 ? 0 : bounds[i - 1];
    const start = i === 0 ? 0 : (words[firstIdx]?.start ?? prevEnd) - 0.05;
    const lastIdx = Math.max(firstIdx, bounds[i] - 1);
    const end = i === scenes.length - 1 ? totalDur : (words[bounds[i]]?.start ?? words[lastIdx]?.end ?? totalDur) - 0.05;
    prevEnd = end;
    return { start: Math.max(0, start), end: Math.max(start + 0.5, end), wordFrom: firstIdx, wordTo: lastIdx };
  });
}

export async function makeMusicAndSfx(dir, seconds, mood, seed, events, log) {
  const music = path.join(dir, 'music.wav'), sfx = path.join(dir, 'sfx.wav'), ev = path.join(dir, 'sfx_events.json');
  fs.writeFileSync(ev, JSON.stringify(events));
  // A user-supplied library track (e.g. from the YouTube Audio Library) wins over the synth.
  const lib = path.join(ROOT, 'assets', 'music', mood);
  const tracks = fs.existsSync(lib) ? fs.readdirSync(lib).filter(f => /\.(mp3|wav|m4a)$/i.test(f)) : [];
  await py([path.join(PY, 'music.py'), music, sfx, '--seconds', seconds.toFixed(2), '--mood', mood, '--seed', String(seed), '--events', ev], log);
  if (tracks.length) {
    const pick = path.join(lib, tracks[seed % tracks.length]);
    log.info(`using library music: ${path.basename(pick)}`);
    return { music: pick, sfx, library: true };
  }
  return { music, sfx, library: false };
}

/** Voice up front, music ducked under it, SFX on top, loudness-normalised for YouTube (-14 LUFS). */
export async function mixAudio({ voice, music, sfx, voiceDelay = 0, seconds, out }) {
  const d = Math.round(voiceDelay * 1000);
  const filter = [
    `[0:a]adelay=${d}|${d},apad,atrim=0:${seconds},highpass=f=70,acompressor=threshold=-20dB:ratio=3:attack=5:release=80,volume=1.0[v]`,
    `[1:a]aloop=loop=-1:size=2e9,atrim=0:${seconds},volume=0.32[m]`,
    `[v]asplit=2[v1][vk]`,
    `[m][vk]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=350[md]`,
    `[2:a]atrim=0:${seconds},volume=0.55[s]`,
    `[v1][md][s]amix=inputs=3:normalize=0,afade=t=out:st=${(seconds - 0.8).toFixed(2)}:d=0.8,loudnorm=I=-14:TP=-1.5:LRA=11[a]`,
  ].join(';');
  await exec(bins.ffmpeg, ['-y', '-loglevel', 'error', '-i', voice, '-i', music, '-i', sfx, '-filter_complex', filter, '-map', '[a]', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', out],
    { timeout: 5 * 60_000, windowsHide: true });
  return out;
}
