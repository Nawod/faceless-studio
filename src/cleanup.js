// Disk cleanup. A finished video only needs final.mp4 (plus a few small files the dashboard and the
// publish buttons read); everything else in its run folder — stock clips, WAVs, voice, review images, 3D scene and
// frames, temp folders — is a leftover. Runs that never produced a video and were abandoned days ago are removed.
//   node src/cleanup.js            clean every run now (prints what it freed)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNS, DATA } from './config.js';
import { db } from './db.js';

// kept in a finished run: the video and the small files the dashboard, the publish buttons and the TikTok caption use
const KEEP = new Set(['final.mp4', 'state.json', 'plan.json', 'words.json', 'sheet.jpg']);
const ABANDON_DAYS = 3;

function size(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((a, f) => a + size(path.join(p, f)), 0);
  } catch { return 0; }
}
const rm = p => { const n = size(p); fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); return n; };
const mb = n => `${(n / 1e6).toFixed(0)} MB`;

/** Remove the leftovers of a finished video (final.mp4 must exist). Returns bytes freed. */
export function cleanRun(runId) {
  const dir = path.join(RUNS, runId);
  if (!fs.existsSync(path.join(dir, 'final.mp4'))) return 0;
  let freed = 0;
  for (const f of fs.readdirSync(dir)) if (!KEEP.has(f)) freed += rm(path.join(dir, f));
  return freed;
}

/** Runs that never made a video and were last touched more than `days` ago: folder, run row and logs removed. */
export function pruneAbandoned(days = ABANDON_DAYS, busyRunId = null) {
  const cutoff = Date.now() - days * 86400_000;
  let freed = 0; const removed = [];
  for (const r of db.prepare("SELECT id, status, created_at FROM runs WHERE status IN ('failed','cancelled','interrupted')").all()) {
    const dir = path.join(RUNS, r.id);
    if (r.id === busyRunId || fs.existsSync(path.join(dir, 'final.mp4'))) continue;
    const touched = fs.existsSync(dir) ? fs.statSync(dir).mtimeMs : new Date(r.created_at).getTime();
    if (touched > cutoff) continue;   // recent: it may still be resumed
    freed += rm(dir);
    db.prepare('DELETE FROM logs WHERE run_id = ?').run(r.id);
    db.prepare('DELETE FROM runs WHERE id = ?').run(r.id);
    db.prepare("UPDATE queue SET status = 'waiting', run_id = NULL WHERE run_id = ? AND status = 'running'").run(r.id);
    removed.push(r.id);
  }
  return { freed, removed };
}

/** Everything at once: leftovers of all finished videos + abandoned runs. Safe to call any time no run is active. */
export function cleanAll({ busyRunId = null, log = console } = {}) {
  let freed = 0, cleaned = 0;
  for (const id of fs.existsSync(RUNS) ? fs.readdirSync(RUNS) : []) {
    if (id === busyRunId) continue;
    const n = cleanRun(id);
    if (n) { freed += n; cleaned++; }
  }
  const ab = pruneAbandoned(ABANDON_DAYS, busyRunId);
  freed += ab.freed;
  if (freed) log.info?.(`cleanup: freed ${mb(freed)} (${cleaned} finished video${cleaned === 1 ? '' : 's'} tidied, ${ab.removed.length} abandoned run${ab.removed.length === 1 ? '' : 's'} removed)`);
  return { freed, cleaned, removed: ab.removed };
}

// ---------------------------------------------------------------- CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = size(DATA);
  const r = cleanAll({ log: { info: m => console.log(m) } });
  for (const extra of ['test', 'b3dtest', 'preview']) { const p = path.join(DATA, extra); if (fs.existsSync(p)) r.freed += rm(p); }
  console.log(`data folder: ${mb(before)} → ${mb(size(DATA))} (freed ${mb(r.freed)}); removed runs: ${r.removed.join(', ') || 'none'}`);
}
