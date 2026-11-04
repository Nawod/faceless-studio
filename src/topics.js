// Topic pool + production queue.
// The pool is filled in batches: one cheap Claude call (Sonnet + web search, with today's trend signals) finds ~20
// fresh ideas, so each video's planning starts from a ready topic instead of a cold search and the trend discovery
// runs once per batch, not once per video. Ideas too close to anything made in the last 90 days, or to another idea
// already in the pool, are dropped. The queue holds what to make next: your picks first, in order; when it is empty
// the next pool idea is used.
import { db, now } from './db.js';
import { channel, env } from './config.js';
import { askClaude } from './claude.js';
import { keywords, similarity, recentTopics } from './dedup.js';
import { discover } from './discover.js';

const IDEAS = {
  type: 'object', required: ['ideas'],
  properties: { ideas: { type: 'array', items: { type: 'object', required: ['topic', 'angle', 'hook', 'category'], properties: {
    topic: { type: 'string' }, angle: { type: 'string' }, hook: { type: 'string' }, category: { type: 'string' }, why: { type: 'string' },
  } } } },
};

const kwOf = (t, a = '') => keywords(`${t} ${a}`);

/** The closest existing topic (videos made within dedupDays + live pool ideas). */
export function closest(topic, angle = '', { ignoreBankId } = {}) {
  const cfg = channel(), kw = kwOf(topic, angle);
  let best = { score: 0 };
  for (const r of recentTopics(cfg.variety.dedupDays)) { const s = similarity(kw, r.keywords.split(' ')); if (s > best.score) best = { score: s, topic: r.topic, where: 'made' }; }
  for (const b of db.prepare("SELECT id, topic, keywords, status FROM bank WHERE status IN ('new','queued')").all()) {
    if (b.id === ignoreBankId) continue;
    const s = similarity(kw, (b.keywords || '').split(' ')); if (s > best.score) best = { score: s, topic: b.topic, where: 'pool', id: b.id, status: b.status };
  }
  return best;
}

