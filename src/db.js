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
-- topic pool: ideas researched in batches (or added by hand), used one per video
CREATE TABLE IF NOT EXISTS bank (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  topic        TEXT NOT NULL,
  angle        TEXT,
  hook         TEXT,
  category     TEXT,
  style        TEXT,                   -- suggested look ('' = automatic)
  keywords     TEXT,
  status       TEXT NOT NULL DEFAULT 'new',   -- new | queued | used | rejected
  source       TEXT NOT NULL DEFAULT 'auto',  -- auto | manual
  notes        TEXT,
  run_id       TEXT,
  used_at      TEXT
);
-- production queue: what to make next, in order (manual picks first, then the pool fills in)
CREATE TABLE IF NOT EXISTS queue (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  position     REAL NOT NULL,
  bank_id      INTEGER,
  topic        TEXT NOT NULL,
  angle        TEXT,
  notes        TEXT,
  style        TEXT,                   -- '' = automatic; 'film:<language>' or 'tpl:<engine>'
  status       TEXT NOT NULL DEFAULT 'waiting', -- waiting | running | done | failed
  run_id       TEXT,
  error        TEXT
);
`);
try { db.exec('ALTER TABLE runs ADD COLUMN queue_id INTEGER'); } catch {}
// task list: every action you click (make, resume, start over, upload, schedule on Facebook…) runs one at a time,
// in click order
db.exec(`CREATE TABLE IF NOT EXISTS jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at   TEXT NOT NULL,
  kind         TEXT NOT NULL,          -- make | queue | resume | restart | upload | facebook
  run_id       TEXT,                   -- the run it acts on (or the run it created)
  params       TEXT,                   -- JSON
  label        TEXT,
  status       TEXT NOT NULL DEFAULT 'waiting',  -- waiting | running | done | failed | removed
  error        TEXT,
  started_at   TEXT,
  ended_at     TEXT
)`);

try { db.exec('ALTER TABLE runs ADD COLUMN facebook_id TEXT'); } catch {}
try { db.exec('ALTER TABLE runs ADD COLUMN fb_publish_at TEXT'); } catch {}   // the Reel's own slot (YouTube's is publish_at)   // Facebook Page Reel id

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
