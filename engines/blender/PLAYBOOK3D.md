# 3D film playbook (Blender) — read this for any 3D visual language

A 3D film has **two layers on one clock**:
1. **`blender/scene.py`** — the 3D world, written with `bkit` (API below) and rendered by Blender (EEVEE) to frames.
2. **`film/film.js`** — the 2D layer on top, made with the film kit: `Film.backdrop()` (the Blender frames) + captions,
   the big keyword, label chips, arrows, number cards, date cards, maps. Text never goes in 3D except real signage.

Method (from "Claude + Blender: Make 3D Motion Graphics From Code"): code answers *what does the frame look like at time t*;
one timeline (the voice timings in SPEC); **stills before the render**; fixes as *observation → exact number*; every frame
renders on its own, so only what changed re-renders.

## 1 · The brief (write it in wiki/plan.md before code)
`Language: <3D language name>` then six blocks:
- **SUBJECT** — the hero object(s) as clear, recognisable toy-like shapes, with exact hex colours.
- **SET** — where it lives (studio sweep, holo-grid lab, night street, space, glossy glass desk).
- **BEATS** — for every scene: what we SEE and what MOVES, landed on the voice (`K.word(i, 'word')`). Every beat changes
  something visible. Big numbers become physical comparisons (stack, scale, distance).
- **CAMERA** — shot list: open on the subject already in action (frame 0 is the thumbnail), push in to emphasise, pull out
  to reveal scale, orbit to show how it works, hard cut (`K.cut`) on a new idea. Never a static camera.
- **LOOK** — one look from the table below; palette 4–6 colours + 1 accent.
- **2D LAYER** — which words become the big keyword, which chips/labels/arrows/number cards appear and when.

## 2 · Visual languages (pick by story; refs in engines/kit/refs/)
| Language | Look (setup look=) | Recipe | Refs |
|---|---|---|---|
| **3D studio explainer** | `studio` | Clean primitives + props on a seamless sweep (`K.cyclorama`), soft three-point light (`K.studio`), matte pastel materials, slow orbits, exploded/assembled parts. 2D: centred white keyword + small pill chips + date/number cards | 16 |
| **X-ray hologram 3D** | `holo` | Black world, `K.grid_mat` floor, subjects in `K.xray` (glowing rim, see-through) with one solid coloured inner part (organ, engine, seat) to show the mechanism; glowing rings/arrows (`K.emission`), bloom | 18 |
| **Cinematic 3D** | `cinematic` | Moody realism: dark set, practical lights (rows of emissive strips, lamps), rim light, DOF (`K.camera(fstop=2.8)`), slow dolly + shake on impacts, Poly Haven HDRI/models when they fit | 17 |
| **Cosmic 3D** | `space` | `K.stars`, planets as spheres with emission/procedural colour, the Sun as strong emission + bloom, orbits as thin emissive tori, scale reveals by camera pull-out | 19 |
| **Toy motion graphics 3D** | `holo` or `studio` | The guide's look: a toy-shaped hero hops (`K.hop`) across glowing buttons/panels on black glossy glass (`K.mat(rough=0.08, coat=1)`), every hop changes the result, lights hidden from reflections | (guide) |

## 3 · Making real subjects read (the snowman problem, in 3D)
- Build from the **silhouette**: proportions and the 2–3 identifying parts (a frog's long legs and bulging eyes; a helicopter's
  two rotors and tail boom). Use bevels (`bevel=`) — sharp primitives look like programmer art.
- Join simple parts into one readable object; give it 2–3 materials max; parent parts to an empty and animate the empty.
- Use **CC0 assets** when a real object must read instantly: `K.polyhaven_model('slug', height=1.2)` (props, furniture,
  plants, rocks) and `K.hdri('slug')` for natural light. Check https://polyhaven.com/models and /hdris for slugs.
  No people/animals/vehicles there — build those stylised (mannequin from capsules, X-ray body, toy car).
- Stylised beats fake-realistic: a clean toy model with good light beats a lumpy "realistic" one.

