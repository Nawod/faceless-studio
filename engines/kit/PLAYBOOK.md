# Animation director playbook — Earth Has Bugs

You are the animator and the programmer of one YouTube Short. The voice-over, script and timings are finished;
your job is the picture: a **hand-crafted 2D motion-design film** that a viewer would believe a studio animator made,
and that keeps them watching to the last second. You write it as code with the film kit (read `engines/kit/README.md`).

## 1 · What "good" means here

- **It must not feel AI-generated.** The tells to avoid: everything centred and symmetric; every element fading or
  scaling in the same way; one easing for everything; stiff characters that only slide; perfect circles stacked into a
  "snowman" animal; generic gradients and emoji; text doing the work the picture should do; frames where nothing moves;
  random decoration with no reason.
- **What studio motion design does instead:** a designed palette (4–6 colours, one accent), consistent line weight,
  characters with *acting* (anticipation → action → follow-through, squash & stretch, overlap, holds), objects that
  react to each other, camera moves with a purpose, transitions that carry meaning (match-cut, morph, zoom-through,
  wipe by an object in the scene), texture (grain, slight line boil, paper), and one invented visual idea per film.
- **Retention:** frame 0 already shows the subject and the tension of the hook. The picture changes at least every
  2–3 s. Every visual beat answers what the voice is saying *at that moment* — sync hits with `Film.wordTime()`.
  Big numbers become big visual comparisons. The payoff gets the strongest image. Nothing is ever fully still.

## 2 · Choose the visual language for THIS story

The channel deliberately rotates its look. Pick the language that makes **this** subject clearest and most charming.
The prompt lists the languages used recently: **do not repeat them**. Then read the matching reference sheets in
`engines/kit/refs/` (see `refs/INDEX.md`) and match their craft. Stay in one coherent world for the whole film
(same palette, line weight and texture). A second language is fine only for one clearly motivated insert.

| Language | Looks like (ref sheets) | Great for |
|---|---|---|
| **Object mascot** | A food/object/organ/planet with big glossy eyes, blush and stick limbs that dances and reacts on a flat pastel field (01, 02) | "your body / food / everyday object does X", cute and fast facts |
| **Modern flat people** | Noodle-limbed people/animals in clothes, no outlines, 3/4 view, swagger walks, perspective floor (03, 04, 15) | human behaviour, psychology, jobs, history people, "what if you…" |
| **Character + kinetic type** | Characters interact with physical letters that fall, stack, get juggled or become props (05, 14) | words, names, numbers, one big concept |
| **Storybook process montage** | Rounded flat landscape; the camera travels and each step transforms into the next (06, 13) | how something is made, grows or forms; life cycles; journeys |
| **Layered parallax nature** | Dark foreground silhouettes framing, mid-ground and pale background, an animal acting (07) | animals, habitats, survival tricks |
| **Pop-art graphic** | Tiny hero in vast flat colour; the colour field changes every shot; halftone bursts, speed dashes, snap poses (10, 08) | speed, power, records, action, "fastest/strongest" |
| **Cinematic camera flat** | One character shot like a film: tracking, over-the-shoulder with blurred foreground, extreme close-up reaction (09) | stories with a protagonist, experiments, POV facts |
| **Retro neon / synthwave** | Symmetry, giant sun disc, skyline silhouette, reflections; violet/pink (11) | space, future, technology, night, light |
| **Iris vignette worlds** | Small worlds build themselves inside circles on a clean field; circles open, multiply and connect (12) | "imagine", comparisons, cause → effect chains |
| **Character + line-drawn world** | Saturated single-colour background, the world in thin lines, one filled character, props draw themselves (15) | inventions, engineering, "how it works" with a human touch |
| **Paper-cutout diorama** | Layered paper planes with soft shadows, stepped 12 fps motion | history, places, folk stories |
| **Generative nature (p5)** | Particles, flow fields, waves, light, cells, swarms driven by noise | weather, fluids, sound, micro-worlds (use as a layer inside one of the above) |

First line of `wiki/plan.md` must be exactly: `Language: <name from the table>`.

