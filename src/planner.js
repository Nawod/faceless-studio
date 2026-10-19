// Topic choice + research + script + art direction, in one Claude call (with web search),
// followed by the local freshness check. Re-asks with the clash banned if it repeats.
import { askClaude } from './claude.js';
import { channel } from './config.js';
import { checkFresh, recentTopics } from './dedup.js';

const VISUAL_KINDS = {
  headline: 'big on-screen words. fields: heading (2-6 words), emphasis (one word from heading to highlight)',
  stat: 'a number that counts up. fields: value (number), prefix, suffix, label (2-5 words)',
  list: 'up to 4 short items appearing one by one. fields: heading, items[]',
  compare: 'two sides vs each other. fields: left, right (1-3 words each), heading',
  image: 'a real photo/footage of a concrete thing. fields: broll (2-4 word stock search, concrete nouns e.g. "octopus underwater"), heading (optional)',
  drawing: 'a simple illustration. fields: svg (inner SVG markup for viewBox 0 0 400 400 — 4-14 elements using path/circle/ellipse/rect/line/polygon/polyline, each with stroke and fill colours; bold simple shapes, a child could recognise it; no text, no gradients, no <svg> wrapper), heading (optional)',
  icons: 'a row/orbit of 3-6 emoji representing things. fields: emoji[], heading',
  timeline: 'dated points on a line. fields: items[] formatted "YEAR — event" (max 4)',
  quote: 'a short quote card. fields: heading (the quote, <= 12 words), label (who said it)',
  model3d: 'a rotating 3D wireframe model built from primitives, exploding into parts. fields: heading, parts[] each {shape: box|cylinder|sphere|cone|torus|gear, pos:[x,y,z], size:[x,y,z], color:"#hex", label} in a -1..1 space, 3-9 parts',
  map: 'real places on Earth. fields: heading, places[] each {name, lat, lon} (1-4 places, accurate coordinates; keep places of one scene within roughly the same half of the globe), broll (for footage styles)',
};

const STYLE_RULES = {
  kinetic: 'Clean Apple-keynote motion graphics: off-white canvas, huge bold type, stats, lists, emoji orbits, 3D carousels. Uses: headline, stat, list, compare, icons, timeline, quote, image, model3d.',
  collage: 'Editorial halftone paper-collage (Ali Abdaal style): flat saturated colour, black-and-white halftone photo cut-outs, ransom-note letters, tape. Uses: headline, image (needs broll), quote, stat, list, compare, icons.',
  crayon: "Children's crayon picture-book drawn live on paper, handwritten words. Uses: drawing (most scenes!), headline, stat, list, icons. Never image.",
  documentary: 'Full-screen real stock footage with slow camera push and huge word-by-word captions (like viral animal/nature/mystery shorts). EVERY scene needs broll. Overlays allowed: stat, headline, timeline.',
  blueprint3d: 'Engineering blueprint: cyan linework on deep blue grid, rotating 3D wireframe models that explode into labelled parts, technical callouts. Uses: model3d (most scenes), stat, list, headline, timeline.',
  mascot: "The channel's cartoon Earth mascot hosts on sunburst backgrounds with sticker-style cards; it lip-syncs, reacts (surprised on stats, skeptical on quotes/compare). Uses: headline, stat, list, compare, icons, quote, drawing, image, model3d.",
  globe3d: 'A real 3D Earth in space; the camera flies to places with pins, labels and arcs between them; glass cards for other facts. Uses: map (at least half the scenes!), stat, list, compare, icons, quote, headline.',
  newsflash: 'News-explainer look over real stock footage: red EXPLAINED tags, lower-thirds, BY THE NUMBERS / WHAT WE KNOW panels, press-quote cards, location chips, key words punching huge. EVERY scene needs broll. Uses: headline, stat, list, quote, map, compare, timeline.',
};

