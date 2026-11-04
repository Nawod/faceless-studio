// DIRECTOR MODE — every video gets its own hand-crafted animation, made in an agentic loop (after ALIGN-video):
//   director session (plan → animatic → pilot → build → render frames → look → fix)
//   → fresh reviewer session that sees only frames (what did you understand? what feels AI-made? ranked fixes)
//   → next director round with the review … up to N rounds.
// The director writes only film/film.js (+ film.css) and wiki notes inside the run folder; it may only run the frame tool.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { askClaude } from './claude.js';
import { ROOT, env } from './config.js';
import { writeFilmPage } from './compose.js';
import { kvGet, kvSet } from './db.js';
import { byId, rotationChoices } from './languages.js';

const run = promisify(execFile);

// the 3D layer (blender/scene.py → Blender stills/frames); only used when the film has one
async function b3d(dir, ...args) {
  try {
    const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'tools', 'blender3d.js'), dir, ...args.map(String)], { cwd: dir, timeout: 15 * 60_000, windowsHide: true });
    return { ok: true, out: stdout.trim() };
  } catch (e) { return { ok: false, out: String(e.stderr || e.stdout || e.message).slice(0, 1200) }; }
}
const has3d = dir => fs.existsSync(path.join(dir, 'blender', 'scene.py'));

async function frames(dir, ...args) {
  const html = path.join(dir, 'film', 'index.html');
  try {
    const { stdout } = await run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'src', 'tools', 'frames.js'), html, ...args.map(String)], { cwd: dir, timeout: 6 * 60_000, windowsHide: true });
    return { ok: true, out: stdout.trim() };
  } catch (e) { return { ok: false, out: String(e.stderr || e.message).slice(0, 800) }; }
}

// While a long agent session runs, report its latest visible activity (file writes, renders) so it never looks hung.
function watchActivity(dir, label, setProgress) {
  const since = Date.now();
  const what = { 'film.js': 'animating', 'film.css': 'styling', 'plan.md': 'planning', 'review-log.md': 'reviewing its own frames', 'sheet.jpg': 'rendering a contact sheet', strip: 'rendering motion strips', frame: 'checking a frame' };
  const tick = () => {
    let latest = null;
    for (const sub of ['film', 'wiki', 'review']) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        const m = fs.statSync(path.join(d, f)).mtimeMs;
        if (m > since && (!latest || m > latest.m)) latest = { f, m };
      }
    }
    if (!latest) return setProgress?.({ detail: `${label} — reading the playbook (${Math.round((Date.now() - since) / 60000)} min)` });
    const key = Object.keys(what).find(k => latest.f.startsWith(k)) || '';
    const ago = Math.round((Date.now() - latest.m) / 1000);
    setProgress?.({ detail: `${label} — ${what[key] || `writing ${latest.f}`} (${ago < 60 ? `${ago}s` : `${Math.round(ago / 60)} min`} ago)` });
  };
  const id = setInterval(() => { try { tick(); } catch {} }, 15_000);
  id.unref?.();
  return () => clearInterval(id);
}

