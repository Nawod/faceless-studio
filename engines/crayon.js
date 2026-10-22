// CRAYON — a picture-book page drawn live in wax crayon on toothy paper (style grammar after Lemo-Opuscar's crayon-book, MIT).
// Wax only sticks to the paper tooth, lines boil at 12 fps, fills are zig-zag hatching that overshoots, the camera trucks across one big page.
(function () {
  const { S, W, H, clamp, lerp, inv, E, rng, hash, noise1, el, buildChunks, chunkAt, scenes } = FS;
  const R = rng(S.seed * 7 + 3);
  const LINE = ['#2E2A5A', '#4A2E2A', '#4B2848'][S.seed % 3];
  const PAPER = '#F4EFE3', ACC = S.accent || '#E4572E';
  const BOX = [ACC, '#29A3D6', '#F2B134', '#5BA84F', '#C45AB3', '#E4572E'];
  const PAGE_STEP = 1180;

  const cv = el('canvas'); cv.width = W; cv.height = H; cv.style.cssText = 'position:absolute;inset:0';
  const ctx = cv.getContext('2d');
  const wax = document.createElement('canvas'); wax.width = W; wax.height = H; const L = wax.getContext('2d');

  // ---------- paper + tooth ----------
  const paper = document.createElement('canvas'); paper.width = W; paper.height = H;
  { const g = paper.getContext('2d'); g.fillStyle = PAPER; g.fillRect(0, 0, W, H);
    const id = g.getImageData(0, 0, W, H), d = id.data, r = rng(11);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4, n = (r() - 0.5) * 10 + Math.sin(y * 0.9 + noise1(x * 0.02, 3) * 3) * 2.5;
      d[i] += n; d[i + 1] += n; d[i + 2] += n - 1;
    }
    g.putImageData(id, 0, 0);
    const vg = g.createRadialGradient(W / 2, H * 0.45, H * 0.25, W / 2, H * 0.45, H * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(90,60,20,0.16)'); g.fillStyle = vg; g.fillRect(0, 0, W, H); }
  const tooth = document.createElement('canvas'); tooth.width = tooth.height = 384;
  { const g = tooth.getContext('2d'), id = g.createImageData(384, 384), r = rng(5);
    for (let k = 0; k < id.data.length; k += 4) { const p = (k / 4) % 384, q = Math.floor(k / 4 / 384); const v = r() * 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(p * 0.7 + Math.sin(q * 0.3) * 2)); id.data[k + 3] = v > 0.34 ? 255 : v * 300; }
    g.putImageData(id, 0, 0); }
  const toothPat = L.createPattern(tooth, 'repeat');

  // ---------- svg → sampled shapes ----------
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('viewBox', '0 0 400 400'); host.style.cssText = 'position:absolute;left:-9999px;width:400px;height:400px';
  document.body.appendChild(host);
  // Parse inner SVG into sampled crayon strokes. Keeps animation tags: data-anim on an element (or on a <g> around
  // several) moves those parts; the pivot is the bounding box of whatever carries the tag.
  function parseDrawing(svg) {
    if (!svg) return [];
    host.innerHTML = svg;
    const out = [], owners = new Map();
    const rootInv = host.getScreenCTM()?.inverse();
    const toUser = (e, x, y) => { const m = e.getScreenCTM(); if (!m || !rootInv) return [x, y]; const p = new DOMPoint(x, y).matrixTransform(m).matrixTransform(rootInv); return [p.x, p.y]; };
    host.querySelectorAll('path,circle,ellipse,rect,line,polygon,polyline').forEach(e => {
      let len = 0; try { len = e.getTotalLength(); } catch { return; }
      if (!(len > 0)) return;
      const n = Math.max(8, Math.ceil(len / 3)), pts = [];
      for (let k = 0; k <= n; k++) { const p = e.getPointAtLength((k / n) * len); pts.push(toUser(e, p.x, p.y)); }
      const tag = e.tagName.toLowerCase();
      const closed = ['circle', 'ellipse', 'rect', 'polygon'].includes(tag) || /z\s*$/i.test(e.getAttribute('d') || '');
      const fill = e.getAttribute('fill') || e.closest('[fill]')?.getAttribute('fill'), stroke = e.getAttribute('stroke') || e.closest('[stroke]')?.getAttribute('stroke');
      const sw = parseFloat(e.getAttribute('stroke-width') || e.closest('[stroke-width]')?.getAttribute('stroke-width')) || 4;
      let anim = null;
      const owner = e.closest('[data-anim]');
      if (owner && host.contains(owner)) {
        if (!owners.has(owner)) {
          const bb = owner.getBBox(), a = toUser(owner, bb.x, bb.y), b = toUser(owner, bb.x + bb.width, bb.y + bb.height);
          owners.set(owner, { type: owner.getAttribute('data-anim').trim().split(/\s+/)[0].toLowerCase(), x0: Math.min(a[0], b[0]), y0: Math.min(a[1], b[1]), x1: Math.max(a[0], b[0]), y1: Math.max(a[1], b[1]), phase: owners.size * 0.37 });
        }
        anim = owners.get(owner);
      }
      out.push({ pts, closed, anim, fill: fill && fill !== 'none' && !/^url/.test(fill) ? fill : null, stroke: stroke && stroke !== 'none' ? stroke : (fill && fill !== 'none' ? null : LINE), sw });
    });
    return out;
  }

  // ---------- motion: every move is a pure function of (stepped) time, applied to the sampled points ----------
  const TAU = Math.PI * 2;
  function motion(a, q) {
    if (!a) return null;
    const cx = (a.x0 + a.x1) / 2, cy = (a.y0 + a.y1) / 2, h = Math.max(20, a.y1 - a.y0), ph = a.phase;
    const rot = (ang, px, py) => (x, y) => { const c = Math.cos(ang), s = Math.sin(ang), dx = x - px, dy = y - py; return [px + dx * c - dy * s, py + dx * s + dy * c]; };
    const scl = (sx, sy, px, py) => (x, y) => [px + (x - px) * sx, py + (y - py) * sy];
    const mv = (dx, dy) => (x, y) => [x + dx, y + dy];
    switch (a.type) {
      case 'bob': return mv(0, Math.sin((q + ph) * TAU * 0.9) * h * 0.06);
      case 'float': return mv(Math.sin((q + ph) * TAU * 0.25) * 6, Math.sin((q + ph) * TAU * 0.4) * 12);
      case 'sway': return rot(Math.sin((q + ph) * TAU * 0.6) * 0.12, cx, a.y1);
      case 'wiggle': return rot(Math.sin((q + ph) * TAU * 2.2) * 0.09, cx, cy);
      case 'spin': return rot((q + ph) * TAU * 0.35, cx, cy);
      case 'pulse': { const s = 1 + 0.08 * Math.sin((q + ph) * TAU * 1.3); return scl(s, s, cx, cy); }
      case 'blink': return ((q + ph) % 3.1) < 0.16 ? scl(1, 0.12, cx, cy) : null;
      case 'walk': return mv(Math.sin((q + ph) * TAU * 0.3) * 34, -Math.abs(Math.sin((q + ph) * TAU * 1.5)) * 9);
      case 'shake': return mv((hash(Math.floor(q * 12), ph * 100) - 0.5) * 8, 0);
      case 'grow': { const s = E.outBack(clamp((q - 0.3) / 0.7), 2); return scl(s, s, cx, a.y1); }
      case 'orbit': return mv(Math.cos((q + ph) * TAU * 0.5) * 18, Math.sin((q + ph) * TAU * 0.5) * 18);
      case 'fall': { const d = ((q + ph) * 90) % 140; return mv(0, d); }
      default: return null;
    }
  }
  const moved = (pts, f) => (f ? pts.map(([x, y]) => f(x, y)) : pts);

  // ---------- crayon primitives (draw into L) ----------
  function crayonLine(pts, upto, color, width, seed, boil) {
    const n = Math.max(2, Math.floor(pts.length * upto)); if (upto <= 0) return;
    const passes = [[1, 0.9, 0], [0.55, 0.55, 1.6], [0.3, 0.7, -1.2]];
    L.strokeStyle = color; L.lineCap = 'round'; L.lineJoin = 'round';
    for (const [wm, a, off] of passes) {
      L.globalAlpha = a; L.lineWidth = width * wm;
      L.beginPath();
      for (let k = 0; k < n; k++) {
        const j = noise1(k * 0.15 + boil * 3.1, seed) * 1.3, jy = noise1(k * 0.15 + boil * 2.3, seed + 9) * 1.3;
        const x = pts[k][0] + j + off, y = pts[k][1] + jy + off * 0.5;
        k ? L.lineTo(x, y) : L.moveTo(x, y);
      }
      L.stroke();
    }
    L.globalAlpha = 1;
  }
  function hatch(pts, progress, color, seed, boil) {
    if (progress <= 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, cx = 0, cy = 0;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); cx += x; cy += y; }
    cx /= pts.length; cy /= pts.length;
    const clip = new Path2D(); pts.forEach(([x, y], k) => { const X = cx + (x - cx) * 1.05, Y = cy + (y - cy) * 1.05; k ? clip.lineTo(X, Y) : clip.moveTo(X, Y); }); clip.closePath();
    L.save(); L.clip(clip);
    L.strokeStyle = color; L.lineCap = 'round'; L.lineWidth = 7; L.globalAlpha = 0.85;
    const rows = Math.ceil((y1 - y0) / 6) + 2, shown = Math.ceil(rows * progress);
    L.beginPath();
    for (let r = 0; r < shown; r++) {
      const y = y0 - 3 + r * 6, dir = r % 2 ? 1 : -1;
      const ja = noise1(r * 0.7 + boil, seed) * 2;
      L.moveTo(dir > 0 ? x0 - 8 : x1 + 8, y + ja); L.lineTo(dir > 0 ? x1 + 8 : x0 - 8, y + 9 + ja);
    }
    L.stroke();
    if (progress > 0.7) { L.globalAlpha = 0.3 * inv(0.7, 1, progress); L.lineWidth = 5; L.beginPath(); for (let r = 0; r < rows; r += 2) { const x = x0 + r * 7; L.moveTo(x, y0 - 5); L.lineTo(x - 30, y1 + 5); } L.stroke(); }
    L.restore(); L.globalAlpha = 1;
  }
  function crayonText(text, x, y, size, color, reveal, seed, boil, align = 'center', font = 'Gaegu') {
    L.font = `700 ${size}px ${font}`; L.fillStyle = color; L.strokeStyle = color; L.textBaseline = 'alphabetic';
    L.lineWidth = Math.max(2, size * 0.055); L.lineJoin = 'round';
    const chars = [...text], widths = chars.map(c => L.measureText(c).width), total = widths.reduce((a, b) => a + b, 0);
    let x0 = align === 'center' ? x - total / 2 : x;
    const n = Math.floor(chars.length * reveal);
    for (let k = 0; k < n; k++) {
      const rot = noise1(k * 1.7 + boil * 2, seed) * 0.06, dy = noise1(k * 1.3 + boil, seed + 4) * size * 0.04;
      L.save(); L.translate(x0 + widths[k] / 2, y + dy); L.rotate(rot); L.fillText(chars[k], -widths[k] / 2, 0); L.strokeText(chars[k], -widths[k] / 2, 0); L.restore();
      x0 += widths[k];
    }
  }
  function wrap(text, size, maxW, font = 'Gaegu') {
    L.font = `700 ${size}px ${font}`; const words = String(text).split(/\s+/), lines = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (L.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else cur = t; }
    if (cur) lines.push(cur); return lines;
  }
  function washBlob(cx, cy, r, color, p, seed) {
    if (p <= 0) return;
    ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.globalAlpha = 0.09 * p;
    for (let k = 0; k < 3; k++) {
      const a = hash(seed, k) * Math.PI * 2, d = r * 0.18;
      const g = ctx.createRadialGradient(cx + Math.cos(a) * d, cy + Math.sin(a) * d, 0, cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * p * (0.8 + 0.25 * hash(k, seed)));
      g.addColorStop(0, color); g.addColorStop(0.85, color); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r * p, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  // ---------- scene content ----------
  const SUBJ = S.subject || {};
  const photos = {};
  const items = scenes.map((sc, i) => {
    let v = sc.visual || { kind: 'headline' };
    if (v.kind === 'image' && v.img) v = { ...v, kind: 'photo' };
    else if (['image', 'model3d', 'map'].includes(v.kind) || !v.kind) v = { ...v, kind: v.svg || SUBJ.svg ? 'drawing' : 'headline', svg: v.svg || SUBJ.svg, heading: v.heading || sc.narration.split(/\s+/).slice(0, 4).join(' ') };
    // text-only scenes still show the subject: its drawing sits above the words
    const withSubject = ['headline', 'quote'].includes(v.kind) && SUBJ.svg;
    // stats, lists, comparisons and icons also get a small animated drawing (the scene's own, else the subject)
    const mini = ['stat', 'list', 'timeline', 'compare', 'icons'].includes(v.kind) && (v.svg || SUBJ.svg);
    if (v.kind === 'photo') photos[i] = FS.loadImage(v.img).then(img => { photos[i] = img; });
    const washes = BOX.filter(c => c !== ACC);
    const src = v.kind === 'drawing' ? [v.svg, v.svg2] : (withSubject || mini) ? (v.svg ? [v.svg, v.svg2] : [SUBJ.svg, SUBJ.svg2]) : [];
    return { v, withSubject, mini, shapes: parseDrawing(src[0]), shapes2: parseDrawing(src[1]), wash: washes[(i + S.seed) % washes.length], seed: i * 13 + 1 };
  });

  // a real photo taped onto the page (drawn under the wax so crayon scribbles can frame it)
  function drawPhoto(i, local) {
    const img = photos[i]; if (!img || !img.width) return;
    const p = E.outBack(inv(0.05, 0.5, local), 1.6);
    const w = 760, h = 620, x = i * PAGE_STEP + W / 2, y = 640;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-0.04 + (1 - p) * 0.2); ctx.scale(p, p);
    ctx.fillStyle = '#fffdf6'; ctx.shadowColor = 'rgba(60,40,10,0.25)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8;
    ctx.fillRect(-w / 2 - 22, -h / 2 - 22, w + 44, h + 90); ctx.shadowColor = 'transparent';
    const s = Math.max(w / img.width, h / img.height), iw = img.width * s, ih = img.height * s;
    ctx.save(); ctx.beginPath(); ctx.rect(-w / 2, -h / 2, w, h); ctx.clip(); ctx.drawImage(img, -iw / 2, -ih / 2, iw, ih); ctx.restore();
    ctx.fillStyle = 'rgba(246,231,184,0.85)';
    [[-w / 2 + 20, -h / 2 - 30, -0.5], [w / 2 - 20, -h / 2 - 30, 0.5]].forEach(([tx, ty, r]) => { ctx.save(); ctx.translate(tx, ty); ctx.rotate(r); ctx.fillRect(-70, -18, 140, 36); ctx.restore(); });
    ctx.restore();
  }

  // Draw a picture: it is drawn on stroke by stroke, then comes alive — tagged parts move, and if there is a second
  // pose the two alternate on the beat (substitution animation, ~2.5 drawings a second). Motion steps at 12 fps.
  function drawShapes(shapes, shapes2, local, dur, seed, boil, x, y, scale) {
    if (!shapes.length) return;
    const n = shapes.length, per = Math.min(0.32, (Math.min(dur, 4) * 0.55) / Math.max(1, n));
    const drawnAt = 0.2 + (n - 1) * per * 0.8 + per + 0.4;
    const q = Math.floor(local * 12) / 12;
    const alive = local > drawnAt;
    const pose = alive && shapes2.length && Math.floor((q - drawnAt) * 2.5) % 2 ? shapes2 : shapes;
    const anyAnim = pose.some(s => s.anim) || shapes2.length;
    // a drawing with no tagged parts still breathes
    const breath = anyAnim ? 0 : Math.sin(q * TAU * 0.7) * 5;
    L.save(); L.translate(x, y + (alive ? breath : 0)); L.scale(scale, scale);
    pose.forEach((s, k) => {
      const t0 = 0.2 + k * per * 0.8;
      const pLine = alive ? 1 : E.inOutCubic(inv(t0, t0 + per, local)), pFill = alive ? 1 : inv(t0 + per * 0.6, t0 + per * 0.6 + 0.5, local);
      const f = alive ? motion(s.anim, q - drawnAt) : null;
      const pts = moved(s.pts, f);
      if (s.fill && s.closed) hatch(pts, pFill, s.fill, seed + k, boil);
      if (s.stroke) crayonLine(pts, pLine, s.stroke, Math.max(3.2, s.sw * 0.85), seed + k, boil);
      else if (s.fill && !s.closed) crayonLine(pts, pLine, s.fill, Math.max(3.2, s.sw * 0.85), seed + k, boil);
    });
    L.restore();
  }

  function drawScene(i, local, dur, boil) {
    const { v, shapes, shapes2, seed, withSubject, mini } = items[i];
    const ox = i * PAGE_STEP;
    L.save(); L.translate(ox, 0);
    if (mini) {                                   // small animated drawing at the top, the rest shifts down
      drawShapes(shapes, shapes2, local, dur, seed + 50, boil, W / 2 - 150, 120, 0.75);
      L.translate(0, 110);
    }
    const head = v.heading && v.kind !== 'quote' ? v.heading : null;
    if (v.kind === 'photo') {
      if (head) crayonText(head, W / 2, 1170, 84, LINE, clamp((local - 0.4) / 0.8), seed, boil);
      // crayon scribble frame around the taped photo (stays above the heading)
      const fr = []; for (let k = 0; k <= 60; k++) { const a = (k / 60) * Math.PI * 2; fr.push([W / 2 + Math.cos(a) * 505 + Math.sin(k) * 6, 660 + Math.sin(a) * 425]); }
      crayonLine(fr, E.inOutCubic(inv(0.5, 1.4, local)), ACC, 8, seed, boil);
    } else if (withSubject) {
      drawShapes(shapes, shapes2, local, dur, seed, boil, W / 2 - 220, 230, 1.1);
      const txt = v.kind === 'quote' ? `“${v.heading || ''}”` : (v.heading || '');
      const size = txt.length > 30 ? 92 : 120;
      wrap(txt, size, 900).forEach((ln, k) => crayonText(ln, W / 2, 860 + k * size * 1.05, size, k === 0 ? ACC : LINE, clamp((local - 0.6) * 14 / ln.length), seed + k, boil));
    } else if (v.kind === 'drawing') {
      if (head) {
        const hs = head.length > 26 ? 76 : 92;
        wrap(head, hs, 960).slice(0, 2).forEach((ln, k) => crayonText(ln, W / 2, 250 + k * hs * 1.05, hs, k === 0 && /\d/.test(head) ? ACC : LINE, clamp(local / 0.9), seed + k, boil));
      }
      drawShapes(shapes, shapes2, local, dur, seed, boil, W / 2 - 380, 340, 1.9);
    } else if (v.kind === 'stat') {
      const target = Number(v.value) || 0, p = E.outExpo(inv(0.2, 1.6, local));
      const full = `${v.prefix || ''}${FS.fmtNum(target, target)}${v.suffix || ''}`;
      const size = Math.min(300, Math.floor(1500 / Math.max(3, full.length)));      // always fits the page
      crayonText(`${v.prefix || ''}${FS.fmtNum(target * p, target)}${v.suffix || ''}`, W / 2, 760, size, ACC, 1, seed, boil);
      wrap(v.label || '', 84, 860).forEach((ln, k) => crayonText(ln, W / 2, 920 + k * 92, 84, LINE, clamp((local - 0.8) / 0.8), seed + k, boil));
      // a scribbled circle around the number
      const ring = []; for (let k = 0; k <= 80; k++) { const a = -0.6 + (k / 80) * Math.PI * 2.15; ring.push([W / 2 + Math.cos(a) * 390, 660 + Math.sin(a) * 210]); }
      crayonLine(ring, E.inOutCubic(inv(1.2, 2, local)), LINE, 7, seed, boil);
    } else if (v.kind === 'list' || v.kind === 'timeline') {
      if (v.heading) crayonText(v.heading, W / 2, 360, 96, LINE, clamp(local / 0.8), seed, boil);
      const its = (v.items || []).slice(0, 4), step = Math.max(0.5, (dur - 0.8) / Math.max(1, its.length));
      its.forEach((txt, k) => {
        const p = inv(0.3 + k * step, 0.3 + k * step + 0.7, local), y = 520 + k * 170;
        const dot = []; for (let m = 0; m <= 30; m++) { const a = (m / 30) * Math.PI * 2.1; dot.push([150 + Math.cos(a) * 26, y - 28 + Math.sin(a) * 26]); }
        crayonLine(dot, clamp(p * 2), BOX[k % BOX.length], 9, seed + k, boil);
        crayonText(txt, 210, y, 76, LINE, clamp(p * 1.3), seed + k, boil, 'left');
      });
    } else if (v.kind === 'icons') {
      if (v.heading) crayonText(v.heading, W / 2, 380, 96, LINE, clamp(local / 0.8), seed, boil);
      const em = (v.emoji || []).slice(0, 6);
      em.forEach((e, k) => {
        const p = E.outBack(inv(0.3 + k * 0.25, 0.7 + k * 0.25, local), 2);
        const cols = Math.min(3, em.length), x = W / 2 + ((k % cols) - (cols - 1) / 2) * 290, y = 640 + Math.floor(k / cols) * 300;
        L.save(); L.translate(x, y); L.rotate(noise1(k + boil, seed) * 0.08); L.scale(p, p);
        L.font = '190px serif'; L.textAlign = 'center'; L.textBaseline = 'middle'; L.fillText(e, 0, 0); L.restore();
      });
      L.textAlign = 'start';
    } else if (v.kind === 'compare') {
      if (v.heading) crayonText(v.heading, W / 2, 360, 92, LINE, clamp(local / 0.8), seed, boil);
      crayonText(v.left || '', W / 2, 620, 110, BOX[1], clamp((local - 0.3) / 0.6), seed, boil);
      crayonText('vs', W / 2, 790, 120, ACC, clamp((local - 0.9) / 0.3), seed + 1, boil);
      crayonText(v.right || '', W / 2, 980, 110, BOX[3], clamp((local - 1.2) / 0.6), seed + 2, boil);
    } else {
      const txt = v.kind === 'quote' ? `“${v.heading || ''}”` : (v.heading || '');
      const size = txt.length > 40 ? 112 : txt.length > 22 ? 140 : 180;
      const lines = wrap(txt, size, 900), total = lines.join('').length;
      let shown = 0;
      lines.forEach((ln, k) => {
        const rv = clamp((local * 14 - shown) / ln.length);
        crayonText(ln, W / 2, 700 - (lines.length - 1) * size * 0.55 + k * size * 1.08, size, k === 0 ? ACC : LINE, rv, seed + k, boil);
        shown += ln.length;
      });
      if (v.kind === 'quote' && v.label) crayonText('— ' + v.label, W / 2, 760 + lines.length * size * 0.6, 64, LINE, clamp((local * 14 - total) / 12), seed + 9, boil, 'center', 'Patrick Hand');
      // underline squiggle
      const sq = []; for (let k = 0; k <= 60; k++) sq.push([W / 2 - 300 + k * 10, 760 + lines.length * size * 0.32 + Math.sin(k * 0.9) * 10]);
      if (v.kind !== 'quote') crayonLine(sq, E.inOutCubic(inv(total / 14, total / 14 + 0.6, local)), ACC, 8, seed + 5, boil);
    }
    L.restore();
  }

  // ---------- captions (the book's printed words) ----------
  const chunks = buildChunks(S.words, 3, 19);
  function captions(t, boil) {
    const hit = chunkAt(chunks, t); if (!hit) return;
    const ws = hit.c.idx.map(j => S.words[j]);
    const text = ws.map(w => w.word).join(' ');
    ctx.font = '400 86px "Patrick Hand"'; const tw = ctx.measureText(text).width;
    // ragged knock-out patch of blank paper
    ctx.save(); ctx.fillStyle = PAPER; ctx.globalAlpha = 0.93; ctx.beginPath();
    const x0 = W / 2 - tw / 2 - 40, x1 = W / 2 + tw / 2 + 40, y0 = 1258, y1 = 1372;
    for (let k = 0; k <= 20; k++) ctx.lineTo(lerp(x0, x1, k / 20), y0 + noise1(k, 3) * 7);
    for (let k = 20; k >= 0; k--) ctx.lineTo(lerp(x0, x1, k / 20), y1 + noise1(k, 8) * 7);
    ctx.fill(); ctx.restore();
    // words written as spoken
    let x = W / 2 - tw / 2;
    ctx.fillStyle = LINE; ctx.textBaseline = 'alphabetic';
    ws.forEach((w, k) => {
      const ww = ctx.measureText(w.word + ' ').width;
      if (t >= w.start - 0.05) {
        ctx.save(); ctx.translate(x, 1338 + noise1(k + boil, 2) * 2); ctx.rotate(noise1(k * 2 + boil, 5) * 0.03); ctx.fillText(w.word, 0, 0); ctx.restore();
        if (t >= w.start - 0.05 && t < w.end + 0.1) { ctx.strokeStyle = ACC; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(x, 1352); ctx.lineTo(x + ctx.measureText(w.word).width, 1354 + noise1(boil, k) * 3); ctx.stroke(); }
      }
      x += ww;
    });
  }

  window.DUR = S.duration;
  const photoLoads = Object.values(photos);
  window.__ready = document.fonts.ready.then(() => Promise.all([...['700 40px Gaegu', '400 40px "Patrick Hand"'].map(f => document.fonts.load(f)), ...photoLoads]));
  window.render = t => {
    const boil = Math.floor(t * 12);
    // camera: hold on the current scene, truck to the next across the transition
    const { i } = FS.sceneAt(t);
    const s = scenes[i];
    const into = i > 0 ? E.inOutCubic(inv(s.start - 0.15, s.start + 0.55, t)) : 1;
    const camX = lerp((i - 1) * PAGE_STEP, i * PAGE_STEP, into) + Math.sin(t * 0.4) * 6;
    const zoom = 1 + 0.03 * clamp((t - s.start) / Math.max(1, s.end - s.start));
    // paper
    const off = ((camX % W) + W) % W;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(paper, -off, 0); ctx.drawImage(paper, W - off, 0);
    // washes (watercolour under the wax), then wax
    L.setTransform(1, 0, 0, 1, 0, 0); L.clearRect(0, 0, W, H);
    const tf = (c) => { c.setTransform(zoom, 0, 0, zoom, (1 - zoom) * W / 2 - camX * zoom, (1 - zoom) * H * 0.4); };
    tf(ctx); tf(L);
    for (let k = Math.max(0, i - 1); k <= Math.min(scenes.length - 1, i + 1); k++) {
      const sc = scenes[k], local = t - sc.start;
      if (local < -0.2) continue;
      washBlob(k * PAGE_STEP + W / 2, 700, 430, items[k].wash, E.outCubic(inv(0.3, 1.6, local)), k + 3);
      if (items[k].v.kind === 'photo') drawPhoto(k, Math.max(0, local));
      drawScene(k, Math.max(0, local), sc.end - sc.start, boil);
    }
    // tooth: wax only where the paper peaks are
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalCompositeOperation = 'destination-in';
    L.save(); L.translate(-off, 0); L.fillStyle = toothPat; L.fillRect(off, 0, W, H); L.restore();
    L.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(wax, 0, 0);
    captions(t, boil);
  };
})();