const PLAN_SCHEMA = {
  type: 'object',
  required: ['topic', 'angle', 'keywords', 'style', 'mood', 'subject', 'title', 'description', 'tags', 'scenes', 'sources'],
  properties: {
    topic: { type: 'string' },
    angle: { type: 'string', description: 'the specific surprising hook/angle on the topic' },
    keywords: { type: 'array', items: { type: 'string' } },
    style: { type: 'string', enum: Object.keys(STYLE_RULES) },
    styleReason: { type: 'string' },
    mood: { type: 'string', enum: ['curious', 'epic', 'playful', 'mysterious', 'calm', 'upbeat'] },
    accent: { type: 'string', description: 'optional accent colour hex that fits the topic' },
    subject: {
      type: 'object', required: ['name', 'broll', 'svg'],
      properties: { name: { type: 'string' }, broll: { type: 'string' }, svg: { type: 'string', description: 'recognisable drawing of the subject, inner SVG for viewBox 0 0 400 400' } },
    },
    title: { type: 'string' },
    description: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    scenes: {
      type: 'array', minItems: 6, maxItems: 12,
      items: {
        type: 'object', required: ['narration', 'visual'],
        properties: {
          narration: { type: 'string' },
          visual: {
            type: 'object', required: ['kind'],
            properties: {
              kind: { type: 'string', enum: Object.keys(VISUAL_KINDS) },
              heading: { type: 'string' }, emphasis: { type: 'string' },
              value: { type: 'number' }, prefix: { type: 'string' }, suffix: { type: 'string' }, label: { type: 'string' },
              items: { type: 'array', items: { type: 'string' } },
              left: { type: 'string' }, right: { type: 'string' },
              broll: { type: 'string' }, svg: { type: 'string' },
              emoji: { type: 'array', items: { type: 'string' } },
              parts: { type: 'array', items: { type: 'object' } },
              places: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' } } } },
            },
          },
        },
      },
    },
    sources: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
    factCheck: { type: 'string', description: 'one line: how the key claims were verified' },
  },
};

function allowedStyles(cfg, recent) {
  const enabled = Object.entries(cfg.styles).filter(([, s]) => s.enabled).map(([k]) => k);
  const n = cfg.variety.maxSameStyleInARow;
  const last = recent.slice(0, n).map(r => r.style);
  if (last.length === n && last.every(s => s === last[0])) return enabled.filter(s => s !== last[0]);
  return enabled;
}

