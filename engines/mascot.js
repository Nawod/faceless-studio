// MASCOT — the channel's cartoon Earth hosts the video: lip-synced to the narration, eyes track the fact cards,
// sticker-style cards with thick outlines, sunburst backgrounds, glitch cuts ("Earth has bugs").
(function () {
  const { S, W, H, clamp, lerp, inv, E, spring, hash, noise1, el, esc, fmtNum, buildChunks, chunkAt, isKey, projectModel, scenes, phase } = FS;
  const ACC = S.accent || '#FF5A36', INK = '#17171c';
  const SKIES = [['#7EC8FF', '#3D8BFF'], ['#FFD86B', '#FF9E3D'], ['#B9F27C', '#3CC47C'], ['#FF9EC7', '#FF5DA2'], ['#C6B5FF', '#7B5CFF'], ['#7DF0E0', '#22B8C9']];
  document.head.insertAdjacentHTML('beforeend', `<style>
    #stage{font-family:Inter,sans-serif;color:${INK}}
    #bgc,#fg{position:absolute;inset:0}
    .scene{position:absolute;inset:0}
    .area{position:absolute;left:70px;right:70px;top:230px;height:640px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .stk{color:#fff;-webkit-text-stroke:12px ${INK};paint-order:stroke fill;filter:drop-shadow(0 8px 0 ${INK}33)}
    .stk svg, .stk canvas{-webkit-text-stroke:0}
    .big{font-weight:900;line-height:.95;letter-spacing:-.03em;color:#fff;-webkit-text-stroke:16px ${INK};paint-order:stroke fill;text-transform:uppercase}
    .big .em{color:${ACC}}
    .num{font-weight:900;font-size:230px;line-height:1;color:#fff;-webkit-text-stroke:18px ${INK};paint-order:stroke fill;letter-spacing:-.04em}
    .lab{font-weight:900;font-size:64px;padding:8px 20px;margin-top:22px}
    .pill{display:flex;align-items:center;gap:22px;font-weight:900;font-size:64px;padding:8px 20px;margin:6px 0;width:860px;text-align:left}
    .pill b{flex:none;width:72px;height:72px;border-radius:50%;background:${ACC};color:#fff;border:5px solid ${INK};display:flex;align-items:center;justify-content:center;font-size:38px}
    .emo{-webkit-text-stroke:0;filter:drop-shadow(0 10px 12px #0004);display:inline-flex;align-items:center;justify-content:center;width:200px;height:200px;font-size:120px;margin:12px;border-radius:50%}
    .photo{padding:18px 18px 70px;border-radius:12px;background:#fff;border:7px solid ${INK};box-shadow:0 14px 0 ${INK}}
    .photo img{display:block;width:620px;height:560px;object-fit:cover;border-radius:4px}
    .bubble{position:relative;font-weight:800;font-size:66px;line-height:1.08;padding:44px 50px;max-width:860px;background:#fff;color:${INK};-webkit-text-stroke:0;border:7px solid ${INK};border-radius:70px;filter:none}
    .bubble:after{content:'';position:absolute;left:110px;bottom:-62px;border:30px solid transparent;border-top:42px solid ${INK}}
    .who{font-weight:700;font-size:44px;margin-top:44px;color:#fff;-webkit-text-stroke:8px ${INK};paint-order:stroke fill}
    .vs{font-weight:900;font-size:120px;color:${ACC};-webkit-text-stroke:14px ${INK};paint-order:stroke fill;margin:0 16px}
    .side{width:360px;height:420px;display:flex;align-items:center;justify-content:center;font-weight:900;font-size:66px;line-height:1;padding:20px;box-sizing:border-box;text-transform:uppercase}
    #cap{position:absolute;left:50px;right:50px;top:1290px;text-align:center;font-weight:900;font-size:92px;line-height:1.02;color:#fff;-webkit-text-stroke:15px ${INK};paint-order:stroke fill;text-transform:uppercase;z-index:50}
    #cap span.on{color:${ACC}}
  </style>`);
  const bgc = el('canvas'); bgc.id = 'bgc'; bgc.width = W; bgc.height = H; const bg = bgc.getContext('2d');
  const sceneRoots = [];
  const fg = el('canvas'); fg.id = 'fg'; fg.width = W; fg.height = H; const g = fg.getContext('2d'); fg.style.zIndex = '20';

  // ---------- visual kinds (DOM, sticker style) ----------
  const KINDS = {
    headline(a, v) {
      const words = (v.heading || '').split(/\s+/).filter(Boolean), longest = Math.max(...words.map(w => w.length), 4);
      const d = el('div', 'big', a); d.style.fontSize = Math.min(190, Math.floor(900 / (longest * 0.66))) + 'px';
      const em = (v.emphasis || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const sp = words.map(w => { const s = el('span', w.toLowerCase().replace(/[^a-z0-9]/g, '') === em ? 'em' : '', d, esc(w)); s.style.display = 'inline-block'; s.style.margin = '0 .12em'; return s; });
      return l => sp.forEach((s, k) => { const p = spring(l - 0.05 - k * 0.09, { freq: 2.6, zeta: 0.45 }); s.style.transform = `scale(${p}) rotate(${(1 - p) * (k % 2 ? 12 : -12)}deg)`; });
    },
    stat(a, v, dur) {
      const n = el('div', 'num', a), lab = el('div', 'lab stk', a, esc(v.label || ''));
      const target = Number(v.value) || 0, T = Math.min(1.7, dur * 0.5);
      return l => { const p = E.outExpo(inv(0.15, 0.15 + T, l)); n.textContent = `${v.prefix || ''}${fmtNum(target * p, target)}${v.suffix || ''}`;
        n.style.transform = `scale(${0.6 + 0.4 * spring(l, { freq: 2.2, zeta: 0.4 })}) rotate(${Math.sin(l * 2) * 2}deg)`; lab.style.transform = `translateY(${(1 - E.outBack(inv(0.5, 0.9, l))) * 300}px) rotate(-2deg)`; };
    },
    list(a, v, dur) {
      if (v.heading) el('div', 'big', a, esc(v.heading)).style.fontSize = '84px';
      const items = (v.items || []).slice(0, 4).map((t, k) => el('div', 'pill stk', a, `<b>${k + 1}</b><span>${esc(t)}</span>`));
      const step = Math.max(0.45, (dur - 0.8) / Math.max(1, items.length));
      return l => items.forEach((it, k) => { const p = spring(l - 0.3 - k * step, { freq: 2.4, zeta: 0.5 }); it.style.transform = `translateX(${(1 - p) * 1000}px) rotate(${(k % 2 ? 1 : -1) * 1.2}deg)`; });
    },
    compare(a, v) {
      if (v.heading) el('div', 'big', a, esc(v.heading)).style.fontSize = '80px';
      const row = el('div', '', a); row.style.cssText = 'display:flex;align-items:center;margin-top:30px';
      const L = el('div', 'side stk', row, esc(v.left || '')), vs = el('div', 'vs', row, 'VS'), R = el('div', 'side stk', row, esc(v.right || ''));
      R.style.color = ACC;
      return l => { L.style.transform = `translateY(${(1 - spring(l, { freq: 2, zeta: 0.5 })) * 900}px) rotate(-4deg)`; R.style.transform = `translateY(${(1 - spring(l - 0.2, { freq: 2, zeta: 0.5 })) * 900}px) rotate(4deg)`; vs.style.transform = `scale(${E.outBack(inv(0.5, 0.8, l), 3)})`; };
    },
    icons(a, v) {
      if (v.heading) el('div', 'big', a, esc(v.heading)).style.fontSize = '80px';
      const row = el('div', '', a); row.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:center;max-width:900px;margin-top:20px';
      const em = (v.emoji || []).slice(0, 6).map(e => el('div', 'emo stk', row, e));
      return l => em.forEach((e, k) => { const p = E.outBack(inv(0.2 + k * 0.13, 0.5 + k * 0.13, l), 2.6); e.style.transform = `scale(${p}) translateY(${Math.sin(l * 4 + k) * 8}px)`; });
    },
    // full-screen photo behind the host (no polaroid frame), slowly pushing in; heading floats on top
    image(a, v, dur, i = 0) {
      const scene = a.parentElement;
      const bg = el('div', '', scene); bg.style.cssText = 'position:absolute;inset:0;overflow:hidden';
      const img = el('img', '', bg); img.src = v.img; img.style.cssText = 'position:absolute;inset:-5%;width:110%;height:110%;object-fit:cover';
      const sh = el('div', '', bg); sh.style.cssText = 'position:absolute;inset:0;background:linear-gradient(#0006,#0000 30%,#0000 55%,#000a)';
      scene.insertBefore(bg, a);
      let c = null; if (v.heading) { c = el('div', 'big', a, esc(v.heading)); c.style.fontSize = '104px'; }
      return (l, d = 4) => {
        const p = clamp(l / d);
        img.style.transform = `scale(${1.04 + 0.14 * p}) translateX(${(i % 2 ? 1 : -1) * 40 * p}px)`;
        bg.style.clipPath = `circle(${E.outExpo(inv(0, 0.5, l)) * 120}% at 50% 60%)`;   // opens from the host like an iris
        if (c) c.style.transform = `scale(${spring(l - 0.2, { freq: 2.4, zeta: 0.45 })})`;
      };
    },
    drawing(a, v) {
      const c = el('div', '', a); c.innerHTML = `<svg viewBox="0 0 400 400" width="700" height="700">${v.svg || ''}</svg>`;
      const shapes = [...c.querySelectorAll('path,circle,ellipse,rect,line,polygon,polyline')];
      shapes.forEach(s => { s.setAttribute('pathLength', '1'); s.style.strokeDasharray = '1'; s.style.strokeDashoffset = '1'; s.style.fillOpacity = '0'; if (!s.getAttribute('stroke') || s.getAttribute('stroke') === 'none') s.setAttribute('stroke', INK); s.setAttribute('stroke-width', Math.max(5, +s.getAttribute('stroke-width') || 5)); s.setAttribute('stroke-linecap', 'round'); });
      if (v.heading) el('div', 'lab stk', a, esc(v.heading));
      return l => { c.style.transform = `scale(${E.outBack(inv(0, 0.4, l))}) rotate(-2deg)`; shapes.forEach((s, k) => { s.style.strokeDashoffset = String(1 - E.inOutCubic(inv(0.2 + k * 0.1, 0.7 + k * 0.1, l))); s.style.fillOpacity = String(inv(0.5 + k * 0.1, 0.8 + k * 0.1, l)); }); };
    },
    timeline(a, v, dur) { return KINDS.list(a, { heading: v.heading, items: v.items }, dur); },
    quote(a, v) {
      const b = el('div', 'bubble stk', a, '“' + esc(v.heading || '') + '”'); const w = v.label ? el('div', 'who', a, '— ' + esc(v.label)) : null;
      return l => { b.style.transform = `scale(${E.outBack(inv(0, 0.4, l), 2)})`; if (w) w.style.opacity = String(inv(0.6, 0.9, l)); };
    },
    model3d(a, v) {
      if (v.heading) el('div', 'big', a, esc(v.heading)).style.fontSize = '76px';
      const c = el('canvas', 'stk', a); c.width = c.height = 600; c.style.marginTop = '20px'; const x = c.getContext('2d');
      return (l, dur) => { x.clearRect(0, 0, 600, 600); const pr = projectModel(v.parts || [], E.inOutCubic(inv(dur * 0.35, dur * 0.7, l)), { yaw: l * 0.6, pitch: 0.4, dist: 4, scale: 210, cx: 300, cy: 310 });
        x.lineWidth = 5; x.lineCap = 'round'; pr.forEach(({ part, segs }) => { x.strokeStyle = part.color || INK; x.beginPath(); segs.forEach(([p, q]) => { x.moveTo(p[0], p[1]); x.lineTo(q[0], q[1]); }); x.stroke(); }); };
    },
  };
  const built = scenes.map((sc, i) => {
    const root = el('div', 'scene'); root.style.zIndex = '10'; const a = el('div', 'area', root);
    let v = sc.visual || { kind: 'headline' };
    if (!KINDS[v.kind] || (v.kind === 'image' && !v.img)) v = { ...v, kind: 'headline', heading: v.heading || sc.narration.split(/\s+/).slice(0, 4).join(' ') };
    return { root, upd: KINDS[v.kind](a, v, sc.end - sc.start, i), v };
  });

  // ---------- the Earth mascot (vector redraw of the channel logo) ----------
  const LAND = [ // rough continent blobs in "globe longitude" units (0..2π) and latitude (-1..1)
    [[0.2, -0.55], [0.55, -0.7], [0.75, -0.35], [0.6, -0.1], [0.42, 0.05], [0.3, -0.2]],      // N. America
    [[0.55, 0.1], [0.75, 0.15], [0.8, 0.45], [0.66, 0.8], [0.56, 0.5]],                       // S. America
    [[1.35, -0.6], [1.75, -0.65], [1.8, -0.3], [1.6, -0.15], [1.4, -0.3]],                     // Europe
    [[1.4, -0.1], [1.75, -0.1], [1.85, 0.25], [1.65, 0.65], [1.5, 0.35]],                      // Africa
    [[1.8, -0.7], [2.6, -0.7], [2.75, -0.35], [2.4, -0.05], [2.0, -0.15]],                     // Asia
    [[2.55, 0.35], [2.85, 0.35], [2.9, 0.6], [2.6, 0.62]],                                      // Australia
  ];
  function drawEarth(cx, cy, R, t, mood, look, talk, squash) {
    g.save(); g.translate(cx, cy); g.scale(1 + squash, 1 - squash);
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.beginPath(); g.ellipse(0, R * 1.18, R * 0.85, R * 0.12, 0, 0, Math.PI * 2); g.fill();
    // ocean
    const oc = g.createRadialGradient(-R * 0.35, -R * 0.4, R * 0.1, 0, 0, R);
    oc.addColorStop(0, '#7CC4F5'); oc.addColorStop(1, '#2F7FD0');
    g.fillStyle = oc; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.fill();
    // land (rotating)
    g.save(); g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.clip();
    const rot = t * 0.25;
    g.fillStyle = '#7CCB5B';
    for (const blob of LAND) for (const wrap of [0, Math.PI * 2]) {
      g.beginPath();
      blob.forEach(([lon, lat], k) => {
        const a = lon + wrap - rot - Math.PI * 1.1;            // visible when a in (-π/2, π/2)
        const x = Math.sin(a) * Math.sqrt(1 - lat * lat) * R, y = lat * R;
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.closePath(); g.fill();
    }
    g.restore();
    // shine + outline
    g.fillStyle = 'rgba(255,255,255,0.35)'; g.beginPath(); g.ellipse(-R * 0.45, -R * 0.5, R * 0.18, R * 0.09, -0.7, 0, Math.PI * 2); g.fill();
    g.lineWidth = R * 0.055; g.strokeStyle = INK; g.beginPath(); g.arc(0, 0, R, 0, Math.PI * 2); g.stroke();
    // eyes
    const blink = (t % 3.7) < 0.12 ? 0.12 : 1;
    const wide = mood === 'surprised' ? 1.25 : 1;
    [[-0.32, -0.1], [0.28, -0.12]].forEach(([ex, ey], k) => {
      const er = R * 0.2 * wide;
      g.fillStyle = '#fff'; g.lineWidth = R * 0.035; g.strokeStyle = INK;
      g.beginPath(); g.ellipse(ex * R, ey * R, er, er * 1.1 * blink, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      if (blink > 0.5) { g.fillStyle = INK; g.beginPath(); g.arc(ex * R + look[0] * er * 0.42, ey * R + look[1] * er * 0.42, er * 0.52, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#fff'; g.beginPath(); g.arc(ex * R + look[0] * er * 0.42 - er * 0.18, ey * R + look[1] * er * 0.42 - er * 0.2, er * 0.14, 0, Math.PI * 2); g.fill(); }
      // brows
      g.lineWidth = R * 0.045; g.lineCap = 'round';
      const raise = mood === 'skeptical' && k === 1 ? -0.14 : mood === 'surprised' ? -0.12 : 0;
      const tilt = mood === 'skeptical' ? (k === 0 ? 0.08 : -0.05) : mood === 'happy' ? 0 : 0.03;
      g.beginPath(); g.moveTo((ex - 0.15) * R, (ey - 0.3 + raise + tilt) * R); g.quadraticCurveTo(ex * R, (ey - 0.37 + raise) * R, (ex + 0.15) * R, (ey - 0.3 + raise - tilt) * R); g.stroke();
    });
    // mouth: lip-sync from word timings
    const open = mood === 'surprised' ? Math.max(0.55, talk) : talk;
    g.fillStyle = '#5A1F2A'; g.strokeStyle = INK; g.lineWidth = R * 0.035;
    const mx = -0.02 * R, my = 0.32 * R, mw = R * (mood === 'happy' ? 0.3 : 0.22);
    g.beginPath();
    if (open < 0.08) { g.moveTo(mx - mw, my); g.quadraticCurveTo(mx, my + (mood === 'happy' ? R * 0.14 : mood === 'skeptical' ? -R * 0.03 : R * 0.05), mx + mw, my - (mood === 'skeptical' ? R * 0.04 : 0)); g.stroke(); }
    else { g.ellipse(mx, my, mw * (0.8 + 0.2 * open), R * 0.04 + R * 0.16 * open, 0, 0, Math.PI * 2); g.fill(); g.stroke();
      g.fillStyle = '#F07A8A'; g.beginPath(); g.ellipse(mx, my + R * 0.08 * open, mw * 0.5, R * 0.06 * open, 0, 0, Math.PI * 2); g.fill(); }
    // the logo's loading spinner = "a bug is happening"
    g.restore();
  }
  function spinner(cx, cy, r, t, alpha) {
    if (alpha <= 0) return;
    g.save(); g.translate(cx, cy); g.globalAlpha = alpha; g.lineCap = 'round'; g.lineWidth = r * 0.22;
    for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + Math.floor(t * 10) * (Math.PI / 4); g.strokeStyle = `rgba(40,90,140,${0.25 + 0.75 * (k / 8)})`; g.beginPath(); g.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55); g.lineTo(Math.cos(a) * r, Math.sin(a) * r); g.stroke(); }
    g.restore();
  }
  const moodOf = v => (v.kind === 'stat' ? 'surprised' : v.kind === 'quote' || v.kind === 'compare' ? 'skeptical' : v.kind === 'list' || v.kind === 'icons' ? 'happy' : 'neutral');
  // mascot placement per scene: big and central on the hook, small bottom-left host afterwards
  const place = i => (i === 0 || i === scenes.length - 1) ? { x: W / 2, y: 1075, r: 185 } : { x: 210 + (i % 2) * 660, y: 1120, r: 125 };

  function talkAt(t) {
    for (const w of S.words) { if (t < w.start) break; if (t <= w.end) { const p = (t - w.start) / Math.max(0.05, w.end - w.start); return clamp(Math.sin(p * Math.PI) * (0.6 + 0.4 * Math.sin(p * Math.PI * 3)) + 0.15); } }
    return 0;
  }
  function background(t, i) {
    const s = scenes[i], local = t - s.start;
    const [c0, c1] = SKIES[(i + S.seed) % SKIES.length];
    const lg = bg.createLinearGradient(0, 0, 0, H); lg.addColorStop(0, c0); lg.addColorStop(1, c1);
    bg.fillStyle = lg; bg.fillRect(0, 0, W, H);
    // sunburst
    bg.save(); bg.translate(W / 2, 560); bg.rotate(t * 0.12); bg.fillStyle = 'rgba(255,255,255,0.13)';
    for (let k = 0; k < 16; k++) { bg.beginPath(); bg.moveTo(0, 0); bg.arc(0, 0, 1700, (k / 16) * Math.PI * 2, (k / 16 + 1 / 32) * Math.PI * 2); bg.fill(); }
    bg.restore();
    // floating glitch pixels ("bugs")
    for (let k = 0; k < 14; k++) { const x = (hash(k, 1) * W + t * (20 + k * 3)) % W, y = (hash(k, 2) * H * 0.8 + Math.sin(t + k) * 30); bg.fillStyle = `rgba(255,255,255,${0.15 + hash(k, 3) * 0.25})`; const sz = 10 + hash(k, 4) * 22; bg.fillRect(x, y, sz, sz); }
  }
  function glitch(t, i) {
    const s = scenes[i]; const d = t - s.start; if (i === 0 || d < 0 || d > 0.22) return 0;
    const n = 9; for (let k = 0; k < n; k++) { const y = hash(Math.floor(t * 60), k) * H, h = 20 + hash(k, Math.floor(t * 60)) * 90; g.fillStyle = k % 3 === 0 ? 'rgba(255,43,214,0.55)' : k % 3 === 1 ? 'rgba(24,224,255,0.55)' : 'rgba(255,255,255,0.35)'; g.fillRect(0, y, W, h); }
    return 1 - d / 0.22;
  }

  const cap = el('div'); cap.id = 'cap';
  const chunks = buildChunks(S.words, 3, 16);

  window.DUR = S.duration;
  window.__ready = document.fonts.ready;
  window.render = t => {
    const { i } = FS.sceneAt(t);
    background(t, i);
    g.clearRect(0, 0, W, H);
    built.forEach(({ root, upd }, k) => {
      const ph = phase(k, t, 0.3, 0.25);
      const vis = t >= scenes[k].start - 0.02 && t < (scenes[k + 1] ? scenes[k + 1].start : Infinity);
      root.style.display = vis ? '' : 'none'; if (!vis) return;
      upd(Math.max(0, ph.local), ph.dur);
    });
    // mascot motion between placements
    const s = scenes[i], prev = place(Math.max(0, i - 1)), cur = place(i);
    const m = i === 0 ? 1 : spring(t - s.start, { freq: 1.6, zeta: 0.55 });
    const x = lerp(prev.x, cur.x, m), y = lerp(prev.y, cur.y, m), r = lerp(prev.r, cur.r, clamp(m));
    const bob = Math.sin(t * Math.PI * 1.6) * r * 0.05, squash = Math.sin(t * Math.PI * 3.2) * 0.015 + (1 - clamp(m)) * 0.06 * Math.sin((t - s.start) * 30);
    const lookT = i === 0 || i === scenes.length - 1 ? [Math.sin(t * 0.7) * 0.4, -0.2] : [x < W / 2 ? 0.55 : -0.55, -0.75];
    drawEarth(x, y + bob, r, t, moodOf(built[i].v), lookT, talkAt(t), squash);
    spinner(x + r * 1.15, y - r * 0.95 + bob, r * 0.26, t, i === 0 ? 1 - inv(1.2, 1.6, t) : 0);
    const gl = glitch(t, i);
    document.getElementById('stage').style.filter = gl > 0 ? `hue-rotate(${gl * 90}deg) saturate(${1 + gl})` : 'none';
    built[i].root.style.transform = gl > 0 ? `translateX(${(hash(Math.floor(t * 60), 5) - 0.5) * 60 * gl}px)` : '';
    // captions
    const hit = chunkAt(chunks, t);
    if (!hit) cap.style.opacity = '0'; else {
      if (cap.dataset.k !== String(hit.k)) { cap.innerHTML = hit.c.idx.map(j => `<span>${esc(S.words[j].word)}</span>`).join(' '); cap.dataset.k = hit.k; }
      const sp = cap.children; hit.c.idx.forEach((j, q) => sp[q].classList.toggle('on', t >= S.words[j].start - 0.03 && t < S.words[j].end + 0.08));
      cap.style.opacity = '1'; cap.style.transform = `scale(${0.7 + 0.3 * E.outBack(inv(hit.c.start - 0.05, hit.c.start + 0.12, t), 2.5)})`;
    }
  };
})();
