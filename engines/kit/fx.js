// FX — the reference-library effects as ready parts: iris reveals, colour cuts, halftone bursts, speed dashes,
// smoke puffs, starbursts, camera shake, bouncing letters. All are pure functions of film time (seek-safe).
(function () {
  const { tl, el, onFrame, rng, noise, clamp } = Film;
  const ease = { out: p => 1 - Math.pow(1 - p, 3), inOut: p => p < .5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2 };
  let uid = 0;

  // Circle iris: clip a group to a circle that grows (open) or shrinks (close). Returns the clip <circle>.
  // Fx.iris(svg, group, { cx, cy, t0, dur, from: 0, to: 1300, ease: 'expo.inOut' })
  function iris(svg, group, { cx = 540, cy = 760, t0 = 0, dur = 0.6, from = 0, to = 1300, ease: e = 'expo.inOut' } = {}) {
    const id = `iris${++uid}`;
    let defs = svg.querySelector('defs') || el('defs', {}, svg);
    const cp = el('clipPath', { id }, defs);
    const c = el('circle', { cx, cy, r: from }, cp);
    group.setAttribute('clip-path', `url(#${id})`);
    tl.fromTo(c, { attr: { r: from } }, { attr: { r: to }, duration: dur, ease: e, immediateRender: false }, t0);
    return c;
  }

  // Background colour that hard-cuts on action beats: Fx.colorCuts(svg, [[0, '#F4D35E'], [3.2, '#EE6352'], …])
  function colorCuts(svg, cuts, { x = 0, y = 0, w = Film.W, h = Film.H } = {}) {
    const r = el('rect', { x, y, width: w, height: h, fill: cuts[0][1] }, svg);
    onFrame(t => { let c = cuts[0][1]; for (const [ct, col] of cuts) if (t >= ct) c = col; r.setAttribute('fill', c); });
    return r;
  }

  // Halftone dot burst (pop-art): dots shrink with distance from the centre. Returns a <g>; animate its scale on Film.tl.
  function halftone(parent, { cx = 540, cy = 760, r = 420, dot = 22, color = '#111', density = 1 } = {}) {
    const g = el('g', { transform: `translate(${cx} ${cy})` }, parent);
    let html = '';
    for (let y = -r; y <= r; y += dot) for (let x = -r; x <= r; x += dot) {
      const d = Math.hypot(x, y) / r; if (d > 1) continue;
      const s = (1 - d) * dot * 0.48 * density; if (s < 1) continue;
      html += `<circle cx="${x + ((y / dot) % 2 ? dot / 2 : 0)}" cy="${y}" r="${s.toFixed(1)}"/>`;
    }
    g.innerHTML = html; g.setAttribute('fill', color);
    return g;
  }

  // Speed dashes streaming across the frame between t0 and t1. dir: 'left' | 'right' | 'up' | 'down'.
  function speedLines(parent, { t0 = 0, t1 = 2, dir = 'left', count = 14, color = '#fff', width = 8, speed = 2600, seed = 3, region = [200, 1300], opacity = 0.9 } = {}) {
    const g = el('g', { stroke: color, 'stroke-width': width, 'stroke-linecap': 'round', opacity }, parent);
    const r = rng(seed);
    const L = Array.from({ length: count }, () => ({ o: r(), p: region[0] + r() * (region[1] - region[0]), len: 80 + r() * 260, k: 0.6 + r() * 0.8, e: el('line', {}, g) }));
    const horiz = dir === 'left' || dir === 'right', sign = dir === 'left' || dir === 'up' ? -1 : 1, span = horiz ? Film.W + 600 : Film.H + 600;
    onFrame(t => {
      const on = t >= t0 && t <= t1; g.style.display = on ? '' : 'none'; if (!on) return;
      const fade = clamp((t - t0) / 0.15) * clamp((t1 - t) / 0.15);
      g.setAttribute('opacity', opacity * fade);
      for (const l of L) {
        let a = ((l.o * span + (t - t0) * speed * l.k) % span) - 300; if (sign < 0) a = span - 600 - a;
        const b = a - sign * l.len;
        if (horiz) { l.e.setAttribute('x1', a); l.e.setAttribute('x2', b); l.e.setAttribute('y1', l.p); l.e.setAttribute('y2', l.p); }
        else { l.e.setAttribute('y1', a); l.e.setAttribute('y2', b); l.e.setAttribute('x1', l.p); l.e.setAttribute('x2', l.p); }
      }
    });
    return g;
  }

  // Smoke / dust puff: a cluster of circles that bloom, drift and fade (tank smoke, landing dust, steam).
  function puff(parent, { x = 540, y = 900, t0 = 0, dur = 1.2, n = 7, size = 70, color = '#E9E4DA', drift = [60, -90], seed = 1, spread = 90 } = {}) {
    const g = el('g', { fill: color }, parent), r = rng(seed);
    const P = Array.from({ length: n }, () => ({ dx: (r() - .5) * spread, dy: (r() - .5) * spread * .6, s: .6 + r() * .7, d: r() * .25, e: el('circle', { r: 0 }, g) }));
    onFrame(t => {
      const p = (t - t0) / dur; g.style.display = p < 0 || p > 1 ? 'none' : ''; if (p < 0 || p > 1) return;
      for (const c of P) {
        const q = clamp((p - c.d) / (1 - c.d)), grow = ease.out(clamp(q * 2.2));
        c.e.setAttribute('cx', x + c.dx * (0.4 + q) + drift[0] * q); c.e.setAttribute('cy', y + c.dy * (0.4 + q) + drift[1] * q);
        c.e.setAttribute('r', size * c.s * grow * (1 - Math.pow(q, 4)));
      }
      g.setAttribute('opacity', 1 - Math.pow(clamp(p), 3));
    });
    return g;
  }

  // Starburst flash (muzzle flash, impact, idea!): spikes that shoot out and retract.
  function starburst(parent, { x = 540, y = 760, t0 = 0, dur = 0.35, points = 10, r1 = 60, r2 = 260, color = '#FFF1A6', core = '#fff', seed = 2 } = {}) {
    const g = el('g', { transform: `translate(${x} ${y})` }, parent), r = rng(seed);
    const spikes = el('path', { fill: color }, g), c = el('circle', { r: 0, fill: core }, g);
    const lens = Array.from({ length: points * 2 }, (_, k) => k % 2 ? 0.35 + r() * 0.2 : 0.75 + r() * 0.5);
    onFrame(t => {
      const p = (t - t0) / dur; g.style.display = p < 0 || p > 1 ? 'none' : ''; if (p < 0 || p > 1) return;
      const s = Math.sin(Math.PI * Math.min(1, p * 1.4)) ** 0.7;
      const d = lens.map((L, k) => { const a = (k / lens.length) * Math.PI * 2 + 0.2; const R = k % 2 ? r1 * s * L * 2 : r2 * s * L; return `${(Math.cos(a) * R).toFixed(1)},${(Math.sin(a) * R).toFixed(1)}`; });
      spikes.setAttribute('d', `M${d.join(' L')} Z`); c.setAttribute('r', r1 * s);
    });
    return g;
  }

  // Camera shake on an element (an SVG <g> or HTML element) for a moment: deterministic, decaying.
  function shake(target, { t0 = 0, dur = 0.4, amp = 18, freq = 28, seed = 5 } = {}) {
    const base = target.getAttribute?.('transform') || '';
    onFrame(t => {
      const p = (t - t0) / dur;
      if (p < 0 || p > 1) { if (target.__shook) { target.setAttribute('transform', base); target.__shook = false; } return; }
      const k = amp * (1 - p) ** 2, dx = noise(t * freq, seed) * k, dy = noise(t * freq, seed + 9) * k;
      target.setAttribute('transform', `${base} translate(${dx.toFixed(1)} ${dy.toFixed(1)})`); target.__shook = true;
    });
  }

  // Letters as physical objects: each letter drops in from above and bounces into place (kinetic type that lands).
  // Returns an array of <text> elements (one per letter) so you can animate them further (juggle, scatter, become props).
  function letters(parent, text, { x = 540, y = 700, size = 170, font = 'Archivo Black', color = '#E8582C', t0 = 0, each = 0.06, from, spacing = 0.74, rotate = 14, seed = 4 } = {}) {
    const r = rng(seed), chars = [...text], w = chars.length * size * spacing;
    from ??= -(y + size * 1.5);   // start fully above the frame
    return chars.map((ch, k) => {
      const e = el('text', { x: x - w / 2 + (k + .5) * size * spacing, y, 'text-anchor': 'middle', 'font-family': font, 'font-size': size, fill: color }, parent);
      e.textContent = ch;
      const rot = (r() - .5) * 2 * rotate;
      tl.fromTo(e, { y: from, rotation: rot * 3, transformOrigin: '50% 80%' }, { y: 0, rotation: rot * 0.25, duration: 0.7, ease: 'bounce.out', immediateRender: true }, t0 + k * each);
      return e;
    });
  }

  window.Fx = { iris, colorCuts, halftone, speedLines, puff, starburst, shake, letters };
})();
