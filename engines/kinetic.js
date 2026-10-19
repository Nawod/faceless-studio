// KINETIC — clean keynote motion graphics: off-white canvas, huge type, springs, 3D orbits.
(function () {
  const { S, W, H, clamp, lerp, inv, E, spring, el, esc, loadImage, fmtNum, projectModel, buildChunks, chunkAt, isKey, scenes, phase } = FS;
  const ACC = S.accent || '#FF4A1C', INK = '#0E0E10', GREY = '#86868B';
  document.head.insertAdjacentHTML('beforeend', `<style>
    #stage{background:#F3F2EF;font-family:Inter,sans-serif;color:${INK}}
    .bg{position:absolute;inset:0;background:radial-gradient(1200px 1400px at 50% 38%,#fff 0%,#F3F2EF 55%,#E6E5E1 100%)}
    .dots{position:absolute;inset:-60px;background-image:radial-gradient(#0000001a 2px,transparent 2.4px);background-size:44px 44px;opacity:.55}
    .scene{position:absolute;inset:0;will-change:transform,opacity}
    .area{position:absolute;left:80px;right:80px;top:250px;height:900px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .hl{font-weight:900;letter-spacing:-0.045em;line-height:.95;display:flex;flex-wrap:wrap;justify-content:center;gap:0 .22em}
    .mask{overflow:hidden;padding:.06em .02em;display:inline-block}
    .w{display:inline-block;position:relative}
    .hi{position:absolute;left:-.08em;right:-.08em;top:.12em;bottom:.04em;background:${ACC};border-radius:.12em;transform-origin:left;z-index:-1}
    .lbl{font-weight:600;color:${GREY};font-size:54px;letter-spacing:-.01em;margin-top:28px}
    .num{font-weight:900;letter-spacing:-.06em;line-height:1;font-size:250px;font-variant-numeric:tabular-nums}
    .num small{font-size:.42em;letter-spacing:-.03em}
    .card{background:#fff;border-radius:30px;box-shadow:0 18px 50px #0000001c,0 2px 6px #0000000f}
    .item{display:flex;align-items:center;gap:30px;width:860px;padding:34px 38px;margin:14px 0;font-size:54px;font-weight:800;text-align:left;letter-spacing:-.02em}
    .badge{flex:none;width:76px;height:76px;border-radius:50%;background:${ACC};color:#fff;display:flex;align-items:center;justify-content:center;font-size:40px;font-weight:900}
    .head{font-weight:800;font-size:70px;letter-spacing:-.03em;margin-bottom:36px}
    .vs{position:absolute;left:50%;top:50%;width:150px;height:150px;margin:-75px;border-radius:50%;background:${INK};color:#fff;font-weight:900;font-size:58px;display:flex;align-items:center;justify-content:center;box-shadow:0 10px 40px #0004}
    .side{position:absolute;top:50%;width:420px;height:560px;margin-top:-280px;display:flex;align-items:center;justify-content:center;padding:30px;box-sizing:border-box;font-weight:900;font-size:76px;letter-spacing:-.04em;line-height:1}
    .orb{position:absolute;left:50%;top:52%;width:230px;height:230px;margin:-115px;border-radius:50%;background:#fff;display:flex;align-items:center;justify-content:center;font-size:130px;box-shadow:0 20px 50px #00000022}
    .tl-line{position:absolute;left:190px;width:8px;border-radius:4px;background:${INK};transform-origin:top}
    .tl-pt{position:absolute;left:150px;display:flex;align-items:center;gap:40px;font-size:50px;font-weight:700;text-align:left;width:780px}
    .tl-dot{flex:none;width:88px;height:88px;border-radius:50%;background:${ACC};border:10px solid #fff;box-shadow:0 6px 20px #0003;box-sizing:border-box}
    .tl-pt b{color:${ACC};font-weight:900;margin-right:16px}
    .q{font-weight:800;font-size:82px;letter-spacing:-.035em;line-height:1.05}
    .qm{font-family:'DM Serif Display',serif;font-size:330px;line-height:.6;color:${ACC};height:170px}
    .img{width:880px;height:1000px;border-radius:52px;overflow:hidden;position:relative}
    .img img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
    .pill{display:inline-block;background:${INK};color:#fff;font-weight:800;font-size:52px;padding:18px 40px;border-radius:999px;margin-top:-50px;position:relative}
    #cap{position:absolute;left:60px;right:60px;top:1235px;display:flex;justify-content:center;flex-wrap:wrap;gap:0 18px;font-weight:900;font-size:78px;letter-spacing:-.03em}
    #cap span{padding:2px 16px;border-radius:16px;color:${INK};text-shadow:0 0 18px #F3F2EF,0 0 6px #F3F2EF}
    #cap span.on{background:${ACC};color:#fff;text-shadow:none}
    #cta{position:absolute;left:50%;top:1450px;transform:translateX(-50%);font-weight:800;font-size:44px;padding:20px 44px;border-radius:999px;background:${INK};color:#fff;white-space:nowrap}
  </style>`);

  const stage = document.getElementById('stage');
  el('div', 'bg'); const dots = el('div', 'dots');
  const built = [];

  function headline(root, v) {
    const words = (v.heading || '').split(/\s+/).filter(Boolean);
    const longest = Math.max(...words.map(w => w.length), 4);
    const size = Math.min(200, Math.floor(880 / (longest * 0.58)));
    const hl = el('div', 'hl', root); hl.style.fontSize = size + 'px';
    const em = (v.emphasis || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const parts = words.map(w => {
      const m = el('span', 'mask', hl), s = el('span', 'w', m, esc(w));
      const isEm = em && w.toLowerCase().replace(/[^a-z0-9]/g, '') === em;
      let hi = null; if (isEm) { hi = el('span', 'hi', s); s.style.color = '#fff'; }
      return { s, hi, isEm };
    });
    return local => parts.forEach((p, k) => {
      const sp = spring(local - 0.05 - k * 0.07, { freq: 2.4, zeta: 0.62 });
      p.s.style.transform = `translateY(${(1 - sp) * 110}%)`;
      if (p.hi) { const q = E.outExpo(inv(0.35 + k * 0.07, 0.75 + k * 0.07, local)); p.hi.style.transform = `scaleX(${q})`; p.s.style.color = q > 0.4 ? '#fff' : INK; }
    });
  }

  function stat(root, v, dur) {
    const box = el('div', '', root);
    box.style.cssText = 'position:relative;width:720px;height:720px;display:flex;align-items:center;justify-content:center';
    box.innerHTML = `<svg width="720" height="720" viewBox="0 0 720 720" style="position:absolute;inset:0;transform:rotate(-90deg)"><circle cx="360" cy="360" r="330" fill="none" stroke="#0000000d" stroke-width="22"/><circle class="ring" cx="360" cy="360" r="330" fill="none" stroke="${ACC}" stroke-width="22" stroke-linecap="round" pathLength="1" stroke-dasharray="1" stroke-dashoffset="1"/></svg>`;
    const num = el('div', 'num', box), lbl = el('div', 'lbl', root, esc(v.label || v.heading || ''));
    lbl.style.maxWidth = '820px'; lbl.style.fontSize = '60px'; lbl.style.color = INK;
    const target = Number(v.value) || 0, ring = box.querySelector('.ring');
    const pre = esc(v.prefix || ''), suf = esc(v.suffix || '');
    const len = Math.max(String(Math.round(target)).length + (pre + suf).length * 0.45, 3);
    num.style.fontSize = Math.min(260, Math.floor(1000 / (len * 0.62))) + 'px';
    const T = Math.min(1.8, dur * 0.55);
    return local => {
      const p = E.outExpo(inv(0.15, 0.15 + T, local));
      num.innerHTML = `<small>${pre}</small>${fmtNum(target * p, target)}<small>${suf}</small>`;
      const sp = spring(local - 0.05, { freq: 2, zeta: 0.6 });
      num.style.transform = `translateY(${(1 - sp) * 80}px) scale(${0.9 + 0.1 * sp})`;
      ring.setAttribute('stroke-dashoffset', String(1 - 0.999 * p));
      lbl.style.opacity = inv(0.5, 0.9, local); lbl.style.transform = `translateY(${(1 - E.outCubic(inv(0.5, 1, local))) * 30}px)`;
    };
  }

  function list(root, v, dur) {
    if (v.heading) el('div', 'head', root, esc(v.heading));
    const items = (v.items || []).slice(0, 4).map((txt, k) => {
      const it = el('div', 'item card', root, `<span class="badge">${k + 1}</span><span>${esc(txt)}</span>`);
      return it;
    });
    const step = Math.max(0.45, (dur - 0.8) / Math.max(1, items.length));
    return local => items.forEach((it, k) => {
      const sp = spring(local - 0.25 - k * step, { freq: 2.2, zeta: 0.65 });
      it.style.opacity = clamp(sp * 1.5); it.style.transform = `translateX(${(1 - sp) * 120}px)`;
      const current = local >= 0.25 + k * step && (k === items.length - 1 || local < 0.25 + (k + 1) * step);
      it.style.boxShadow = current ? `0 22px 60px #0000002a, inset 8px 0 0 ${ACC}` : '';
    });
  }

  function compare(root, v) {
    if (v.heading) { const h = el('div', 'head', root, esc(v.heading)); h.style.position = 'absolute'; h.style.top = '40px'; }
    const L = el('div', 'side card', root, esc(v.left || '')), R = el('div', 'side', root, esc(v.right || ''));
    L.style.left = '0px'; R.style.right = '0px'; R.style.background = INK; R.style.color = '#fff'; R.style.borderRadius = '30px';
    const vs = el('div', 'vs', root, 'VS');
    root.style.perspective = '1800px';
    return local => {
      const a = spring(local - 0.05, { freq: 1.8, zeta: 0.7 }), b = spring(local - 0.2, { freq: 1.8, zeta: 0.7 });
      L.style.transform = `translateX(${(1 - a) * -500}px) rotateY(${lerp(40, 14, a)}deg)`;
      R.style.transform = `translateX(${(1 - b) * 500}px) rotateY(${lerp(-40, -14, b)}deg)`;
      const c = E.outBack(inv(0.45, 0.8, local), 2.4); vs.style.transform = `scale(${c}) rotate(${(1 - c) * -90}deg)`;
    };
  }

  function icons(root, v) {
    if (v.heading) { const h = el('div', 'head', root, esc(v.heading)); h.style.position = 'absolute'; h.style.top = '0px'; h.style.fontSize = '80px'; }
    const em = (v.emoji || ['✨', '🔍', '🧠']).slice(0, 6);
    const orbs = em.map(e => el('div', 'orb', root, e));
    return local => {
      const intro = E.outCubic(inv(0, 0.9, local));
      orbs.forEach((o, k) => {
        const a = local * 0.55 + (k / orbs.length) * Math.PI * 2;
        const R = 360 * intro, x = Math.sin(a) * R, z = Math.cos(a) * R, y = z * 0.42;
        const sc = (0.55 + 0.6 * (z / 360 + 1) / 2) * (0.4 + 0.6 * intro);
        o.style.transform = `translate(${x}px, ${y + 60}px) scale(${sc})`;
        o.style.zIndex = String(Math.round(z + 400));
        o.style.filter = `blur(${Math.max(0, (-z / 340) * 3)}px)`;
        o.style.opacity = String(0.55 + 0.45 * (z / 340 + 1) / 2);
      });
    };
  }

  function timeline(root, v, dur) {
    const items = (v.items || []).slice(0, 4);
    const top = 120, gap = Math.min(220, 700 / Math.max(1, items.length));
    const line = el('div', 'tl-line', root); line.style.top = top + 44 + 'px'; line.style.height = (items.length - 1) * gap + 'px';
    const pts = items.map((txt, k) => {
      const [yr, ...rest] = txt.split(/\s+[—–-]\s+/);
      const p = el('div', 'tl-pt', root, `<span class="tl-dot"></span><span><b>${esc(yr)}</b>${esc(rest.join(' — '))}</span>`);
      p.style.top = top + k * gap + 'px';
      return p;
    });
    root.style.justifyContent = 'flex-start';
    const step = Math.max(0.5, (dur - 0.6) / Math.max(1, items.length));
    return local => {
      line.style.transform = `scaleY(${E.inOutCubic(inv(0.1, 0.1 + step * (items.length - 1), local))})`;
      pts.forEach((p, k) => { const sp = spring(local - 0.1 - k * step, { freq: 2.4, zeta: 0.6 }); p.style.opacity = clamp(sp * 1.4); p.style.transform = `translateX(${(1 - sp) * 60}px)`; });
    };
  }

  function quote(root, v) {
    el('div', 'qm', root, '“');
    const q = el('div', 'q', root);
    const ws = (v.heading || '').split(/\s+/).map(w => el('span', '', q, esc(w) + ' '));
    const who = el('div', 'lbl', root, v.label ? '— ' + esc(v.label) : '');
    return local => {
      ws.forEach((w, k) => { const p = E.outCubic(inv(0.1 + k * 0.06, 0.4 + k * 0.06, local)); w.style.opacity = 0.12 + 0.88 * p; });
      who.style.opacity = inv(0.3 + ws.length * 0.06, 0.6 + ws.length * 0.06, local);
    };
  }

  function image(root, v) {
    const card = el('div', 'img card', root);
    const img = el('img', '', card); img.src = v.img;
    let pill = null; if (v.heading) pill = el('div', 'pill', root, esc(v.heading));
    root.style.perspective = '2000px';
    return (local, dur) => {
      const sp = spring(local, { freq: 1.6, zeta: 0.75 });
      card.style.transform = `rotateX(${(1 - sp) * 18}deg) translateY(${(1 - sp) * 120}px)`;
      img.style.transform = `scale(${1.08 + 0.1 * (local / dur)}) translate(${-1.5 * (local / dur) * 10}px, 0)`;
      if (pill) { const p = E.outBack(inv(0.35, 0.75, local)); pill.style.transform = `scale(${p})`; }
    };
  }

  function drawing(root, v) {
    const wrap = el('div', '', root);
    wrap.innerHTML = `<svg viewBox="0 0 400 400" width="780" height="780">${v.svg || ''}</svg>`;
    const shapes = [...wrap.querySelectorAll('path,circle,ellipse,rect,line,polygon,polyline')];
    shapes.forEach(s => {
      s.setAttribute('pathLength', '1'); s.style.strokeDasharray = '1'; s.style.strokeDashoffset = '1';
      s.dataset.fill = s.getAttribute('fill') || 'none'; s.style.fillOpacity = '0';
      s.setAttribute('stroke', s.getAttribute('stroke') && s.getAttribute('stroke') !== 'none' ? s.getAttribute('stroke') : INK);
      s.setAttribute('stroke-width', Math.max(4, +s.getAttribute('stroke-width') || 4)); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    });
    let h = null; if (v.heading) h = el('div', 'pill', root, esc(v.heading));
    return local => {
      shapes.forEach((s, k) => {
        const p = E.inOutCubic(inv(0.1 + k * 0.12, 0.7 + k * 0.12, local));
        s.style.strokeDashoffset = String(1 - p);
        s.style.fillOpacity = String(E.outCubic(inv(0.5 + k * 0.12, 0.9 + k * 0.12, local)));
      });
      if (h) h.style.transform = `scale(${E.outBack(inv(0.4, 0.8, local))})`;
    };
  }

  function model3d(root, v) {
    const c = el('canvas', '', root); c.width = 920; c.height = 920;
    const ctx = c.getContext('2d');
    let h = null; if (v.heading) { h = el('div', 'head', root, esc(v.heading)); h.style.marginTop = '-20px'; }
    const parts = (v.parts || []).slice(0, 9);
    return (local, dur) => {
      ctx.clearRect(0, 0, 920, 920);
      const explode = E.inOutCubic(inv(dur * 0.35, dur * 0.7, local));
      const draw = E.outCubic(inv(0, 1, local));
      const proj = projectModel(parts, explode, { yaw: 0.6 + local * 0.45, pitch: 0.42, dist: 4, scale: 330, cx: 460, cy: 470 });
      ctx.lineCap = 'round';
      proj.forEach(({ part, segs, anchor }, k) => {
        ctx.strokeStyle = part.color || INK; ctx.lineWidth = 3.2;
        ctx.beginPath(); const n = Math.ceil(segs.length * draw);
        for (let j = 0; j < n; j++) { const [a, b] = segs[j]; ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); }
        ctx.stroke();
        const lp = inv(dur * 0.55 + k * 0.1, dur * 0.7 + k * 0.1, local);
        if (part.label && lp > 0) {
          const right = anchor[0] > 460, lx = right ? 900 : 20, ly = anchor[1] - 10;
          ctx.globalAlpha = lp; ctx.strokeStyle = GREY; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.moveTo(anchor[0], anchor[1]); ctx.lineTo(lerp(anchor[0], lx, 0.7), ly); ctx.stroke();
          ctx.fillStyle = INK; ctx.font = '800 34px Inter'; ctx.textAlign = right ? 'right' : 'left';
          ctx.fillText(part.label, lx, ly - 8); ctx.globalAlpha = 1;
        }
      });
      if (h) h.style.opacity = inv(0.2, 0.6, local);
    };
  }

  const KINDS = { headline, stat, list, compare, icons, timeline, quote, image, drawing, model3d };
  scenes.forEach((sc, i) => {
    const root = el('div', 'scene'); const area = el('div', 'area', root);
    let v = sc.visual || { kind: 'headline' };
    if ((v.kind === 'image' && !v.img) || !KINDS[v.kind]) v = { kind: 'headline', heading: v.heading || sc.narration.split(/\s+/).slice(0, 4).join(' '), emphasis: v.emphasis };
    const upd = KINDS[v.kind](area, v, sc.end - sc.start);
    built.push({ root, upd, i });
  });

  const cap = el('div'); cap.id = 'cap';
  const chunks = buildChunks(S.words, 3, 20);

  window.DUR = S.duration;
  window.__ready = Promise.all([document.fonts.ready, ...[...document.images].map(i => i.decode().catch(() => {}))]);
  window.render = t => {
    dots.style.transform = `translate(${(t * 9) % 44}px, ${(t * 5) % 44}px)`;
    built.forEach(({ root, upd, i }) => {
      const ph = phase(i, t);
      if (!ph.active) { root.style.display = 'none'; return; }
      root.style.display = '';
      const a = E.outCubic(ph.in), b = E.inCubic(ph.out);
      const drift = 1 + 0.035 * clamp(ph.local / ph.dur);
      root.style.opacity = String(Math.min(a, 1 - b));
      root.style.transform = `translateY(${(1 - a) * 140 - b * 200}px) scale(${(0.94 + 0.06 * a) * drift})`;
      root.style.filter = (a < 1 || b > 0) ? `blur(${(1 - a) * 16 + b * 14}px)` : 'none';
      upd(Math.max(0, ph.local), ph.dur);
    });
    // captions
    const hit = chunkAt(chunks, t);
    if (!hit) { cap.style.opacity = '0'; } else {
      if (cap.dataset.k !== String(hit.k)) { cap.innerHTML = hit.c.idx.map(j => `<span>${esc(S.words[j].word)}</span>`).join(''); cap.dataset.k = hit.k; }
      const spans = cap.children;
      hit.c.idx.forEach((j, m) => spans[m].classList.toggle('on', t >= S.words[j].start - 0.03 && (t < S.words[j].end + 0.08 || m === hit.c.idx.length - 1 && t < hit.c.end + 0.6)));
      const sp = spring(t - hit.c.start + 0.06, { freq: 3, zeta: 0.6 });
      cap.style.opacity = '1'; cap.style.transform = `scale(${0.86 + 0.14 * sp})`;
    }
  };
})();