// Snapshot / restore everything the director wrote (film.js, parts/, film.css): a later round can regress.
const AUTHORED = f => !['index.html', 'spec.js', '.best'].includes(f) && !f.endsWith('.best.js');
// A 3D film's scene code (blender/*.py) belongs to the same version as its 2D layer, so it is snapshotted with it.
const pyFiles = dir => (fs.existsSync(path.join(dir, 'blender')) ? fs.readdirSync(path.join(dir, 'blender')).filter(f => f.endsWith('.py')) : []);
function snapshot(dir) {
  const film = path.join(dir, 'film'), best = path.join(film, '.best');
  fs.rmSync(best, { recursive: true, force: true }); fs.mkdirSync(best);
  for (const f of fs.readdirSync(film).filter(AUTHORED)) fs.cpSync(path.join(film, f), path.join(best, f), { recursive: true });
  const b = pyFiles(dir);
  if (b.length) { fs.mkdirSync(path.join(best, '.blender')); for (const f of b) fs.copyFileSync(path.join(dir, 'blender', f), path.join(best, '.blender', f)); }
}
function restore(dir) {
  const film = path.join(dir, 'film'), best = path.join(film, '.best');
  if (!fs.existsSync(best)) return;
  for (const f of fs.readdirSync(film).filter(AUTHORED)) fs.rmSync(path.join(film, f), { recursive: true, force: true });
  for (const f of fs.readdirSync(best).filter(f => f !== '.blender')) fs.cpSync(path.join(best, f), path.join(film, f), { recursive: true });
  const saved = path.join(best, '.blender');
  if (fs.existsSync(saved)) {
    for (const f of pyFiles(dir)) fs.rmSync(path.join(dir, 'blender', f), { force: true });
    for (const f of fs.readdirSync(saved)) fs.copyFileSync(path.join(saved, f), path.join(dir, 'blender', f));
    fs.rmSync(path.join(dir, 'blender', 'scene.blend'), { force: true });   // rebuilt from the restored code
  }
}