## 4 · Motion craft in 3D
- Things arrive with energy (`K.pop_in`, ease `BACK`), leave with intent (`K.pop_out`), and idle gently (`K.wobble`).
- Mechanisms move in order with overlap: part A starts, B follows 3–5 frames later. Use `EXPO`/`CUBIC` for snappy moves,
  `BOUNCE` for landings, `STEP` for UI snaps.
- Camera: one move per beat; ease every shot (`K.shot(..., ease='EXPO')`); `K.shake` on impacts/launches only.
- Cause and effect in the same frame (the arc and the spark; the rotor and the shadow).

## 5 · Frame rules (9:16, 1080×1920)
- Subject large and in the upper-middle (y 300–1200 of 1920). Keep the bottom ~470 px free of key action (YouTube UI) and
  leave the caption band (y 1200–1350) readable — darker or calmer there.
- Frame 0 shows the subject already doing something (it is the thumbnail).

## 6 · Render budget (RTX 2050, 4 GB) — EEVEE only
- Target ≤ 1.5 s/frame at full size (the film is ~1800–2400 frames). Check with `stills` (it prints the time).
- Avoid: volumes/smoke sims, huge particle counts (> 5k instances), 4K textures, Cycles. Fake fog with a dark world + glow.
- `K.setup(samples=32)` is the default; 16 is fine for dark/holo looks.

## 7 · Working loop
1. Plan (§1). 2. Build `blender/scene.py` roughly for ALL beats → `blender3d.js <ws> build`.
3. `blender3d.js <ws> stills auto` → Read `review/b3d_sheet.jpg`: subject readable? camera moving? frame 0 strong? colours right?
4. Pilot the hook in 3D (`strip 0 2.4 8`) until it is great; build out; re-check stills.
5. Write `film/film.js`: `Film.backdrop()` first, then the 2D layer (captions, keyword, chips, arrows, numbers) synced with
   `Film.wordTime`. Check the composite with `frames.js film/index.html sheet auto` (it uses the 3D stills you rendered —
   render 3D stills for the same times first).
6. Never run the full 3D render yourself — the pipeline renders every frame after the review.

## bkit API (engines/blender/bkit.py)
```
K.setup(look='studio'|'toon'|'holo'|'night'|'space'|'cinematic', samples=32, motion_blur=False, exposure=None)
K.FPS, K.FRAMES, K.SPEC; K.sec(t), K.at(i, off), K.end(i), K.word(i, 'word')          # time → frame
K.mat(name, hex, rough, metal, emit, strength, coat, alpha, transmission); K.emission(name, hex, strength)
K.toon(name, hex, shade_hex, steps); K.xray(name, hex, strength, core); K.grid_mat(...); K.glass(name, hex)
K.box(size, loc, material, bevel, name, rot); K.sphere(r, loc, material); K.cylinder(r, depth, loc, material, rot, bevel)
K.cone(r1, r2, depth, loc, material, rot); K.torus(r, thick, loc, material, rot); K.plane(size, loc, material, rot)
K.text3d(text, size, loc, material); K.arrow3d(length, loc, rot, material); K.empty(loc); K.parent(child, parent)
K.join([objs]); K.instances(obj, positions)
K.key(obj, 'location'|'scale'|'rotation_euler'|…, frame, value, ease); K.move(obj, f0, f1, a, b, ease)
K.pop_in(obj, frame, dur); K.pop_out(obj, frame, dur); K.spin(obj, f0, f1, turns, axis); K.hop(obj, f0, f1, a, b, height)
K.wobble(obj, f0, f1, amp, freq)
K.camera(lens, fstop) → cam; K.shot(cam, frame, loc, look_at, lens, ease); K.cut(cam, frame, loc, look_at, lens); K.shake(cam, f0, f1, amp)
K.light(kind, loc, energy, size, hex, aim); K.studio(); K.world_color(hex, strength); K.world_gradient(top, bottom)
K.cyclorama(hex); K.stars(count); K.hdri(slug, strength, show); K.polyhaven_model(slug, height=…, loc=…); K.bloom(threshold, size)
K.save()   # always last
```
Eases: LINEAR SMOOTH SINE QUAD CUBIC EXPO OUT IN BACK BOUNCE ELASTIC STEP.
