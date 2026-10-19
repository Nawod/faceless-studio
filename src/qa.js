// Visual QA: render one still per scene, show the contact sheet to Claude, apply its fixes once.
import path from 'node:path';
import { askClaude } from './claude.js';
import { env } from './config.js';
import { renderStills, contactSheet } from './render.js';

const QA_SCHEMA = {
  type: 'object', required: ['pass', 'score', 'issues'],
  properties: {
    pass: { type: 'boolean' },
    score: { type: 'number', description: '1-10 overall visual quality for a viral Short' },
    issues: { type: 'array', items: { type: 'object', properties: { scene: { type: 'number' }, problem: { type: 'string' } } } },
    patches: { type: 'array', description: 'replacement visual objects for broken scenes', items: { type: 'object', properties: { scene: { type: 'number' }, visual: { type: 'object' } } } },
  },
};

export function stillTimes(spec) {
  return spec.scenes.map(s => +(s.start + Math.min(2.2, (s.end - s.start) * 0.6)).toFixed(2));
}

export async function reviewStills(html, spec, plan, dir, log) {
  const files = await renderStills(html, stillTimes(spec), path.join(dir, 'stills'), { W: spec.W, H: spec.H });
  const sheet = await contactSheet(files, path.join(dir, 'sheet.jpg'), 4);
  const prompt = `You are the QA editor for a YouTube Shorts channel. Read the image file "${sheet}" (a contact sheet: one frame per scene, left→right, top→bottom, scene 1 first; style "${plan.style}").
Also read the individual frames in "${path.join(dir, 'stills')}" if you need detail.
Check each frame for: text overlapping other text, text cut off at the frame edge, unreadable text (low contrast), empty/blank frames, broken drawings (scribbles that don't look like the intended object), off-topic stock footage, anything inappropriate. The caption line near 2/3 height is expected.
Scene visuals as planned:
${plan.scenes.map((s, i) => `${i + 1}. [${s.visual.kind}] ${JSON.stringify({ ...s.visual, svg: s.visual.svg ? '(svg)' : undefined, img: undefined, video: undefined })}`).join('\n')}
pass=false only for problems a viewer would notice. For any broken scene you may return patches: a replacement visual object (same schema: kind, heading, emphasis, value, prefix, suffix, label, items, left, right, svg, emoji, parts) — keep broll unchanged. Return JSON.`;
  try {
    const r = await askClaude(prompt, { schema: QA_SCHEMA, model: env('CLAUDE_FAST_MODEL', 'sonnet'), tools: ['Read'], maxTurns: 8, cwd: dir, log, timeoutMs: 8 * 60_000 });
    log.info(`QA score ${r.score}/10, ${r.pass ? 'pass' : 'fail'}${r.issues?.length ? ': ' + r.issues.map(x => `#${x.scene} ${x.problem}`).join('; ') : ''}`);
    return { ...r, sheet };
  } catch (e) {
    log.warn(`QA review skipped: ${e.message}`);
    return { pass: true, score: null, issues: [], sheet, skipped: true };
  }
}
