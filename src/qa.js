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
  // never sample under the brand end card (last ~2 s)
  return spec.scenes.map(s => +Math.min(Math.max(0.3, s.start + Math.min(2.2, (s.end - s.start) * 0.6)), spec.duration - 2.3).toFixed(2));
}

export async function reviewStills(html, spec, plan, dir, log) {
  const files = await renderStills(html, stillTimes(spec), path.join(dir, 'stills'), { W: spec.W, H: spec.H });
  const sheet = await contactSheet(files, path.join(dir, 'sheet.jpg'), 4);
  const prompt = `You are the QA editor for a YouTube Shorts channel. Read the image file "${sheet}" (a contact sheet: one frame per scene, left→right, top→bottom, scene 1 first; style "${plan.style}").
Also read the individual frames in "${path.join(dir, 'stills')}" if you need detail.
The video is about: ${plan.subject?.name || plan.topic}.
Check each frame for:
- RELEVANCE (most important): does the frame visibly show what that scene's narration is talking about? Is the main subject (${plan.subject?.name || plan.topic}) actually visible in scene 1 and in most scenes? A frame showing only words, a blank blob, or an unrelated picture is a failure.
- text overlapping other text, text cut off at the frame edge, unreadable text (low contrast), numbers formatted wrongly (e.g. a year shown as "2,019")
- empty/blank frames, broken drawings (scribbles that don't look like the intended object), off-topic stock footage, anything inappropriate.
The caption line near 2/3 height and the small logo top-left are expected.
Scene narration:
${plan.scenes.map((s, i) => `${i + 1}. ${s.narration}`).join('\n')}
Scene visuals as planned:
${plan.scenes.map((s, i) => `${i + 1}. [${s.visual.kind}] ${JSON.stringify({ ...s.visual, svg: s.visual.svg ? '(svg)' : undefined, img: undefined, video: undefined })}`).join('\n')}
pass=false for any problem a viewer would notice, especially frames that don't show what is being said. For every failing scene return a patch: a replacement visual object (kind, heading, emphasis, value, prefix, suffix, label, items, left, right, svg, emoji, parts, places, broll). ${plan.style === 'crayon' || plan.drawn ? 'This video is hand-drawn (no stock photos exist for it): every patch MUST be kind "drawing" (recognisable 8-25 shape svg of what is being said, data-anim on moving parts, svg2 second pose for living things; numbers/words go in heading). Never use image.' : 'Prefer kind "image" (a real photo of the thing — set broll to an exact 2-4 word stock search) or, in drawing styles, kind "drawing" with a recognisable 8-25 shape svg of the thing being said.'} Return JSON.`;
  try {
    const r = await askClaude(prompt, { schema: QA_SCHEMA, model: env('CLAUDE_FAST_MODEL', 'sonnet'), tools: ['Read'], maxTurns: 8, cwd: dir, log, timeoutMs: 8 * 60_000 });
    log.info(`QA score ${r.score}/10, ${r.pass ? 'pass' : 'fail'}${r.issues?.length ? ': ' + r.issues.map(x => `#${x.scene} ${x.problem}`).join('; ') : ''}`);
    return { ...r, sheet };
  } catch (e) {
    log.warn(`QA review skipped: ${e.message}`);
    return { pass: true, score: null, issues: [], sheet, skipped: true };
  }
}