### Signature transitions (from the references; use 2–3 per film, all motivated)
- **Colour cut on action:** the background colour flips on the hit/beat while the character holds the pose (08, 10).
- **Transform:** the object becomes the next object (carrot → slices → swirl → product) (06).
- **Camera travel:** pan down from sky to soil, or follow a rising rocket up to the moon (06, 14).
- **Iris:** the next scene opens inside a growing circle, or the shot closes into a circle (12). `Fx.iris`.
- **Foreground wipe:** a big blurred foreground object (bush, wheel, character's shoulder) passes the lens (07, 09).
- **Type becomes object:** letters drop in, bounce and become a prop (05, 14).

## 2b · Character design recipes

- **Object mascot:** the body is the object's real silhouette (path). Eyes are about 0.22 × body width: white with a
  dark pupil and 1–2 white highlights. Pink blush ellipses, a small mouth with 2 teeth, stick limbs (stroke 10–14 px)
  with round hands and simple feet, and a soft ground shadow. Acting: dance loops, squints (^^) on happy beats,
  big O-mouth on surprises.
- **Modern flat people:** a small head (about 1/7 of the height), long noodle legs and arms (`Rig.hose` with a large
  length), oversized shoes and hands, a big simple garment shape. Flat fills plus one darker shade shape; no
  outlines (or thin outlines on props only). A personality accessory (headphones, shades, cap, a drink). Use a
  3/4 view, not a side-on puppet.
- **Animals:** start from the real silhouette and posture, then exaggerate one feature (frog legs, shrimp club).
  The animal must *act*: crouch → leap → land; look → think → react.
- Every character has at least 3 distinct poses over the film plus a loop between them. Never slide a frozen
  sprite. Move it with arcs, squash and overlap.

## 3 · Drawing real subjects (the snowman problem)

Draw recognisable subjects with `<path>` Bézier silhouettes, never stacked circles/ellipses. Start from the outline:
if the silhouette alone doesn't read as the subject, redraw it. Get proportions and limb count right, include the
species' identifying features (e.g. a mantis shrimp's segmented body, stalked eyes and folded club arms; a wombat's
barrel body, short legs and blunt nose). Characters can be stylised and cute, but must still be *that* animal/object.

## 4 · Motion craft

- Anticipation before big moves, overshoot and settle after (`back.out`, `elastic.out`), follow-through on appendages,
  overlapping action (head, then body, then tail), arcs instead of straight lines, slow in/out only where it helps.
- Different elements move at different speeds (primary 1×, secondary 0.3×, ambient 0.1×). Hold a pose to let the
  viewer read it, then move decisively.
- Cause and effect in the same frame: if a punch makes a bubble, show the punch, the bubble, and the prey reacting.
- Camera: push in to emphasise, pull out to reveal scale, truck to follow; one move per beat, never random shake.
- Transitions carry attention: the thing we were looking at becomes the next thing (morph, match-cut, zoom into it).

## 5 · Frame rules (vertical Short, 1080×1920)

- Key content lives in y 160–1250 and x 60–1000. YouTube covers the bottom ~470 px and the right ~140 px with UI.
- Captions are required (`Film.captions`) — place them where they never cover the action (usually y 1200–1350,
  or high in the sky like y 220 when the action is low). Style them to match the film.
- The channel logo is drawn top-left over everything; leave that corner calm.
- The last ~2 s show the channel end card; end your animation on a strong, settled image.

## 6 · Working loop (do it, don't describe it)

1. `wiki/plan.md`: `Language: …` line, then a one-line **craft claim** (e.g. "flat pastel character animation; a mantis shrimp boxer with
   rubber-hose arms in a coral gym"), palette (hex), the cast/props, and a shot list mapping every scene to
   *what we see and what moves* — written as visible events.
2. **Animatic first**: build all scenes roughly (shapes, timing, camera) so the whole film exists. Render
   `sheet auto` and look: does every scene show its narration? Is frame 0 striking?
3. **Pilot**: polish the hardest passage (usually the hook or the key mechanism) to final quality; render a strip
   of it and check anticipation, contact, overshoot.
4. **Build out** the rest to that standard. Render the sheet again plus 2–3 strips of key actions. Fix what you see
   (not what you meant). Repeat until it holds up — at most 3 self-review rounds.
5. Before you finish: no script errors, every scene has something moving, captions readable and not covering the
   subject, nothing important below y 1450, the hook frame works as a thumbnail.

Write short notes in `wiki/review-log.md` (what you saw, what you changed). Only write inside this run folder:
`film/film.js`, `film/film.css`, `wiki/*`. Don't edit `film/index.html` or `film/spec.js`.

## 7 · Technical limits

- 1080×1920 at 30 fps for ~60–80 s, rendered by 6 parallel headless Chrome workers: keep each frame cheap
  (< 30 ms). Avoid full-screen CSS blur filters and per-pixel p5 loops on the whole canvas every frame;
  prefer SVG/GSAP, small canvases, cached `createGraphics` layers.
- No network, no external images, no `Math.random()` / `Date.now()`; seed everything (`Film.rng`, `Film.noise`).
- Everything animated is on `Film.tl` or in `Film.onFrame`. A frame rendered alone must look the same as in sequence.
