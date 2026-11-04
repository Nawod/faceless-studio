# Film kit — API for bespoke films

Your film is **one JavaScript file** (`film.js`, plus optional `film.css`) loaded into a page that already has:

| Global | What |
|---|---|
| `gsap` 3.13 + `MorphSVGPlugin`, `DrawSVGPlugin`, `MotionPathPlugin`, `CustomEase`, `Physics2DPlugin`, `SplitText` | already registered |
| `p5` 1.11 | instance mode only, through `Film.p5()` |
| `anime` 4 (UMD) | optional; drive it from `Film.onFrame` with `.seek(ms)` |
| `THREE` | only if the page was built with 3D enabled |
| `Film`, `Rig` | this kit |
| `SPEC` | the plan: scenes (narration, timing, visual hints), words (voice timings), subject, title |

Canvas: **1080×1920** (`Film.W`, `Film.H`), 30 fps, `Film.DUR` seconds. Fonts available: Inter (400–900), Anton, Archivo Black, Patrick Hand, Gaegu, Space Mono, DM Serif Display, Courier Prime. No network: everything is drawn by your code.

## Splitting the film into parts

`film/film.js` holds the shared setup (palette, layers, cast and rigs, captions) and ends with
`Film.parts = ['parts/01-hook.js', 'parts/02-lab.js', …]`. The page loads the parts in that order, after film.js.
Everything defined at the top level of film.js (`const`/`function`) is visible to the parts. Keep each part
under about 15 KB, so a revision only touches one small file.

## The one rule: time is a pure function

The renderer calls `render(t)` for frames **in any order, in parallel browsers**. So:

- Put every animation on the master timeline **`Film.tl`** at an absolute time: `Film.tl.to(el, { x: 200, duration: .5, ease: 'back.out(2)' }, Film.at(3, 0.2))`.
  Never call `gsap.to()` directly — tweens outside `Film.tl` don't render.
- Per-frame procedural drawing (canvas, p5, noise, physics you can evaluate in closed form) goes in **`Film.onFrame(t => …)`**.
  It must not depend on the previous frame. Use `Film.rng(seed)`, `Film.noise(x, seed)`, never `Math.random()`/`Date.now()`.
- Something that loads (an image you generate, a font) → `Film.ready(promise)`.

## Timing helpers

- `Film.scenes[i]` → `{ start, end, narration, visual }` (seconds). `Film.at(i, offset)` → absolute time inside scene i.
- `Film.wordTime(i, 'boom')` → when that word is spoken in scene i (sync hits to the voice!).
- `Film.talk(t)` → 0..1 mouth openness while the voice speaks (lip-sync).
- `Film.step(t, 12)` → time quantised to 12 fps (hand-drawn "on twos" cadence for boil / held poses).
- `Film.sceneAt(t)` → `{ i, s, local }`.

## Layers

- `Film.svgLayer(z)` → full-frame `<svg viewBox="0 0 1080 1920">` (most character/flat motion work lives here).
- `Film.canvasLayer(z)` → full-frame `<canvas>` (draw in `onFrame`).
- `Film.p5((p, t) => { … }, z, setup)` → p5 sketch redrawn at film time t (`p.noLoop()` is set for you).
- `Film.el(tag, attrs, parent, html)` → creates HTML or SVG elements (SVG namespace handled).
- `Film.grain({ opacity })`, `Film.vignette({ strength })` → hand-made finish. Use them.
- `Film.captions({ style, y })` → word-synced captions. Styles: `pop` (bold white, outlined), `clean` (dark on light), `marker`, `hand`, `mono`, `serif`; or pass `custom: { font, color, stroke, strokeW, hi, upper }`. Keep y ≈ 1200–1350 (below the action, above YouTube's UI). Captions are required.

## Character rig (`Rig`) — for flat 2D character motion design

- `Rig.hose([x1,y1], [x2,y2], length, bend)` → path `d` of a rubber-hose limb of fixed length (bows out naturally as ends approach). Use thick round-capped strokes.
- `Rig.walk(t, { speed, stride, lift, armSwing, legLen, run })` → `{ feet:[{x,y},{x,y}], hands:[…], bob, lean, squash }` for a walk/run cycle.
- `Rig.idle(t)` → breathing bob/sway so a standing character is never frozen.
- `Rig.jump(t, t0, { dur, height, crouch })` → `{ y, sx, sy }` with anticipation crouch, stretch, landing squash.
- `Rig.squash(amount)` → volume-preserving `{ sx, sy }`.
- `Rig.blink(t, seed)` → eye openness 0..1. `Rig.look(eyeCenter, target, r)` → pupil position.
- `Rig.mouth(cx, cy, w, open, smile)` → mouth path (feed `open = Film.talk(t)` for lip-sync).
- `Rig.boil(t, seed, amp)` → stepped wobble offsets for a hand-drawn line feel.

## Effects (`Fx`): the reference-library moves, ready to use

- `Fx.iris(svg, group, { cx, cy, t0, dur, from, to })`: the group is revealed inside a growing circle (or closed: from > to).
- `Fx.colorCuts(svg, [[t, '#hex'], …])`: a full-frame background that hard-cuts colour on action beats (pop-art/tank refs).
- `Fx.halftone(parent, { cx, cy, r, dot, color })`: pop-art dot burst `<g>`; scale it in on Film.tl behind a hero pose.
- `Fx.speedLines(parent, { t0, t1, dir, count, color })`: streaming speed dashes.
- `Fx.puff(parent, { x, y, t0, dur, size, color, drift })`: smoke/dust/steam cluster that blooms and fades.
- `Fx.starburst(parent, { x, y, t0, dur, r1, r2, color })`: impact/muzzle/idea flash.
- `Fx.shake(group, { t0, dur, amp })`: decaying camera shake.
- `Fx.letters(parent, 'WORD', { x, y, size, font, color, t0 })`: letters drop and bounce in as objects. Returns the
  `<text>` elements to juggle or scatter further.

## Useful GSAP moves (all on `Film.tl`)

- `morphSVG` between two path shapes (a seed becoming a tree, a blob becoming a heart).
- `drawSVG: "0% 100%"` to draw a stroke on; `motionPath: { path, autoRotate: true }` to fly along a curve.
- Eases with character: `back.out(1.7)` (overshoot), `elastic.out(1, .4)` (springy), `expo.inOut` (snappy camera), `steps(6)` (stop-motion), `CustomEase.create('hop', 'M0,0 C.2,0 .2,1 .5,1 .8,1 .8,0 1,0')`.
- `stagger: { each: .04, from: 'center' }` for groups; `SplitText` for letter-by-letter type.
- `repeat: -1` / `yoyo: true` are fine on Film.tl — they still evaluate deterministically.

## Reference library

`engines/kit/refs/INDEX.md` plus 15 sheets of frames from the channel owner's favourite motion-design clips.
Read the sheets for your chosen language before drawing.

## Rendering & checking your work

Run (from the run folder): `node <studio>/src/tools/frames.js film/index.html sheet 0.5,3,6.5,...` → a contact sheet `review/sheet.jpg`,
and `node <studio>/src/tools/frames.js film/index.html strip 12.0 13.2 8` → 8 frames across 12.0–13.2 s in `review/strip_12.0.jpg`
(use strips to judge motion: anticipation, contact, overshoot, follow-through). Read the images and fix what you see.
Errors in your script are printed by the tool — fix them first.
