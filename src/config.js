import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = path.join(ROOT, 'data');
export const RUNS = path.join(DATA, 'runs');
fs.mkdirSync(RUNS, { recursive: true });

// Minimal .env loader (no dependency). Real env vars win over the file.
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]]) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
loadEnv(path.join(ROOT, '.env'));

const CHANNEL_FILE = path.join(ROOT, 'config', 'channel.json');
export function channel() { return JSON.parse(fs.readFileSync(CHANNEL_FILE, 'utf8')); }
export function saveChannel(obj) { fs.writeFileSync(CHANNEL_FILE, JSON.stringify(obj, null, 2)); }

export const env = (k, d = '') => (process.env[k] ?? '').trim() || d;

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).find(Boolean) || '';
  } catch { return ''; }
}

// The Claude desktop app bundles the Claude Code CLI under %APPDATA%/Claude/claude-code/<version>/<hash>/claude.exe
// On Windows, `where claude` also lists npm's extensionless sh shim, which spawn() can't run.
// Use a real .exe, or resolve a .cmd shim to the .exe it launches.
function resolveWinShim(p) {
  if (/\.exe$/i.test(p)) return fs.existsSync(p) ? p : '';
  if (!/\.cmd$/i.test(p)) return '';
  const m = fs.readFileSync(p, 'utf8').match(/"%dp0%\\?([^"]+\.exe)"/i);
  const exe = m ? path.join(path.dirname(p), m[1]) : '';
  return exe && fs.existsSync(exe) ? exe : '';
}

function findClaude() {
  if (env('CLAUDE_BIN')) return env('CLAUDE_BIN');
  if (process.platform === 'win32') {
    try {
      const hits = execFileSync('where', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/).filter(Boolean);
      for (const h of hits) { const exe = resolveWinShim(h); if (exe) return exe; }
    } catch {}
  } else {
    const onPath = which('claude');
    if (onPath) return onPath;
  }
  const base = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude', 'claude-code');
  if (!fs.existsSync(base)) return '';
  const versions = fs.readdirSync(base).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  for (const v of versions) {
    const vdir = path.join(base, v);
    for (const h of fs.readdirSync(vdir)) {
      const exe = path.join(vdir, h, process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return '';
}

function findChrome() {
  if (env('CHROME_PATH')) return env('CHROME_PATH');
  const c = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    path.join(os.homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return c.find(p => fs.existsSync(p)) || '';
}

export const bins = {
  claude: findClaude(),
  chrome: findChrome(),
  ffmpeg: env('FFMPEG_PATH') || which('ffmpeg') || 'ffmpeg',
  ffprobe: env('FFMPEG_PATH') ? path.join(path.dirname(env('FFMPEG_PATH')), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe') : (which('ffprobe') || 'ffprobe'),
  python: env('PYTHON_PATH') || findPython(),
};

// On Windows `python3` is often the Microsoft Store stub (…\WindowsApps\python3.exe); skip those.
function findPython() {
  for (const cmd of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    try {
      const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const hit = out.split(/\r?\n/).find(p => p && !/WindowsApps/i.test(p));
      if (hit) return hit;
    } catch {}
  }
  return 'python';
}
