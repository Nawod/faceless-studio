import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA } from './config.js';

export const db = new DatabaseSync(path.join(DATA, 'studio.db'));
db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS runs (
  id           TEXT PRIMARY KEY,
  created_at   TEXT NOT NULL,
  status       TEXT NOT NULL,          -- queued | running | done | failed
  stage        TEXT,                   -- last completed stage
  topic        TEXT,
  style        TEXT,
  title        TEXT,
  duration     REAL,
  video_path   TEXT,
  youtube_id   TEXT,
  publish_at   TEXT,
  error        TEXT,
  meta         TEXT                    -- JSON blob (plan, sources, qa notes)
);
CREATE TABLE IF NOT EXISTS topics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT,
  created_at   TEXT NOT NULL,
  topic        TEXT NOT NULL,
  angle        TEXT,
  keywords     TEXT,                   -- space-separated normalized keywords
  style        TEXT
);
CREATE TABLE IF NOT EXISTS logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT,
  at           TEXT NOT NULL,
  level        TEXT NOT NULL,
  msg          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

export const now = () => new Date().toISOString();

export function kvGet(k, d = null) {
  const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k);
  return r ? JSON.parse(r.v) : d;
}
export function kvSet(k, v) {
  db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
}

export function updateRun(id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const vals = keys.map(k => (k === 'meta' && typeof fields[k] !== 'string') ? JSON.stringify(fields[k]) : fields[k]);
  db.prepare(`UPDATE runs SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ?`).run(...vals, id);
}

export function getRun(id) {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  if (r && r.meta) r.meta = JSON.parse(r.meta);
  return r;
}
