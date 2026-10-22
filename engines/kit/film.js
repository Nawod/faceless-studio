// FILM KIT — runtime for bespoke, agent-authored films.  Read engines/kit/README.md for the full API.
// Contract with the renderer: window.DUR, window.__ready (Promise), window.render(t) — every frame is a pure function of t.
// Everything animated goes on ONE paused GSAP timeline (Film.tl) or in Film.onFrame callbacks, so any frame can be rendered
// in any order by parallel workers and always looks the same.
(function () {
  const S = window.SPEC;
  const W = S.W, H = S.H;
  const stage = () => document.getElementById('stage');   // the kit loads in <head>; #stage exists later

  // ---------- GSAP: one master timeline, never driven by the wall clock ----------
  const gs = window.gsap;
  ['MorphSVGPlugin', 'DrawSVGPlugin', 'MotionPathPlugin', 'CustomEase', 'Physics2DPlugin', 'SplitText'].forEach(p => { if (window[p]) gs.registerPlugin(window[p]); });
  gs.ticker.lagSmoothing(0);
  gs.globalTimeline.pause();                       // stray tweens can't run on real time
  const tl = gs.timeline({ paused: true, defaults: { ease: 'power3.out' } });

  // ---------- deterministic randomness + noise ----------
  function rng(seed = 1) { let a = (seed >>> 0) || 1; return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const hash = (...n) => { let h = 2166136261; for (const x of n) { h ^= Math.floor(x * 1000) | 0; h = Math.imul(h, 16777619); } return ((h >>> 0) % 100000) / 100000; };
  const noise = (x, seed = 0) => { const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f); return (hash(i, seed) * (1 - u) + hash(i + 1, seed) * u) * 2 - 1; };
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, p) => a + (b - a) * p;
  const inv = (a, b, x) => clamp((x - a) / (b - a));
  const step = (t, fps = 12) => Math.floor(t * fps) / fps;   // "on twos": hand-drawn cadence for boil / held poses

  // ---------- scenes, words, beats ----------
  const scenes = S.scenes;
  const at = (i, offset = 0) => Math.max(0, scenes[Math.min(i, scenes.length - 1)].start) + offset;   // absolute time of scene i (+offset)
  const sceneAt = t => { let i = scenes.findIndex(s => t < s.end); if (i < 0) i = scenes.length - 1; return { i, s: scenes[i], local: t - scenes[i].start }; };
  // the time a given word (by text, inside scene i) is spoken — for syncing hits to the voice
  function wordTime(i, text, fallback = 0.4) {
    const s = scenes[i], norm = w => w.toLowerCase().replace(/[^a-z0-9]/g, '');
    const w = S.words.find(w => w.start >= s.start - 0.05 && w.start < s.end && norm(w.word) === norm(text));
    return w ? w.start : at(i, fallback);
  }
  // 0..1 "is a word being spoken now" — for lip-sync
  function talk(t) {
    for (const w of S.words) { if (t < w.start) break; if (t <= w.end) { const p = (t - w.start) / Math.max(0.05, w.end - w.start); return clamp(Math.sin(p * Math.PI) * (0.6 + 0.4 * Math.sin(p * Math.PI * 3)) + 0.15); } }
    return 0;
  }

  // ---------- DOM / SVG helpers ----------
  const NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs = {}, parent, html) {
    if (parent === undefined) parent = stage();
    const e = /^(svg|g|path|circle|ellipse|rect|line|polyline|polygon|defs|clipPath|mask|linearGradient|radialGradient|stop|filter|feTurbulence|feDisplacementMap|feGaussianBlur|feColorMatrix|feComposite|feOffset|text|tspan|use|pattern|symbol)$/.test(tag)
      ? document.createElementNS(NS, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) { if (k === 'style' && typeof v === 'object') Object.assign(e.style, v); else if (k === 'class') e.setAttribute('class', v); else e.setAttribute(k, v); }
    if (html != null) e.innerHTML = html;
    if (parent) parent.appendChild(e);
    return e;
  }
  // a full-frame SVG layer (viewBox = 1080x1920), stacked in creation order
  function svgLayer(z = 1, attrs = {}) { return el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, style: { position: 'absolute', inset: '0', overflow: 'visible', zIndex: z }, ...attrs }); }
  // a full-frame canvas layer
  function canvasLayer(z = 1) { const c = el('canvas', { width: W, height: H, style: { position: 'absolute', inset: '0', zIndex: z } }); return c; }

  // ---------- per-frame callbacks (p5 / canvas / procedural) ----------
  const frameFns = [];
  const onFrame = fn => frameFns.push(fn);
  const readies = [document.fonts.ready];
  const ready = p => readies.push(p);

  // p5 in instance mode, redrawn on demand at film time t (no draw loop): Film.p5((p, t) => { ... }, z)
  function p5Layer(draw, z = 1, setup) {
    let inst, curT = 0;
    const holder = el('div', { style: { position: 'absolute', inset: '0', zIndex: z } });
    ready(new Promise(res => {
      inst = new window.p5(p => {
        p.setup = () => { p.createCanvas(W, H); p.pixelDensity(1); p.noLoop(); setup?.(p); res(); };
        p.draw = () => draw(p, curT);
      }, holder);
    }));
    onFrame(t => { curT = t; inst?.redraw(); });
    return holder;
  }

  // ---------- film grain + vignette (hand-made finish) ----------
  function grain({ opacity = 0.08, z = 900, fps = 12 } = {}) {
    const c = canvasLayer(z); c.width = W / 3; c.height = H / 3; c.style.width = W + 'px'; c.style.height = H + 'px';
    c.style.mixBlendMode = 'overlay'; c.style.opacity = opacity; c.style.pointerEvents = 'none';
    const g = c.getContext('2d'), img = g.createImageData(c.width, c.height);
    onFrame(t => { const r = rng(Math.floor(t * fps) + 7); for (let k = 0; k < img.data.length; k += 4) { const v = r() * 255; img.data[k] = img.data[k + 1] = img.data[k + 2] = v; img.data[k + 3] = 255; } g.putImageData(img, 0, 0); });
    return c;
  }
  function vignette({ strength = 0.35, z = 901, color = '0,0,0' } = {}) {
    return el('div', { style: { position: 'absolute', inset: '0', zIndex: z, pointerEvents: 'none', background: `radial-gradient(120% 90% at 50% 45%, rgba(${color},0) 55%, rgba(${color},${strength}) 100%)` } });
  }

  // ---------- captions: word-synced, several looks; or build your own from Film.words ----------
  const CAP_STYLES = {
    pop: { font: '900 92px Inter', color: '#fff', stroke: '#111', strokeW: 14, hi: '#FFD23F', upper: true },
    clean: { font: '800 76px Inter', color: '#111', stroke: '#ffffffcc', strokeW: 12, hi: '#FF5A36', upper: false },
    marker: { font: '400 96px "Permanent Marker", "Gaegu", cursive', color: '#fff', stroke: '#111', strokeW: 10, hi: '#7CFF6B', upper: true },
    hand: { font: '700 84px Gaegu, "Patrick Hand", cursive', color: '#2b2140', stroke: '#fffdf6', strokeW: 12, hi: '#E4572E', upper: false },
    mono: { font: '700 64px "Space Mono", monospace', color: '#fff', stroke: '#0b1020', strokeW: 10, hi: '#7FE7FF', upper: true },
    serif: { font: '400 88px "DM Serif Display", serif', color: '#fff', stroke: '#1a1a1a', strokeW: 12, hi: '#FFB800', upper: false },
  };
  function captions({ style = 'pop', y = 1290, maxWords = 3, maxChars = 18, z = 950, custom } = {}) {
    const st = { ...CAP_STYLES[style] || CAP_STYLES.pop, ...(custom || {}) };
    const box = el('div', { style: { position: 'absolute', left: '50px', right: '50px', top: y + 'px', textAlign: 'center', zIndex: z, font: st.font, lineHeight: '1.04', color: st.color, WebkitTextStroke: `${st.strokeW}px ${st.stroke}`, paintOrder: 'stroke fill', textTransform: st.upper ? 'uppercase' : 'none' } });
    box.id = 'cap';
    const words = S.words, chunks = []; let cur = [];
    words.forEach((w, i) => { cur.push(i); const txt = cur.map(j => words[j].word).join(' '); const nx = words[i + 1]; if (cur.length >= maxWords || txt.length >= maxChars || /[.,!?;:]$/.test(w.word) || !nx || nx.start - w.end > 0.22) { chunks.push(cur); cur = []; } });
    const C = chunks.map(idx => ({ idx, start: words[idx[0]].start, end: words[idx[idx.length - 1]].end }));
    let shown = -1;
    onFrame(t => {
      let k = -1; for (let j = 0; j < C.length; j++) { const nx = C[j + 1] ? C[j + 1].start : Infinity; if (t >= C[j].start - 0.06 && t < Math.min(nx - 0.02, C[j].end + 0.6)) { k = j; break; } }
      if (k < 0) { box.style.opacity = '0'; return; }
      if (k !== shown) { box.innerHTML = C[k].idx.map(j => `<span>${words[j].word.replace(/[<>&]/g, '')}</span>`).join(' '); shown = k; }
      [...box.children].forEach((sp, m) => { const w = words[C[k].idx[m]]; sp.style.color = t >= w.start - 0.03 && t < w.end + 0.08 ? st.hi : st.color; });
      const p = clamp((t - C[k].start + 0.06) / 0.16), s = 0.75 + 0.25 * (1 - Math.pow(1 - p, 3)) + 0.05 * Math.sin(p * Math.PI);
      box.style.opacity = '1'; box.style.transform = `scale(${s.toFixed(3)})`;
    });
    return box;
  }

  window.Film = {
    S, W, H, DUR: S.duration, scenes, words: S.words, subject: S.subject, palette: S.palette, title: S.title,
    tl, gsap: gs, at, sceneAt, wordTime, talk, onFrame, ready, el, svgLayer, canvasLayer, p5: p5Layer, grain, vignette, captions,
    rng, hash, noise, clamp, lerp, inv, step,
  };

  window.DUR = S.duration;
  // lazy: resolves only when everything added by later scripts (the film, brand layer…) is ready
  Object.defineProperty(window, '__ready', { configurable: true, get: () => Promise.all(readies), set: p => readies.push(p) });
  window.render = async t => {
    tl.seek(Math.max(0, t), false);
    for (const fn of frameFns) fn(t);
  };
})();