export function addIdea({ topic, angle = '', hook = '', category = '', style = '', notes = '', source = 'manual' }, { force = false } = {}) {
  topic = String(topic || '').trim();
  if (!topic) throw new Error('topic is empty');
  const cfg = channel();
  const c = closest(topic, angle);
  if (!force && c.score >= cfg.variety.similarityThreshold) { const e = new Error(`too close to "${c.topic}" (${c.where === 'made' ? `made in the last ${cfg.variety.dedupDays} days` : 'already in the pool'})`); e.duplicate = c; throw e; }
  const r = db.prepare('INSERT INTO bank (created_at, topic, angle, hook, category, style, keywords, status, source, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(now(), topic, angle, hook, category, style || '', kwOf(topic, angle).join(' '), 'new', source, notes);
  return Number(r.lastInsertRowid);
}

/** One Claude call: n fresh, verified, high-interest ideas, stored in the pool. Returns how many were added. */
export async function generateIdeas(n, log, { cwd } = {}) {
  const cfg = channel();
  n = n || cfg.topics?.batchSize || 20;
  const recent = recentTopics(cfg.variety.dedupDays).map(r => r.topic);
  const inPool = db.prepare("SELECT topic FROM bank WHERE status IN ('new','queued') ORDER BY id DESC LIMIT 150").all().map(r => r.topic);
  let signals = [];
  try { signals = await discover(log); } catch {}
  const out = await askClaude(`You plan topics for the faceless YouTube Shorts channel "${cfg.channelName}" (US/UK audience).
Audience: ${cfg.audience}. Niche: ${cfg.niche.primary}
Never cover: ${cfg.niche.avoid.join('; ')}.

Find ${n} DIFFERENT video ideas. Use web search to confirm each core fact is real and well-sourced (reputable science/news/museum sources).
About ${Math.round((cfg.niche.trendWeight ?? 0.4) * 100)}% should ride something trending today (signals below) that fits the niche; the rest are evergreen
curiosities with proven Shorts appeal (bizarre animal abilities, "what happens if…", body facts, physics in everyday life, records, strange places).
Each idea is ONE specific, picturable subject with a surprising true angle — not a vague theme ("Glassfrogs hide their blood in their liver to turn invisible", not "camouflage").
Spread them over these categories: ${(cfg.niche.categories || []).join(', ')}.
For each: topic (short), angle (the specific surprising promise), hook (the first spoken line, ≤ 10 words, truthful, makes you need the answer), category, why (one line: the source fact).

Do NOT repeat or closely resemble any of these (already made or already planned):
${[...recent, ...inPool].map(t => `- ${t}`).join('\n') || '- (none)'}

Today's trend signals (US/UK):
${signals.slice(0, 80).map(s => `- ${s.title}${s.context ? ` — ${s.context}` : ''}`).join('\n') || '- (none)'}

Return JSON {"ideas":[…]}.`, { schema: IDEAS, model: env('CLAUDE_TOPIC_MODEL', 'sonnet'), tools: ['WebSearch'], maxTurns: 16, cwd, log, timeoutMs: 12 * 60_000, label: 'topic-finder' });
  let added = 0;
  for (const idea of out.ideas || []) {
    try { addIdea({ ...idea, source: 'auto', notes: idea.why || '' }); added++; }
    catch (e) { log?.info(`skipped idea "${idea.topic}": ${e.message}`); }
  }
  log?.info(`topic pool: +${added} new idea(s)`);
  return added;
}

export const bankCount = () => db.prepare("SELECT COUNT(*) n FROM bank WHERE status = 'new'").get().n;

/** Keep the pool stocked (called before each automatic video). Only waits for research when it is (nearly) empty. */
export async function ensureBank(log, opts) {
  const min = channel().topics?.bankMin ?? 8;
  if (bankCount() >= 2) { if (bankCount() < min) generateIdeas(undefined, log, opts).catch(e => log?.warn(`topic refill failed: ${e.message}`)); return; }
  await generateIdeas(undefined, log, opts);
}

/** The best unused idea: rotate categories, drop anything that has become too close to a recent video. */
export function pickIdea() {
  const cfg = channel();
  const ideas = db.prepare("SELECT * FROM bank WHERE status = 'new' ORDER BY source = 'manual' DESC, id").all();
  const lastCats = db.prepare("SELECT category FROM bank WHERE status = 'used' ORDER BY used_at DESC LIMIT 3").all().map(r => r.category);
  for (const pass of [0, 1]) {
    for (const b of ideas) {
      if (pass === 0 && lastCats.includes(b.category)) continue;
      const c = closest(b.topic, b.angle, { ignoreBankId: b.id });
      if (c.where === 'made' && c.score >= cfg.variety.similarityThreshold) { db.prepare("UPDATE bank SET status = 'rejected', notes = ? WHERE id = ?").run(`too close to recent video "${c.topic}"`, b.id); continue; }
      return b;
    }
  }
  return null;
}

export function markIdea(id, status, runId = null) {
  if (!id) return;
  db.prepare('UPDATE bank SET status = ?, run_id = COALESCE(?, run_id), used_at = CASE WHEN ? = \'used\' THEN ? ELSE used_at END WHERE id = ?').run(status, runId, status, now(), id);
}

// ---------- queue ----------
export function enqueue({ bankId, topic, angle = '', notes = '', style = '' }) {
  if (bankId) {
    const b = db.prepare('SELECT * FROM bank WHERE id = ?').get(bankId);
    if (!b) throw new Error('no such idea');
    if (b.status === 'queued') throw new Error('that idea is already in the queue');
    topic = b.topic; angle = angle || b.angle; notes = notes || b.hook || ''; style = style || b.style || '';
    markIdea(bankId, 'queued');
  } else {
    // a typed topic goes into the pool too (forced: you asked for it), so the 90-day memory knows it
    topic = String(topic || '').trim();
    if (!topic) throw new Error('topic is empty');
    const c = closest(topic, angle), close = c.score >= channel().variety.similarityThreshold;
    if (close && c.where === 'made') { const e = new Error(`"${topic}" is too close to "${c.topic}", made in the last ${channel().variety.dedupDays} days`); e.duplicate = c; throw e; }
    if (close && c.status === 'queued') { const e = new Error(`"${c.topic}" is already in the queue`); e.duplicate = c; throw e; }
    if (close && c.status === 'new') bankId = c.id;   // the same idea is already in the pool: use it
    else bankId = addIdea({ topic, angle, style, notes }, { force: true });
    markIdea(bankId, 'queued');
  }
  const pos = (db.prepare("SELECT MAX(position) p FROM queue WHERE status = 'waiting'").get().p || 0) + 1;
  return Number(db.prepare('INSERT INTO queue (created_at, position, bank_id, topic, angle, notes, style) VALUES (?, ?, ?, ?, ?, ?, ?)').run(now(), pos, bankId, topic, angle, notes, style || '').lastInsertRowid);
}

export const listQueue = () => db.prepare("SELECT * FROM queue WHERE status IN ('waiting','running','failed') ORDER BY status = 'running' DESC, status = 'failed', position").all();
export const nextQueued = () => db.prepare("SELECT * FROM queue WHERE status = 'waiting' ORDER BY position LIMIT 1").get() || null;

export function dequeue(id) {
  const q = db.prepare('SELECT * FROM queue WHERE id = ?').get(id);
  if (!q || q.status === 'running') throw new Error('cannot remove a running item');
  db.prepare('DELETE FROM queue WHERE id = ?').run(id);
  if (q.bank_id && q.status !== 'done') markIdea(q.bank_id, 'new');
}

export function moveQueued(id, dir) {
  const items = db.prepare("SELECT id, position FROM queue WHERE status = 'waiting' ORDER BY position").all();
  const i = items.findIndex(x => x.id === id), j = i + (dir === 'up' ? -1 : 1);
  if (i < 0 || j < 0 || j >= items.length) return;
  const up = db.prepare('UPDATE queue SET position = ? WHERE id = ?');
  up.run(items[j].position, items[i].id); up.run(items[i].position, items[j].id);
}

export function retryQueued(id) { db.prepare("UPDATE queue SET status = 'waiting', error = NULL WHERE id = ? AND status = 'failed'").run(id); }

export function setQueueStatus(id, status, fields = {}) {
  if (!id) return;
  db.prepare('UPDATE queue SET status = ?, run_id = COALESCE(?, run_id), error = ? WHERE id = ?').run(status, fields.runId || null, fields.error || null, id);
}
