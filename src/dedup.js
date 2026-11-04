// "No repeat within N days" guard. Claude sees the recent list when choosing, and this
// local check rejects anything that still lands too close to a recent topic.
import { db, now } from './db.js';

const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its just ' +
  'like make made more most no not of on or our out over so some such than that the their them then there these they this ' +
  'those to too up us was we were what when where which who why will with would you your really actually ever never ' +
  'facts fact explained secret secrets truth story stories amazing incredible insane crazy weird strange ' +
  'one two three four five six seven eight nine ten hundred thousand million billion first second every new').split(' '));

const stem = w => w.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1');

export function keywords(text) {
  return [...new Set(text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w)).map(stem))];
}

function jaccard(a, b) {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Containment catches "Octopus brains" vs "Why octopuses have nine brains and blue blood".
function containment(a, b) {
  const A = new Set(a), B = new Set(b);
  const small = A.size <= B.size ? A : B, big = small === A ? B : A;
  if (small.size < 2) return 0;
  let inter = 0; for (const x of small) if (big.has(x)) inter++;
  return inter / small.size;
}

export function recentTopics(days = 90) {
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  return db.prepare('SELECT topic, angle, keywords, style, created_at FROM topics WHERE created_at >= ? ORDER BY created_at DESC').all(since);
}

export function similarity(kwA, kwB) {
  return Math.max(jaccard(kwA, kwB), 0.85 * containment(kwA, kwB));
}

/** @returns {{ok: boolean, match?: object, score: number}} */
export function checkFresh(topic, angle, extraKeywords = [], days = 90, threshold = 0.42) {
  const kw = [...new Set([...keywords(`${topic} ${angle || ''}`), ...extraKeywords.flatMap(k => keywords(k))])];
  let worst = { score: 0 };
  for (const r of recentTopics(days)) {
    const s = similarity(kw, r.keywords.split(' '));
    if (s > worst.score) worst = { score: s, match: r };
  }
  return { ok: worst.score < threshold, ...worst, keywords: kw };
}

export function recordTopic(runId, plan) {
  const kw = [...new Set([...keywords(`${plan.topic} ${plan.angle || ''}`), ...(plan.keywords || []).flatMap(k => keywords(k))])];
  db.prepare('INSERT INTO topics (run_id, created_at, topic, angle, keywords, style) VALUES (?, ?, ?, ?, ?, ?)')
    .run(runId, now(), plan.topic, plan.angle || '', kw.join(' '), plan.style);
}