function scriptTable(spec) {
  // with the writer's "what we see" note per beat (a suggestion: the director may stage it better)
  return spec.scenes.map((s, i) => `${String(i + 1).padStart(2)}. [${Math.max(0, s.start).toFixed(2)}–${s.end.toFixed(2)}s] ${s.narration}${s.visual?.heading ? `\n      (writer's picture note: ${s.visual.heading})` : ''}`).join('\n');
}

const REVIEW_SCHEMA = {
  type: 'object', required: ['reading', 'problems', 'score', 'verdict'],
  properties: {
    reading: { type: 'string', description: 'what you understood happens / is explained, from the pictures alone' },
    confusing: { type: 'array', items: { type: 'string' } },
    ai_tells: { type: 'array', items: { type: 'string' }, description: 'anything that makes it feel AI-generated or template-made' },
    problems: { type: 'array', items: { type: 'object', properties: { where: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } } } },
    protect: { type: 'array', items: { type: 'string' } },
    score: { type: 'number', description: '1-10: would this hold a viewer and look studio-made?' },
    verdict: { type: 'string', enum: ['ship', 'revise'] },
  },
};

async function review(dir, spec, round, log) {
  const n = spec.scenes.length, d = spec.duration;
  // only this round's images: drop the director's own working strips
  const rv = path.join(dir, 'review');
  if (fs.existsSync(rv)) for (const f of fs.readdirSync(rv)) if (/^strip_/.test(f)) fs.rmSync(path.join(rv, f), { recursive: true, force: true });
  // strips: the hook, a middle action, the payoff
  const mid = spec.scenes[Math.floor(n / 2)], pay = spec.scenes[Math.max(0, n - 3)];
  const strips = [[0, 2.4], [mid.start, Math.min(mid.end, mid.start + 2.4)], [pay.start, Math.min(pay.end, pay.start + 2.4)]];
  if (has3d(dir)) {   // a 3D film: render the 3D stills for exactly these moments first, so the composite shows them
    const s3 = await b3d(dir, 'stills', 'auto');
    if (!s3.ok) return { score: 0, verdict: 'revise', reading: '', problems: [{ where: '3D scene', problem: `blender/scene.py does not build or render: ${s3.out}`, fix: 'fix the Blender script error' }] };
    for (const [a, b] of strips) await b3d(dir, 'strip', a.toFixed(2), b.toFixed(2), 8);
  }
  const sheet = await frames(dir, 'sheet', 'auto');
  if (!sheet.ok) return { score: 0, verdict: 'revise', reading: '', problems: [{ where: 'whole film', problem: `the film does not render: ${sheet.out}`, fix: 'fix the script error' }] };
  for (const [a, b] of strips) await frames(dir, 'strip', a.toFixed(2), b.toFixed(2), 8);
  const files = fs.readdirSync(path.join(dir, 'review')).filter(f => /^strip_.*\.jpg$|^sheet\.jpg$/.test(f)).map(f => `review/${f}`);
  const prompt = `You are reviewing a ${d.toFixed(0)}-second vertical animated YouTube Short (review round ${round}). Work read-only and look ONLY at these images:
${files.map(f => `- ${f}`).join('\n')}
sheet.jpg = one frame from each of its ${n} beats in order (left→right, top→bottom). strip_X.jpg = 6–8 consecutive moments starting at X seconds (read left→right) — use these to judge motion.
You can't hear the voice; the captions show what is said. The small logo top-left and the end card are the channel's and expected.

First, from the pictures alone: what happens / what does it explain? Which beats lost you?
Then judge it as a demanding motion-design lead: would a viewer keep watching, and does it look hand-crafted by a studio animator (like quality flat 2D motion-design reels) or AI-generated/template-made? Name every AI tell you see (stiff or snowman-like characters, everything centred, same entrance everywhere, empty or static frames, text doing the picture's work, unclear subject, muddy palette…).
Rank the concrete problems that most hurt the film, each with where it is and the single most effective fix. Say what already works and must be protected.
score 1–10; verdict "ship" only if it is genuinely good enough to publish. Don't invent problems to fill a list.`;
  try {
    return await askClaude(prompt, { schema: REVIEW_SCHEMA, model: env('CLAUDE_REVIEW_MODEL', 'sonnet'), tools: ['Read'], cwd: dir, maxTurns: 10, timeoutMs: 10 * 60_000, log, label: `review ${round}` });
  } catch (e) { if (e.limit) throw e; log.warn(`review failed: ${e.message}`); return null; }
}

/**
 * Make the bespoke film for a run. Returns { html, spec, rounds, score } or throws (caller falls back to templates).
 */
export async function directFilm({ dir, spec, plan, log, rounds = Number(env('DIRECTOR_ROUNDS', '3')), setProgress, language: forced }) {
  const html = writeFilmPage(dir, spec);
  fs.mkdirSync(path.join(dir, 'wiki'), { recursive: true });
  const kit = path.join(ROOT, 'engines', 'kit');
  const toStudio = path.relative(dir, ROOT).replace(/\\/g, '/');            // e.g. ../../..
  const tool = `node ${toStudio}/src/tools/frames.js film/index.html`;
  const tool3d = `node ${toStudio}/src/tools/blender3d.js .`;
  // the visual language: chosen by the owner in the dashboard, or picked by the director from the rotation
  const pick = byId(forced);
  const { choices, recent } = rotationChoices();
  const languageRule = pick
    ? `The channel owner chose the visual language for this film: **${pick.name}**. Use it (write \`Language: ${pick.name}\` in wiki/plan.md) and Read its reference sheets: ${pick.refs.map(r => `${toStudio}/engines/kit/refs/${r}.jpg`).join(', ') || '(none; follow the playbook description)'}.`
    : `Pick the visual language that best fits this story from: ${choices.map(l => `${l.name}${l.engine === '3d' ? ' (3D)' : ''}`).join(' · ')}.${recent.length ? ` Recently used, so avoid: ${recent.join(', ')}.` : ''} Then Read its reference sheets in ${toStudio}/engines/kit/refs/.`;
  // 3D languages: Blender builds the world under the 2D layer
  const lang3d = pick?.engine === '3d';
  const threeD = `
${lang3d ? 'This is a 3D film' : 'If you pick a 3D language (marked 3D)'}: Read ${toStudio}/engines/blender/PLAYBOOK3D.md first. Write blender/scene.py with bkit (the 3D world)
and film/film.js starting with Film.backdrop() (captions, keyword, chips, arrows on top). 3D commands (Blender, headless; each prints its time):
  ${tool3d} build                    (build scene.py; prints Python errors)
  ${tool3d} stills auto              (half-size 3D stills at the sheet times → review/b3d_sheet.jpg; also feeds the composite sheet)
  ${tool3d} strip <from> <to> 8      (3D motion strip → review/b3d_strip_<from>.jpg)
Render the 3D stills for the same times BEFORE a composite frames.js sheet/strip. Never run "render": the pipeline renders every frame later.`;
  let last = null, best = null;
  // resuming an interrupted run: a finished first build goes straight to review; an unfinished one gets completed
  const builtMark = path.join(dir, 'wiki', '.round1-done');
  const hasFilm = fs.existsSync(path.join(dir, 'film', 'film.js'));
  const resumed = hasFilm && fs.existsSync(builtMark);
  const unfinished = hasFilm && !resumed;
  for (let r = 1; r <= rounds; r++) {
    setProgress?.({ detail: `Animation director — round ${r}/${rounds}: designing and animating` , stagePct: (r - 1) / rounds });
    const notes = last ? `
An independent reviewer just watched the current cut (frames only, no code). Their reading: "${last.reading}"
Confusing beats: ${(last.confusing || []).join(' | ') || 'none'}
AI tells they saw: ${(last.ai_tells || []).join(' | ') || 'none'}
Ranked problems:
${(last.problems || []).map((p, k) => `${k + 1}. [${p.where}] ${p.problem} → ${p.fix}`).join('\n')}
Protect: ${(last.protect || []).join(' | ') || '—'}
Score ${last.score}/10. Read wiki/plan.md and wiki/review-log.md, then make the highest-value changes (a whole passage may need re-staging, not a parameter tweak), re-render and check them yourself.` : '';
    const opening = r === 1
      ? `You are the animation director for this Short. Read first: ${toStudio}/engines/kit/PLAYBOOK.md, ${toStudio}/engines/kit/README.md, ${toStudio}/engines/kit/refs/INDEX.md, and (for API usage only, not a style to copy) ${toStudio}/engines/kit/examples/carrot-walk.js.
${languageRule}${threeD}`
      : `You are the animation director for this Short, back for revision round ${r}. Keep the visual language you chose (wiki/plan.md).`;
    const prompt = `${opening}

Title: ${spec.title}
Topic: ${plan.topic} — ${plan.angle || ''}
Main subject: ${plan.subject?.name || plan.topic}
Duration: ${spec.duration.toFixed(1)} s (the last ~2 s are the channel end card). Voice timings per beat (absolute seconds):
${scriptTable(spec)}

Workspace: this folder. film/index.html + film/spec.js are generated (SPEC has the same scenes + word timings) — don't edit them.
Write the film as PARTS so later fixes stay small: film/film.js = shared setup (palette, layers, cast/rigs, camera, captions) ending with
\`Film.parts = ['parts/01-….js', 'parts/02-….js', …]\`, and film/parts/NN-name.js = one passage each (a few scenes, under ~15 KB). Plus film/film.css if useful and notes in wiki/.
Look at your work with:
  ${tool} sheet auto            (one frame per beat → review/sheet.jpg)
  ${tool} strip <from> <to> 8   (motion strip → review/strip_<from>.jpg)
  ${tool} frame <t> [t2 …]      (full-size frames)
  Combine jobs in ONE command, e.g. \`${tool} strip 3 5 8 strip 20 22 8 frame 12.5\`.
then Read the images. Every turn re-sends the whole conversation, so work in few, big turns: make several Edits in
one message, render everything you need in one command, and Read several images in one message. ${r === 1 && unfinished ? 'This is round 1, CONTINUED: a previous session was interrupted while building this film. Do not start over. Read wiki/plan.md, Glob film/ to see which passages exist, Read film/film.js only as far as you need for the shared setup, build every missing passage to the same standard, then self-check the whole film.' : r === 1 ? 'This is round 1: plan, build the whole animatic, pilot the hook, build out, self-check.' : `This is round ${r} (a revision). Your plan and decisions are in wiki/plan.md and wiki/review-log.md: do NOT re-read the playbook, README, references or the whole film. Grep to find the code, Read only the part you are changing, change it with Edit (never rewrite whole files), then re-render just the affected beats (strips/frames) plus one final sheet.`}${notes}

Finish with a 3-line summary: craft claim, visual language, what is still weakest.`;
    if (r === 1 && resumed) log.info('director: existing film found — reviewing it first');
    else try {
      const stop = watchActivity(dir, `Animation director — round ${r}/${rounds}`, setProgress);
      const summary = await askClaude(prompt, {
        model: env('CLAUDE_DIRECTOR_MODEL', 'opus'), cwd: dir, addDirs: [kit, path.join(ROOT, 'engines', 'blender')], label: `director ${r}`, maxTurns: r === 1 ? 140 : 70, timeoutMs: 50 * 60_000, retries: 0, log,
        tools: ['Read', 'Write', 'Edit', 'Glob', 'Grep', `Bash(${tool}:*)`, `Bash(${tool3d} build:*)`, `Bash(${tool3d} stills:*)`, `Bash(${tool3d} strip:*)`],
      }).finally(stop);
      log.info(`director round ${r}: ${String(summary).replace(/\s+/g, ' ').slice(0, 300)}`);
      if (r === 1) fs.writeFileSync(builtMark, new Date().toISOString());
    } catch (e) {
      if (e.limit) throw e;   // usage limit: pause the run and resume later; never ship a half-built film
      // a session that ran out of turns/time may still have left a working film — the review decides
      log.warn(`director round ${r} ended early: ${e.message}`);
    }
    if (!fs.existsSync(path.join(dir, 'film', 'film.js'))) throw new Error('director produced no film.js');
    setProgress?.({ detail: `Animation director — round ${r}/${rounds}: independent review`, stagePct: (r - 0.3) / rounds });
    last = await review(dir, spec, r, log);
    if (!last) { if (r === rounds) break; continue; }
    log.info(`review round ${r}: score ${last.score}/10, ${last.verdict} — ${String(last.reading).slice(0, 160)}`);
    fs.appendFileSync(path.join(dir, 'wiki', 'review-log.md'), `\n## Independent review — round ${r} (same-family, frames only)\nscore ${last.score}, ${last.verdict}\nreading: ${last.reading}\n${(last.problems || []).map(p => `- [${p.where}] ${p.problem} → ${p.fix}`).join('\n')}\n`);
    const prev = best;
    if (!best || last.score >= best.score) { best = { ...last, round: r }; snapshot(dir); }
    if (last.verdict === 'ship' || last.score >= 8) break;
    // a third round only pays off while the film is still clearly improving (saves ~1/3 of the tokens otherwise)
    if (r >= 2 && prev && last.score - prev.score < 0.5) { log.info(`round ${r} didn't improve the film (${prev.score} → ${last.score}) — stopping here`); break; }
  }
  // keep the best-reviewed version (a later round can regress)
  if (best) restore(dir);
  const language = (() => { try { return (fs.readFileSync(path.join(dir, 'wiki', 'plan.md'), 'utf8').match(/^\s*\**Language:?\**:?\s*(.+)$/mi) || [])[1]?.replace(/[*_`]/g, '').trim().slice(0, 60); } catch { return null; } })();
  const check = await frames(dir, 'frame', '1');
  if (!check.ok) throw new Error(`final film does not render: ${check.out}`);
  if (best && best.score < 5) throw new Error(`director film scored ${best.score}/10 — falling back to templates`);
  if (language) kvSet('recentLanguages', [...(kvGet('recentLanguages') || []), language].slice(-8));
  return { html, spec, rounds: best?.round, score: best?.score ?? null, language };
}
