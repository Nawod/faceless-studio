// RIG — character animation helpers for flat 2D motion design (rubber-hose limbs, walk cycles, faces, squash & stretch).
// All functions are pure functions of time/parameters; you place the results into SVG elements you created.
(function () {
  const { clamp, lerp, noise } = window.Film;
  const TAU = Math.PI * 2;

  /**
   * Rubber-hose limb of fixed length between two points: when the ends come closer the hose bows out smoothly
   * (classic 1930s / modern motion-design arms and legs). Returns an SVG path "d".
   *   bend: +1 / -1 picks the side it bows to (elbows/knees).
   */
  function hose([x1, y1], [x2, y2], length, bend = 1) {
    const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 0.001;
    const slack = Math.max(0, length - d);
    const sag = Math.sqrt(slack * length) * 0.62 * bend;           // how far the middle bows out
    const nx = -dy / d, ny = dx / d;                                 // normal
    const mx = (x1 + x2) / 2 + nx * sag, my = (y1 + y2) / 2 + ny * sag;
    // quadratic through the bowed mid point → cubic with the same shape
    const cx = 2 * mx - (x1 + x2) / 2, cy = 2 * my - (y1 + y2) / 2;
    return `M${x1.toFixed(1)},${y1.toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}`;
  }

  /**
   * Walk / run cycle. Returns offsets in the character's local space (pixels) for feet, hands, hip bob and lean.
   *   phase = (t * speed) cycles per second.  stride = foot travel.  lift = foot raise.
   *   feet: [{x,y}, {x,y}] relative to the hip; hands: [{x,y}, {x,y}] relative to the shoulder.
   */
  function walk(t, { speed = 1.1, stride = 70, lift = 34, armSwing = 50, legLen = 150, run = false } = {}) {
    const ph = t * speed * TAU;
    const foot = k => {
      const a = ph + k * Math.PI;
      const x = Math.cos(a) * stride / 2 * -1;
      const y = legLen - Math.max(0, Math.sin(a)) * lift;            // lifts only during the swing
      return { x, y };
    };
    const hand = k => ({ x: Math.cos(ph + k * Math.PI) * armSwing / 2, y: 0 });
    const bob = -Math.abs(Math.cos(ph)) * (run ? 16 : 9);           // body is highest at passing position
    return { feet: [foot(0), foot(1)], hands: [hand(1), hand(0)], bob, lean: run ? 0.14 : 0.04, squash: 1 + Math.cos(ph * 2) * (run ? 0.04 : 0.02) };
  }

  /** Idle "breathing" + weight shift so a standing character is never frozen. */
  function idle(t, { amp = 1 } = {}) {
    return { bob: Math.sin(t * 2.2) * 4 * amp, sway: noise(t * 0.6, 3) * 0.03 * amp, squash: 1 + Math.sin(t * 2.2) * 0.012 * amp };
  }

  /** Jump arc with anticipation (crouch), stretch on take-off, squash on landing. t0 = start, dur = air time. */
  function jump(t, t0, { dur = 0.7, height = 260, crouch = 0.22 } = {}) {
    const a = t - t0;
    if (a < 0) return { y: 0, sx: 1, sy: 1 };
    if (a < crouch) { const p = a / crouch; return { y: 0, sx: 1 + 0.18 * Math.sin(p * Math.PI / 2), sy: 1 - 0.2 * Math.sin(p * Math.PI / 2) }; }
    const b = a - crouch;
    if (b < dur) { const p = b / dur, y = -4 * height * p * (1 - p); const st = 1 + 0.18 * (1 - Math.abs(p * 2 - 1)) * (p < 0.5 ? 1 : 0.4); return { y, sx: 1 / st, sy: st }; }
    const c = b - dur; const land = Math.exp(-c * 9) * Math.cos(c * 22);
    return { y: 0, sx: 1 + 0.22 * land, sy: 1 - 0.22 * land };
  }

  /** Squash & stretch that preserves volume. amount > 0 stretches vertically. */
  const squash = amount => ({ sx: 1 / Math.sqrt(1 + amount), sy: 1 + amount });

  /** Blink: returns eye openness 0..1 (random-feeling but deterministic). */
  function blink(t, seed = 1) {
    const period = 2.6 + (seed % 3) * 0.7, ph = (t + seed * 0.37) % period;
    return ph < 0.06 ? 1 - ph / 0.06 : ph < 0.13 ? (ph - 0.06) / 0.07 : 1;
  }

  /** Eyes that look at a point (pupil offset, clamped inside the eye). */
  function look([ex, ey], [tx, ty], r) {
    const dx = tx - ex, dy = ty - ey, d = Math.hypot(dx, dy) || 1, k = Math.min(r, d * 0.15) / d;
    return [ex + dx * k, ey + dy * k];
  }

  /** Mouth path for openness 0..1 (0 = smile line, 1 = wide "O"). */
  function mouth(cx, cy, w, open, smile = 1) {
    if (open < 0.08) return `M${cx - w / 2},${cy} Q${cx},${cy + w * 0.35 * smile} ${cx + w / 2},${cy}`;
    const h = w * 0.15 + w * 0.55 * open;
    return `M${cx - w / 2},${cy} Q${cx},${cy - h * 0.25} ${cx + w / 2},${cy} Q${cx},${cy + h * 1.2} ${cx - w / 2},${cy} Z`;
  }

  /** Hand-drawn line boil: tiny stepped wobble for a path's points. Use with Film.step(t). */
  const boil = (t, seed, amp = 1.6) => [noise(Math.floor(t * 12) * 1.7, seed) * amp, noise(Math.floor(t * 12) * 1.3, seed + 9) * amp];

  /** Overlapping action: a value that follows a target with lag + overshoot (springy secondary motion). */
  function follow(t, key, { freq = 3.2, damp = 4.5 } = {}) {
    // key(t) gives the driver value; returns the lagged follower without simulation (closed-form delay + ring)
    const lag = 0.09, base = key(t - lag), ring = (key(t) - key(t - 0.05)) * Math.exp(-damp * 0.05) * Math.sin(freq);
    return base + ring * 0.4;
  }

  window.Rig = { hose, walk, idle, jump, squash, blink, look, mouth, boil, follow };
})();