export function buildPrompt(cfg, candidates, recent, styles, banned = []) {
  const words = Math.round(cfg.video.targetSeconds * 2.65);
  return `You are the head writer and art director of a faceless YouTube Shorts channel "${cfg.channelName}".
Audience: ${cfg.audience}. Niche: ${cfg.niche.primary}.
Never cover: ${cfg.niche.avoid.join('; ')}.

TASK: choose today's topic, research it with web search, and write a complete production plan.

1. TOPIC. Today's trend signals are below (USA + UK). About ${Math.round(cfg.niche.trendWeight * 100)}% of the time pick a topic that rides a trend AND fits the niche; otherwise pick an evergreen curiosity topic with proven Shorts appeal. It must be advertiser-friendly, factual, and NOT similar to anything in the "already covered" list (different subject — not just a new angle on the same subject).${banned.length ? `\n   Also REJECTED (too similar to past videos): ${banned.join('; ')}` : ''}
2. RESEARCH. Verify every factual claim with web search; use at least 2 reputable sources. No invented numbers. If unsure, leave it out.
3. SCRIPT. ${words - 15}-${words + 15} words total across scenes (≈${cfg.video.targetSeconds}s spoken; must be over 60 s). Rules that make Shorts retain:
   - Scene 1 narration is the hook: a surprising claim or question in ≤ 12 words, no greeting, no "did you know".${cfg.brand ? `
   - Channel concept: every video presents its topic as a "bug" in Earth's code, then explains the real science. Use the bug/glitch framing lightly (hook or payoff, not every line), e.g. "Earth has a bug: …" or "This isn't a glitch — it's …". Never pretend a real phenomenon is fake.` : ''}
   - One idea, built like a mini-story: hook → stakes → 3-5 escalating reveals with specific numbers/comparisons → a payoff that answers the hook.
   - Short spoken sentences, second person, concrete images. No filler ("in this video", "let's dive in", "make sure to").
   - Last scene ends with a line that loops naturally back to the first line, then a 4-6 word soft CTA ("Follow for more like this.").
   - 6-12 scenes, each 1-3 sentences (~4-9 s each). A new visual at least every scene.
4. STYLE. Pick the best visual style for this topic from: ${styles.join(', ')}.
${styles.map(s => `   - ${s}: ${STYLE_RULES[s]} Best for: ${cfg.styles[s].bestFor}.`).join('\n')}
5. VISUALS. For each scene choose a visual kind allowed by the style:
${Object.entries(VISUAL_KINDS).map(([k, v]) => `   - ${k}: ${v}`).join('\n')}
   On-screen headings must be short and add something (a number, a keyword) rather than repeat the narration. Vary kinds; don't repeat the same kind 3 times in a row.
   SHOW, DON'T JUST TELL — the #1 reason viewers swipe away is visuals that don't match the words:
   - Fill "subject": the main real-world thing the video is about (e.g. the animal, object, place). subject.broll = a 2-4 word stock search that returns photos of exactly it ("common wombat", not "Australia"). subject.svg = a recognisable drawing of it (rules below).
   - The subject must be SEEN in scene 1 and in at least half of all scenes (as image, drawing or footage).
   - Every scene needs "broll": a concrete stock search for what that scene's narration describes (2-4 words, real nouns). Every scene's visual must depict what is being said at that moment.
   - Drawing styles (crayon, mascot): at least 60% of crayon scenes must be kind "drawing", each a different, recognisable picture of what that scene says. svg: 8-25 elements, bold simple shapes that fill most of the 400x400 canvas, outlines in a dark colour, real-world colours; a 6-year-old must recognise it without the heading.
   - stat: prefix/suffix ≤ 6 characters each (use label for the rest). Never use stat for a year — use timeline or headline.
6. METADATA. title: ≤ 70 chars, curiosity-driven but truthful, no ALL CAPS, no emoji spam. description: 2-3 sentences + 3-5 hashtags incl. #shorts + "Sources:" with the URLs. tags: 8-15.
   mood picks the background music feel.

Already covered in the last ${cfg.variety.dedupDays} days (do NOT repeat these subjects):
${recent.length ? recent.map(r => `- ${r.topic} — ${r.angle}`).join('\n') : '- (nothing yet)'}

Trend signals today:
${candidates.slice(0, 120).map(c => `- [${c.source}] ${c.title}${c.signal ? ` (${c.signal})` : ''}${c.context ? ` — ${c.context}` : ''}`).join('\n')}

Return only the JSON plan.`;
}

export async function makePlan({ candidates, log, cwd }) {
  const cfg = channel();
  const recent = recentTopics(cfg.variety.dedupDays);
  const styles = allowedStyles(cfg, recent);
  const banned = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    log.info(`planning (attempt ${attempt + 1}); styles allowed: ${styles.join(', ')}`);
    const plan = await askClaude(buildPrompt(cfg, candidates, recent, styles, banned), {
      schema: PLAN_SCHEMA, tools: ['WebSearch', 'WebFetch'], maxTurns: 30, cwd, log, timeoutMs: 20 * 60_000,
    });
    const fresh = checkFresh(plan.topic, plan.angle, plan.keywords, cfg.variety.dedupDays, cfg.variety.similarityThreshold);
    if (!styles.includes(plan.style)) plan.style = styles[0];
    if (fresh.ok) {
      log.info(`topic: "${plan.topic}" (${plan.style}); closest past match ${fresh.score.toFixed(2)}`);
      return await enforceVisuals(normalise(plan), log, cwd);
    }
    log.warn(`"${plan.topic}" too close to past "${fresh.match.topic}" (${fresh.score.toFixed(2)}); re-planning`);
    banned.push(plan.topic);
  }
  throw new Error('Could not find a fresh topic after 3 attempts');
}

export async function extendScript(plan, missingSeconds, log, cwd) {
  const words = Math.ceil(missingSeconds * 2.7) + 10;
  log.info(`script is short by ${missingSeconds.toFixed(1)} s; asking for ~${words} more words`);
  const out = await askClaude(`This Shorts plan runs too short. Add about ${words} words of genuinely interesting, accurate content: either insert 1-2 new scenes before the final scene or lengthen existing middle scenes. Keep the hook, the ending and the style rules. Return the full updated plan JSON.\n\n${JSON.stringify(plan)}`, {
    schema: PLAN_SCHEMA, tools: ['WebSearch'], maxTurns: 10, cwd, log,
  });
  return normalise({ ...plan, ...out, style: plan.style });
}

const svgCount = svg => (String(svg || '').match(/<(path|circle|ellipse|rect|line|polygon|polyline)\b/gi) || []).length;
const isYear = v => v.kind === 'stat' && Number.isInteger(+v.value) && +v.value >= 1000 && +v.value <= 2100 && !v.suffix && !v.prefix;

/** Code-level checks that the visuals will actually show the story. Returns human-readable problems. */
export function visualProblems(plan) {
  const p = [], n = plan.scenes.length, kinds = plan.scenes.map(s => s.visual?.kind);
  if (!plan.subject?.broll) p.push('subject.broll is missing');
  if (svgCount(plan.subject?.svg) < 6) p.push('subject.svg is too simple (needs 8-25 shapes) or missing');
  plan.scenes.forEach((s, i) => {
    const v = s.visual || {};
    if (!v.broll) p.push(`scene ${i + 1}: add a broll search for what it shows`);
    if (v.kind === 'drawing' && svgCount(v.svg) < 6) p.push(`scene ${i + 1}: drawing has only ${svgCount(v.svg)} shapes — draw a recognisable picture (8-25 shapes)`);
    if (v.kind === 'stat' && ((v.prefix || '').length > 6 || (v.suffix || '').length > 6)) p.push(`scene ${i + 1}: stat prefix/suffix too long — move words to label`);
  });
  if (plan.style === 'crayon') {
    const d = kinds.filter(k => k === 'drawing').length;
    if (d < Math.ceil(n * 0.6)) p.push(`crayon style needs drawings in at least ${Math.ceil(n * 0.6)} of ${n} scenes (has ${d}) — each picturing what that scene says`);
    if (kinds[0] !== 'drawing' && kinds[0] !== 'image') p.push('scene 1 must show the subject (drawing or image)');
  }
  if (plan.style === 'globe3d' && kinds.filter(k => k === 'map').length < Math.ceil(n * 0.4)) p.push('globe3d needs map scenes in at least 40% of scenes');
  if (plan.style === 'blueprint3d' && kinds.filter(k => k === 'model3d').length < Math.ceil(n * 0.4)) p.push('blueprint3d needs model3d in at least 40% of scenes');
  return p;
}

export const enforceVisualsForRun = (plan, log, cwd) => enforceVisuals(plan, log, cwd);
export { svgCount };

/** Turn a description (or a too-simple svg) into a real drawing. Returns inner SVG markup. */
export async function drawSvg(what, { log, cwd, palette } = {}) {
  const out = await askClaude(`Draw this as a simple, bold, child-recognisable illustration: "${what}".
Return inner SVG markup for viewBox="0 0 400 400" (no <svg> wrapper, no <text>, no gradients, no <g> transforms): 10-25 elements using only path, circle, ellipse, rect, line, polygon, polyline. Every element has fill (real-world colours${palette ? `, e.g. ${palette}` : ''}) and a dark stroke (#3B2A4A) with stroke-width 5-8. Shapes fill most of the canvas; the main object is centred and large.`, {
    schema: { type: 'object', required: ['svg'], properties: { svg: { type: 'string' } } }, model: 'sonnet', maxTurns: 2, cwd, log, timeoutMs: 4 * 60_000,
  });
  const svg = String(out.svg || '').replace(/<\/?svg[^>]*>/g, '').replace(/<text[\s\S]*?<\/text>/g, '');
  return svgCount(svg) >= 4 ? svg : null;
}

