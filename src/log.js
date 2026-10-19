import { db, now } from './db.js';

export function makeLogger(runId = null) {
  const write = (level, ...parts) => {
    const msg = parts.map(p => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    const line = `[${new Date().toLocaleTimeString()}] ${level.toUpperCase()} ${runId ? `(${runId.slice(-6)}) ` : ''}${msg}`;
    (level === 'error' ? console.error : console.log)(line);
    try { db.prepare('INSERT INTO logs (run_id, at, level, msg) VALUES (?, ?, ?, ?)').run(runId, now(), level, msg.slice(0, 4000)); } catch {}
  };
  return { info: (...a) => write('info', ...a), warn: (...a) => write('warn', ...a), error: (...a) => write('error', ...a) };
}
