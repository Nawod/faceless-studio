// BLUEPRINT3D — engineering blueprint: cyan linework on a deep-blue grid, rotating 3D wireframes that explode into labelled parts.
(function () {
  const { S, W, H, clamp, lerp, inv, E, rng, hash, noise1, el, fmtNum, buildChunks, chunkAt, projectModel, scenes } = FS;
  const CY = '#7FE7FF', CY2 = '#BFF4FF', WARN = '#FFD166', BG0 = '#0B2C63', BG1 = '#061A3D';
  const MONO = '"Space Mono", monospace';
  const cv = el('canvas'); cv.width = W; cv.height = H; cv.style.cssText = 'position:absolute;inset:0';
  const ctx = cv.getContext('2d');

  const bg = document.createElement('canvas'); bg.width = W; bg.height = H;
  { const g = bg.getContext('2d'); const lg = g.createLinearGradient(0, 0, 0, H); lg.addColorStop(0, BG0); lg.addColorStop(1, BG1); g.fillStyle = lg; g.fillRect(0, 0, W, H);
    const id = g.getImageData(0, 0, W, H), r = rng(3); for (let k = 0; k < id.data.length; k += 4) { const n = (r() - 0.5) * 8; id.data[k] += n; id.data[k + 1] += n; id.data[k + 2] += n; } g.putImageData(id, 0, 0);
    const vg = g.createRadialGradient(W / 2, H * 0.42, H * 0.2, W / 2, H * 0.42, H * 0.8); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.45)'); g.fillStyle = vg; g.fillRect(0, 0, W, H); }

  function grid(t) {
    const ox = (t * 6) % 40, oy = (t * 3) % 40;
    ctx.lineWidth = 1;
    for (let x = -40 + ox; x < W + 40; x += 40) { ctx.strokeStyle = Math.round((x - ox) / 40) % 5 === 0 ? 'rgba(127,231,255,0.16)' : 'rgba(127,231,255,0.06)'; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (let y = -40 + oy; y < H + 40; y += 40) { ctx.strokeStyle = Math.round((y - oy) / 40) % 5 === 0 ? 'rgba(127,231,255,0.16)' : 'rgba(127,231,255,0.06)'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
  }
  const glow = (on) => { ctx.shadowColor = on ? 'rgba(127,231,255,0.8)' : 'transparent'; ctx.shadowBlur = on ? 12 : 0; };
  function typed(text, x, y, size, color, p, align = 'center', weight = 700) {
    ctx.font = `${weight} ${size}px ${MONO}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    const n = Math.floor(text.length * clamp(p));
    ctx.fillText(text.slice(0, n) + (p > 0 && p < 1 ? '▌' : ''), x, y);
  }
  function wrap(text, size, maxW) { ctx.font = `700 ${size}px ${MONO}`; const out = []; let cur = ''; for (const w of String(text).split(/\s+/)) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > maxW && cur) { out.push(cur); cur = w; } else cur = t; } if (cur) out.push(cur); return out; }
  function frameBox(x, y, w, h, p = 1, color = CY) {
    ctx.strokeStyle = color; ctx.lineWidth = 3; const c = 26;
    ctx.beginPath(); const per = 2 * (w + h), len = per * clamp(p);
    // draw the rectangle progressively
    const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]; let left = len;
    ctx.moveTo(x, y);
    for (let k = 1; k < pts.length && left > 0; k++) { const [ax, ay] = pts[k - 1], [bx, by] = pts[k], seg = Math.hypot(bx - ax, by - ay), f = Math.min(1, left / seg); ctx.lineTo(ax + (bx - ax) * f, ay + (by - ay) * f); left -= seg; }
    ctx.stroke();
    if (p >= 1) { ctx.lineWidth = 6; [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]].forEach(([cx, cy, sx, sy]) => { ctx.beginPath(); ctx.moveTo(cx, cy + sy * c); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * c, cy); ctx.stroke(); }); }
  }
  function title(text, local) {
    const lines = wrap(String(text).toUpperCase(), 58, 820);
    const h = 40 + lines.length * 68;
    frameBox(110, 190, 860, h, E.outCubic(inv(0, 0.5, local)));
    lines.forEach((ln, k) => typed(ln, W / 2, 255 + k * 68, 58, CY2, (local - 0.3) * 30 / Math.max(1, ln.length) - k * 0.6));
  }
  function model(parts, local, dur, cy = 760, scale = 330) {
    if (!parts?.length) parts = [{ shape: 'gear', pos: [0, 0, 0], size: [1, 0.25, 1] }];
    const explode = E.inOutCubic(inv(dur * 0.35, dur * 0.65, local)), draw = E.outCubic(inv(0, 1.2, local));
    const proj = projectModel(parts, explode, { yaw: 0.5 + local * 0.5, pitch: 0.45, dist: 4.2, scale, cx: W / 2, cy });
    glow(true); ctx.lineCap = 'round';
    proj.forEach(({ part, segs }) => {
      ctx.strokeStyle = part.color && /^#/.test(part.color) ? mix(part.color) : CY; ctx.lineWidth = 2.6;
      ctx.beginPath(); const n = Math.ceil(segs.length * draw);
      for (let j = 0; j < n; j++) { const [a, b] = segs[j]; ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
      ctx.stroke();
    });
    glow(false);
    proj.forEach(({ part, anchor }, k) => {
      const lp = inv(dur * 0.5 + k * 0.15, dur * 0.5 + k * 0.15 + 0.4, local);
      if (!part.label || lp <= 0) return;
      const right = anchor[0] >= W / 2, lx = right ? W - 70 : 70, ly = anchor[1] - 40 + (k % 2) * 30;
      ctx.strokeStyle = WARN; ctx.lineWidth = 2; ctx.globalAlpha = clamp(lp * 2);
      ctx.beginPath(); ctx.arc(anchor[0], anchor[1], 7, 0, Math.PI * 2); ctx.moveTo(anchor[0], anchor[1]); ctx.lineTo(lerp(anchor[0], right ? lx - 210 : lx + 210, lp), ly); ctx.lineTo(lx, ly); ctx.stroke();
      typed(part.label.toUpperCase(), lx, ly - 12, 32, WARN, lp * 1.5, right ? 'right' : 'left');
      ctx.globalAlpha = 1;
    });
  }
  // map any part colour into the blueprint palette (keep hue, force light)
  function mix(hex) { const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255; return `rgb(${Math.round(lerp(r, 191, 0.6))},${Math.round(lerp(g, 244, 0.6))},${Math.round(lerp(b, 255, 0.6))})`; }

  // real photos (image scenes) shown as a cyan duotone print in a blueprint frame
  const photos = {}, photoLoads = [];
  scenes.forEach((sc, i) => { if (sc.visual?.kind === 'image' && sc.visual.img) photoLoads.push(FS.loadImage(sc.visual.img).then(img => { photos[i] = img; })); });
  function photo(i, local) {
    const img = photos[i]; if (!img) return false;
    const x = 120, y = 400, w = 840, h = 700, p = E.outCubic(inv(0, 0.6, local));
    ctx.save(); ctx.globalAlpha = p; ctx.beginPath(); ctx.rect(x, y + (1 - p) * 40, w, h); ctx.clip();
    const s = Math.max(w / img.width, h / img.height);
    ctx.filter = 'grayscale(1) contrast(1.25) brightness(1.05)'; ctx.drawImage(img, x + (w - img.width * s) / 2, y + (h - img.height * s) / 2, img.width * s, img.height * s); ctx.filter = 'none';
    ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = '#2f8fd8'; ctx.fillRect(x, y, w, h);
    ctx.globalCompositeOperation = 'source-over'; ctx.strokeStyle = 'rgba(127,231,255,0.18)'; ctx.lineWidth = 1;
    for (let gx = x; gx < x + w; gx += 40) { ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx, y + h); ctx.stroke(); }
    ctx.restore();
    frameBox(x, y, w, h, E.outCubic(inv(0, 0.5, local)));
    return true;
  }
  const drawings = {};
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); host.setAttribute('viewBox', '0 0 400 400'); host.style.cssText = 'position:absolute;left:-9999px;width:400px;height:400px'; document.body.appendChild(host);
  scenes.forEach((sc, i) => { if (sc.visual?.kind === 'drawing' && sc.visual.svg) { host.innerHTML = sc.visual.svg; drawings[i] = [...host.querySelectorAll('path,circle,ellipse,rect,line,polygon,polyline')].map(e => { let L = 0; try { L = e.getTotalLength(); } catch {} const n = Math.max(6, Math.ceil(L / 4)); return L ? Array.from({ length: n + 1 }, (_, k) => { const p = e.getPointAtLength(k / n * L); return [p.x, p.y]; }) : null; }).filter(Boolean); } });

  function drawScene(i, local, dur) {
    const v = scenes[i].visual || {};
    const heading = v.heading && !['quote'].includes(v.kind) ? v.heading : null;
    if (heading) title(heading, local);
    switch (v.kind) {
      case 'model3d': model(v.parts, local, dur); break;
      case 'stat': {
        const target = Number(v.value) || 0, p = E.outExpo(inv(0.2, 1.6, local));
        glow(true); ctx.strokeStyle = CY; ctx.lineWidth = 3;
        for (let r = 0; r < 3; r++) { ctx.setLineDash(r === 1 ? [14, 12] : []); ctx.beginPath(); ctx.arc(W / 2, 760, 300 + r * 40, local * (r % 2 ? -0.4 : 0.3), local * (r % 2 ? -0.4 : 0.3) + Math.PI * 2 * E.outCubic(inv(0, 1, local))); ctx.stroke(); }
        ctx.setLineDash([]); glow(false);
        typed(`${v.prefix || ''}${fmtNum(target * p, target)}${v.suffix || ''}`, W / 2, 820, 190, '#fff', 1);
        wrap((v.label || '').toUpperCase(), 44, 760).forEach((ln, k) => typed(ln, W / 2, 1160 + k * 54, 44, WARN, (local - 1) * 2.5));
        break;
      }
      case 'list': case 'timeline': {
        const its = (v.items || []).slice(0, 4), step = Math.max(0.45, (dur - 0.8) / Math.max(1, its.length));
        its.forEach((txt, k) => {
          const p = inv(0.3 + k * step, 0.3 + k * step + 0.5, local), y = 470 + k * 170;
          frameBox(110, y, 860, 130, p);
          typed(String(k + 1).padStart(2, '0'), 160, y + 85, 54, WARN, p * 3, 'left');
          wrap(txt.toUpperCase(), 40, 640).slice(0, 2).forEach((ln, m) => typed(ln, 270, y + 62 + m * 46, 40, CY2, (p - 0.2) * 2, 'left', 400));
        });
        break;
      }
      case 'compare': {
        const a = E.outCubic(inv(0.1, 0.6, local)), b = E.outCubic(inv(0.4, 0.9, local));
        frameBox(90, 520, 400, 460, a); frameBox(590, 520, 400, 460, b);
        wrap((v.left || '').toUpperCase(), 52, 340).forEach((ln, k) => typed(ln, 290, 730 + k * 62, 52, CY2, a * 2));
        wrap((v.right || '').toUpperCase(), 52, 340).forEach((ln, k) => typed(ln, 790, 730 + k * 62, 52, CY2, b * 2));
        typed('VS', W / 2, 775, 64, WARN, inv(0.8, 1, local));
        break;
      }
      case 'icons': {
        const em = (v.emoji || []).slice(0, 6), cols = Math.min(3, em.length);
        em.forEach((e, k) => { const p = E.outBack(inv(0.2 + k * 0.15, 0.5 + k * 0.15, local)); const x = W / 2 + ((k % cols) - (cols - 1) / 2) * 290, y = 640 + Math.floor(k / cols) * 300;
          glow(true); ctx.strokeStyle = CY; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 115 * p, 0, Math.PI * 2); ctx.moveTo(x - 140 * p, y); ctx.lineTo(x + 140 * p, y); ctx.moveTo(x, y - 140 * p); ctx.lineTo(x, y + 140 * p); ctx.stroke(); glow(false);
          ctx.save(); ctx.globalAlpha = clamp(p); ctx.font = '130px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(e, x, y + 6); ctx.restore(); });
        break;
      }
      case 'image': if (photo(i, local)) break; // no photo: fall through and draw the scene's svg, if any
      case 'drawing': {
        const shapes = drawings[i] || [];
        glow(true); ctx.strokeStyle = CY; ctx.lineWidth = 3.2; ctx.lineJoin = ctx.lineCap = 'round';
        shapes.forEach((pts, k) => { const p = E.inOutCubic(inv(0.2 + k * 0.15, 0.8 + k * 0.15, local)); ctx.beginPath(); const n = Math.max(2, Math.floor(pts.length * p)); for (let j = 0; j < n; j++) { const x = W / 2 - 380 + pts[j][0] * 1.9, y = 380 + pts[j][1] * 1.9; j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); } if (p > 0) ctx.stroke(); });
        glow(false);
        break;
      }
      case 'quote': {
        const lines = wrap(`"${v.heading || ''}"`.toUpperCase(), 56, 860);
        frameBox(80, 560 - lines.length * 34, 920, lines.length * 72 + 140, E.outCubic(inv(0, 0.5, local)));
        lines.forEach((ln, k) => typed(ln, W / 2, 650 - lines.length * 34 + k * 72, 56, '#fff', (local - 0.3) * 25 / ln.length - k * 0.5));
        if (v.label) typed('— ' + v.label.toUpperCase(), W / 2, 700 + lines.length * 40, 36, WARN, (local - 1.5) * 2);
        break;
      }
      default: {
        if (!heading) break;
        // a schematic gizmo so a text-only scene still moves
        model([{ shape: 'torus', pos: [0, 0, 0], size: [1, 0.4, 1] }, { shape: 'sphere', pos: [0, 0, 0], size: [0.5, 0.5, 0.5] }], local, dur, 820, 280);
      }
    }
  }

  const chunks = buildChunks(S.words, 3, 18);
  function captions(t) {
    const hit = chunkAt(chunks, t); if (!hit) return;
    ctx.font = `700 60px ${MONO}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    const ws = hit.c.idx.map(j => S.words[j]), parts = ws.map(w => w.word.toUpperCase()), widths = parts.map(p => ctx.measureText(p).width);
    const gap = 26, total = widths.reduce((a, b) => a + b, 0) + gap * (parts.length - 1);
    const x0 = W / 2 - total / 2, y = 1320;
    ctx.fillStyle = 'rgba(6,26,61,0.85)'; ctx.fillRect(x0 - 30, y - 56, total + 60, 112);
    ctx.strokeStyle = CY; ctx.lineWidth = 3; ctx.strokeRect(x0 - 30, y - 56, total + 60, 112);
    let x = x0;
    ws.forEach((w, k) => {
      const on = t >= w.start - 0.03 && t < w.end + 0.08;
      if (on) { ctx.fillStyle = CY; ctx.fillRect(x - 8, y - 42, widths[k] + 16, 84); }
      ctx.fillStyle = on ? BG1 : '#fff'; ctx.fillText(parts[k], x, y + 4);
      x += widths[k] + gap;
    });
  }

  window.DUR = S.duration;
  window.__ready = document.fonts.ready.then(() => Promise.all([document.fonts.load(`700 40px ${MONO}`), ...photoLoads]));
  window.render = t => {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg, 0, 0); grid(t);
    const { i } = FS.sceneAt(t), s = scenes[i];
    const scan = i > 0 ? E.inOutCubic(inv(s.start - 0.1, s.start + 0.45, t)) : 1;
    if (scan < 1 && i > 0) {
      const prev = scenes[i - 1];
      ctx.save(); ctx.beginPath(); ctx.rect(0, H * scan, W, H); ctx.clip(); drawScene(i - 1, t - prev.start, prev.end - prev.start); ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H * scan); ctx.clip(); drawScene(i, Math.max(0, t - s.start), s.end - s.start); ctx.restore();
      glow(true); ctx.strokeStyle = CY2; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(0, H * scan); ctx.lineTo(W, H * scan); ctx.stroke(); glow(false);
    } else drawScene(i, Math.max(0, t - s.start), s.end - s.start);
    // corner HUD
    ctx.font = `400 26px ${MONO}`; ctx.fillStyle = 'rgba(127,231,255,0.55)'; ctx.textAlign = 'right';
    ctx.fillText(`FIG. ${String(i + 1).padStart(2, '0')}/${String(scenes.length).padStart(2, '0')}`, W - 70, 90);
    ctx.fillText(`T+${t.toFixed(2)}s`, W - 70, 126);
    captions(t);
  };
})();