/** Any drawing visual whose svg isn't real markup gets drawn properly (or falls back to the subject drawing). */
export async function repairDrawings(plan, log, cwd) {
  for (const [i, s] of plan.scenes.entries()) {
    const v = s.visual || {};
    if (v.kind !== 'drawing' || svgCount(v.svg) >= 6) continue;
    const what = (v.svg && svgCount(v.svg) === 0 ? v.svg : '') || v.heading || s.narration;
    try {
      const svg = await drawSvg(`${what} (for a video about ${plan.subject?.name || plan.topic})`, { log, cwd });
      if (svg) { v.svg = svg; log.info(`scene ${i + 1}: drew a new picture`); continue; }
    } catch (e) { log.warn(`scene ${i + 1}: drawing failed: ${e.message}`); }
    if (plan.subject?.svg) v.svg = plan.subject.svg;
  }
  return plan;
}

async function enforceVisuals(plan, log, cwd) {
  for (let round = 0; round < 2; round++) {
    const problems = visualProblems(plan);
    if (!problems.length) return plan;
    log.warn(`visual plan needs fixes: ${problems.join('; ')}`);
    const out = await askClaude(`Fix the visuals of this YouTube Shorts plan. Keep topic, narration, facts, style and metadata exactly the same; change only "subject" and each scene's "visual" so every scene clearly shows what its narration says.\nProblems to fix:\n- ${problems.join('\n- ')}\n\nRules: subject = the main real thing (broll: exact stock search; svg: recognisable 8-25 shape drawing filling the 400x400 canvas). Every scene has a concrete broll. In crayon style most scenes are "drawing" with a different picture each. Return the full plan JSON.\n\n${JSON.stringify(plan)}`, {
      schema: PLAN_SCHEMA, maxTurns: 6, cwd, log, timeoutMs: 10 * 60_000,
    });
    plan = normalise({ ...plan, subject: out.subject || plan.subject, scenes: plan.scenes.map((s, i) => ({ ...s, visual: out.scenes?.[i]?.visual || s.visual })) });
  }
  await repairDrawings(plan, log, cwd);
  const left = visualProblems(plan);
  if (left.length) log.warn(`visual plan still has issues after revision: ${left.join('; ')}`);
  return plan;
}

function normalise(plan) {
  plan.scenes = plan.scenes.filter(s => s.narration?.trim()).map(s => ({ ...s, narration: s.narration.trim(), visual: s.visual || { kind: 'headline' } }));
  // years read as "2,019" in a counter: show them as a headline instead
  for (const s of plan.scenes) if (isYear(s.visual)) s.visual = { ...s.visual, kind: 'headline', heading: `${s.visual.value}${s.visual.label ? ' · ' + s.visual.label : ''}` };
  plan.tags = [...new Set((plan.tags || []).map(t => t.replace(/^#/, '').trim()).filter(Boolean))].slice(0, 15);
  if (plan.title.length > 95) plan.title = plan.title.slice(0, 92) + '…';
  return plan;
}
