// Shared runtime for every style engine. Contract with the renderer:
//   window.DUR            total seconds
//   window.__ready        promise, resolves when assets/fonts are loaded
//   window.render(t)      draws frame at time t (may return a promise)
// Everything visible must be a pure function of t: no timers, no CSS transitions, no state carried between frames.
(function () {
  const S = window.SPEC;
  const W = S.W, H = S.H;

  // ---------- maths ----------
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const inv = (a, b, x) => clamp((x - a) / (b - a));
  const E = {
    linear: p => p,
    outCubic: p => 1 - Math.pow(1 - p, 3),
    inCubic: p => p * p * p,
    inOutCubic: p => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
    outExpo: p => (p >= 1 ? 1 : 1 - Math.pow(2, -10 * p)),
    inExpo: p => (p <= 0 ? 0 : Math.pow(2, 10 * p - 10)),
    inOutExpo: p => (p <= 0 ? 0 : p >= 1 ? 1 : p < 0.5 ? Math.pow(2, 20 * p - 10) / 2 : (2 - Math.pow(2, -20 * p + 10)) / 2),
    outBack: (p, s = 1.70158) => 1 + (s + 1) * Math.pow(p - 1, 3) + s * Math.pow(p - 1, 2),
    outQuint: p => 1 - Math.pow(1 - p, 5),
  };
  // Closed-form damped spring from 0 → 1 (time in seconds since start). Overshoots for zeta < 1.
  function spring(t, { freq = 2.2, zeta = 0.55 } = {}) {
    if (t <= 0) return 0;
    const w = 2 * Math.PI * freq;
    if (zeta >= 1) return 1 - (1 + w * t) * Math.exp(-w * t);
    const wd = w * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * w * t) * (Math.cos(wd * t) + (zeta * w / wd) * Math.sin(wd * t));
  }
  // deterministic randomness
  function rng(seed) {
    let a = (seed >>> 0) || 1;
    return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const hash = (...n) => { let h = 2166136261; for (const x of n) { h ^= Math.floor(x * 1000) | 0; h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
  const noise1 = (x, seed = 0) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return lerp(hash(i, seed), hash(i + 1, seed), u) * 2 - 1; };

  // ---------- timeline ----------
  const scenes = S.scenes;
  function sceneAt(t) {
    let i = scenes.findIndex(s => t < s.end);
    if (i < 0) i = scenes.length - 1;
    const s = scenes[i];
    return { i, s, local: t - s.start, dur: s.end - s.start, p: inv(s.start, s.end, t) };
  }
  // visibility window for scene i with overlap for transitions: returns {in: 0..1, out: 0..1, local}
  function phase(i, t, tin = 0.45, tout = 0.35) {
    const s = scenes[i];
    return { local: t - s.start, in: inv(s.start - 0.05, s.start + tin, t), out: inv(s.end - tout * 0.4, s.end + tout * 0.6, t), active: t >= s.start - 0.4 && t <= s.end + 0.5, dur: s.end - s.start };
  }

  // ---------- captions ----------
  // Group spoken words into short chunks (≤ maxWords, break on punctuation/pauses).
  function buildChunks(words, maxWords = 3, maxChars = 18) {
    const chunks = []; let cur = [];
    words.forEach((w, i) => {
      cur.push(i);
      const txt = cur.map(j => words[j].word).join(' ');
      const next = words[i + 1];
      const pause = next ? next.start - w.end > 0.22 : true;
      if (cur.length >= maxWords || txt.length >= maxChars || /[.,!?;:]$/.test(w.word) || pause) { chunks.push(cur); cur = []; }
    });
    if (cur.length) chunks.push(cur);
    return chunks.map(idx => ({ idx, start: words[idx[0]].start, end: words[idx[idx.length - 1]].end }));
  }
  function chunkAt(chunks, t) {
    for (let k = 0; k < chunks.length; k++) {
      const c = chunks[k], nextStart = chunks[k + 1] ? chunks[k + 1].start : Infinity;
      if (t >= c.start - 0.06 && t < Math.min(nextStart - 0.02, c.end + 0.6)) return { k, c };
    }
    return null;
  }
  const isKey = w => /\d/.test(w) || (S.keywords || []).some(k => k.toLowerCase().split(/\s+/).includes(w.toLowerCase().replace(/[^a-z0-9]/gi, '')));

  // ---------- DOM ----------
  function el(tag, cls, parent, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    (parent || document.getElementById('stage')).appendChild(e);
    return e;
  }
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function loadImage(src) {
    return new Promise(res => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  }
  function fmtNum(v, target) {
    const dec = Math.abs(target) < 10 && target % 1 !== 0 ? 1 : 0;
    const yearish = Number.isInteger(target) && target >= 1000 && target <= 2100;
    return Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: !yearish });
  }

  // ---------- 3D wireframe (used by blueprint3d and kinetic) ----------
  function prim(part, seg = 24) {
    const [sx, sy, sz] = part.size || [0.4, 0.4, 0.4], edges = [];
    const ring = (y, rx, rz, n = seg) => { const pts = []; for (let k = 0; k <= n; k++) { const a = (k / n) * Math.PI * 2; pts.push([Math.cos(a) * rx, y, Math.sin(a) * rz]); } return pts; };
    const poly = pts => { for (let k = 0; k < pts.length - 1; k++) edges.push([pts[k], pts[k + 1]]); };
    switch (part.shape) {
      case 'box': {
        const x = sx / 2, y = sy / 2, z = sz / 2;
        const v = [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]];
        [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]].forEach(([a, b]) => edges.push([v[a], v[b]]));
        break;
      }
      case 'cylinder': {
        const top = ring(sy / 2, sx / 2, sz / 2), bot = ring(-sy / 2, sx / 2, sz / 2);
        poly(top); poly(bot); for (let k = 0; k < seg; k += seg / 6) edges.push([top[k], bot[k]]);
        break;
      }
      case 'cone': {
        const bot = ring(-sy / 2, sx / 2, sz / 2); poly(bot);
        for (let k = 0; k < seg; k += seg / 6) edges.push([bot[k], [0, sy / 2, 0]]);
        break;
      }
      case 'sphere': {
        for (let l = 1; l < 6; l++) { const a = (l / 6) * Math.PI; poly(ring(Math.cos(a) * sy / 2, Math.sin(a) * sx / 2, Math.sin(a) * sz / 2)); }
        for (let m = 0; m < 6; m++) { const b = (m / 6) * Math.PI, pts = []; for (let k = 0; k <= seg; k++) { const a = (k / seg) * Math.PI * 2; pts.push([Math.sin(a) * Math.cos(b) * sx / 2, Math.cos(a) * sy / 2, Math.sin(a) * Math.sin(b) * sz / 2]); } poly(pts); }
        break;
      }
      case 'torus': {
        const R = sx / 2, r = sy / 4;
        for (let m = 0; m < 4; m++) poly(ring((m % 2 ? 1 : -1) * (m < 2 ? r * 0.7 : 0), R + (m < 2 ? 0 : (m === 2 ? r : -r)), R + (m < 2 ? 0 : (m === 2 ? r : -r))));
        for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2, pts = []; for (let j = 0; j <= 12; j++) { const b = (j / 12) * Math.PI * 2; pts.push([Math.cos(a) * (R + Math.cos(b) * r), Math.sin(b) * r, Math.sin(a) * (R + Math.cos(b) * r)]); } poly(pts); }
        break;
      }
      case 'gear': {
        const teeth = 12, R = sx / 2, r = R * 0.8, h = sy / 2, pts = [];
        for (let k = 0; k <= teeth * 4; k++) { const a = (k / (teeth * 4)) * Math.PI * 2, rr = (k % 4 < 2) ? R : r; pts.push([Math.cos(a) * rr, 0, Math.sin(a) * rr]); }
        const up = pts.map(p => [p[0], h, p[2]]), dn = pts.map(p => [p[0], -h, p[2]]);
        poly(up); poly(dn); for (let k = 0; k < pts.length; k += 2) edges.push([up[k], dn[k]]);
        poly(ring(h, r * 0.3, r * 0.3, 16)); poly(ring(-h, r * 0.3, r * 0.3, 16));
        break;
      }
      default: return prim({ ...part, shape: 'box' }, seg);
    }
    return edges;
  }
  // Project a model: returns per-part 2D segments + label anchors. cam: {yaw, pitch, dist, scale, cx, cy}
  function projectModel(parts, explode, cam) {
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const proj = ([x, y, z]) => {
      const x1 = x * cy - z * sy, z1 = x * sy + z * cy;
      const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
      const k = cam.dist / (cam.dist + z2);
      return [cam.cx + x1 * k * cam.scale, cam.cy - y2 * k * cam.scale, z2];
    };
    return parts.map(part => {
      const pos = part.pos || [0, 0, 0], ex = 1 + explode * 0.9;
      const off = [pos[0] * ex, pos[1] * ex, pos[2] * ex];
      const segs = (part._edges || (part._edges = prim(part))).map(([a, b]) => [proj([a[0] + off[0], a[1] + off[1], a[2] + off[2]]), proj([b[0] + off[0], b[1] + off[1], b[2] + off[2]])]);
      return { part, segs, anchor: proj(off) };
    });
  }

  window.FS = { S, W, H, clamp, lerp, inv, E, spring, rng, hash, noise1, scenes, sceneAt, phase, buildChunks, chunkAt, isKey, el, esc, loadImage, fmtNum, projectModel };
})();
