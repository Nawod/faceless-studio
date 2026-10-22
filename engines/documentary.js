// DOCUMENTARY — full-screen stock footage, slow camera push, whip-zoom cuts, huge pop-in captions (viral nature/mystery Shorts grammar).
(function () {
  const { S, W, H, clamp, lerp, inv, E, hash, el, esc, fmtNum, buildChunks, chunkAt, isKey, scenes } = FS;
  const KEY = S.accent || '#FFD60A';
  document.head.insertAdjacentHTML('beforeend', `<style>
    #stage{background:#000;font-family:Inter,sans-serif}
    .layer{position:absolute;inset:0;overflow:hidden}
    .layer video,.layer img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:contrast(1.08) saturate(1.12) brightness(.94)}
    .fallback{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:420px}
    #shade{position:absolute;inset:0;background:linear-gradient(#000a 0%,#0000 22%,#0000 55%,#000b 100%),radial-gradient(1200px 1800px at 50% 45%,transparent 50%,#000a 100%)}
    #cap{position:absolute;left:50px;right:50px;top:1060px;text-align:center;font-weight:900;font-size:104px;line-height:1.02;letter-spacing:-.02em;color:#fff;
      -webkit-text-stroke:14px #000;paint-order:stroke fill;text-shadow:0 8px 24px #000c}
    #cap .k{color:${KEY}}
    .ov{position:absolute;left:60px;right:60px;text-align:center;color:#fff;font-weight:900;-webkit-text-stroke:12px #000;paint-order:stroke fill;text-shadow:0 8px 30px #000c}
    .big{top:330px;font-size:230px;letter-spacing:-.05em}
    .sub{top:600px;font-size:62px;-webkit-text-stroke:9px #000}
    .ttl{top:250px;font-size:84px;line-height:1.02;text-transform:uppercase}
    .ttl span{color:${KEY}}
    .badge{position:absolute;left:60px;top:220px;background:${KEY};color:#000;font-weight:900;font-size:64px;padding:10px 30px;border-radius:14px;-webkit-text-stroke:0}
    #flash{position:absolute;inset:0;background:#fff;pointer-events:none}
  </style>`);

  const layers = scenes.map((sc, i) => {
    const v = sc.visual || {};
    const layer = el('div', 'layer'); layer.style.zIndex = String(i + 1);
    let media = null, kind = 'none';
    if (v.video) { media = el('video', '', layer); media.muted = true; media.preload = 'auto'; media.playsInline = true; media.src = v.video; kind = 'video'; }
    else if (v.img) { media = el('img', '', layer); media.src = v.img; kind = 'img'; }
    else { const f = el('div', 'fallback', layer, esc((v.emoji || ['🌍'])[0])); f.style.background = `radial-gradient(circle at 50% 40%, hsl(${(i * 47) % 360} 50% 30%), #050505)`; }
    // overlays
    const ov = [];
    if (v.kind === 'stat') { const big = el('div', 'ov big', layer), sub = el('div', 'ov sub', layer, esc(v.label || '')); ov.push({ type: 'stat', big, sub, v }); }
    else if (v.kind === 'headline' && v.heading) {
      const em = (v.emphasis || '').toLowerCase();
      const ttl = el('div', 'ov ttl', layer, v.heading.split(/\s+/).map(w => w.toLowerCase().replace(/[^a-z0-9]/g, '') === em.replace(/[^a-z0-9]/g, '') ? `<span>${esc(w)}</span>` : esc(w)).join(' '));
      ov.push({ type: 'ttl', ttl });
    } else if (v.kind === 'timeline' && v.items?.length) { const b = el('div', 'badge', layer, esc(v.items[0].split(/\s+[—–-]\s+/)[0])); ov.push({ type: 'badge', b }); }
    else if (v.kind === 'map' && v.places?.length) { const b = el('div', 'badge', layer, '📍 ' + esc(v.places[0].name)); ov.push({ type: 'badge', b }); }
    return { layer, media, kind, ov, seedA: hash(i, 3), seedB: hash(i, 7) };
  });
  const shade = el('div'); shade.id = 'shade'; shade.style.zIndex = '500';
  const cap = el('div'); cap.id = 'cap'; cap.style.zIndex = '600';
  const flash = el('div'); flash.id = 'flash'; flash.style.zIndex = '700'; flash.style.opacity = '0';
  const chunks = buildChunks(S.words, 3, 16);

  const loaded = layers.filter(l => l.kind === 'video').map(l => new Promise(res => {
    const done = () => res(); const to = setTimeout(done, 25000);
    l.media.addEventListener('loadeddata', () => { clearTimeout(to); done(); }, { once: true });
    l.media.addEventListener('error', () => { clearTimeout(to); l.kind = 'broken'; done(); }, { once: true });
  }));
  const imgs = layers.filter(l => l.kind === 'img').map(l => l.media.decode().catch(() => {}));

  function seek(video, t) {
    return new Promise(res => {
      if (Math.abs(video.currentTime - t) < 0.0005) return res();
      const to = setTimeout(res, 3000);
      video.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true });
      video.currentTime = t;
    });
  }

  window.DUR = S.duration;
  window.__ready = Promise.all([document.fonts.ready, ...loaded, ...imgs]);
  window.render = async t => {
    const waits = [];
    let flashA = 0;
    layers.forEach((L, i) => {
      const s = scenes[i], next = scenes[i + 1];
      const vis = t >= s.start - 0.02 && (!next || t < next.start + 0.3);
      L.layer.style.display = vis ? '' : 'none';
      if (!vis) return;
      const local = t - s.start, dur = s.end - s.start;
      const inP = i === 0 ? 1 : E.outCubic(inv(s.start, s.start + 0.3, t));
      if (i > 0) flashA = Math.max(flashA, 0.18 * (1 - inv(s.start, s.start + 0.18, t)) * (t >= s.start ? 1 : 0));
      // camera: push in + drift, whip-zoom in on the cut
      // a different camera move per shot: push in, pull out, pan left, pan right, tilt up
      const p = E.inOutCubic(clamp(local / dur)), move = ['in', 'out', 'left', 'right', 'up'][i % 5];
      const push = move === 'out' ? 1.26 - 0.16 * p : 1.06 + 0.16 * p;
      const dx = move === 'left' ? -70 * p : move === 'right' ? 70 * p : (L.seedA - 0.5) * 40 * p;
      const dy = move === 'up' ? -90 * p : (L.seedB - 0.5) * 30 * p;
      const whip = 1 + 0.35 * (1 - inP);
      L.layer.style.transform = `scale(${push * whip}) translate(${dx}px, ${dy}px) rotate(${(i % 2 ? 1 : -1) * 0.8 * p}deg)`;
      L.layer.style.filter = inP < 1 ? `blur(${(1 - inP) * 18}px)` : 'none';
      L.layer.style.opacity = String(i === 0 ? 1 : clamp(inP * 1.6));
      if (L.kind === 'video' && L.media.duration > 0) {
        const rate = 0.9, d = L.media.duration - 0.15;
        let vt = Math.max(0, local) * rate;
        vt = d > 0 ? vt % d : 0;
        waits.push(seek(L.media, vt));
      }
      for (const o of L.ov) {
        if (o.type === 'stat') {
          const target = Number(o.v.value) || 0, p = E.outExpo(inv(0.15, 1.5, local));
          o.big.textContent = `${o.v.prefix || ''}${fmtNum(target * p, target)}${o.v.suffix || ''}`;
          const pop = E.outBack(inv(0.05, 0.35, local), 2); o.big.style.transform = `scale(${pop})`;
          o.sub.style.opacity = String(inv(0.5, 0.8, local));
        } else if (o.type === 'ttl') {
          const a = E.outBack(inv(0.05, 0.35, local), 2), b = inv(2.6, 3.0, local);
          o.ttl.style.transform = `scale(${a})`; o.ttl.style.opacity = String(1 - b);
        } else if (o.type === 'badge') {
          o.b.style.transform = `translateX(${(1 - E.outExpo(inv(0.1, 0.5, local))) * -500}px)`;
        }
      }
    });
    flash.style.opacity = String(flashA);
    const hit = chunkAt(chunks, t);
    if (!hit) cap.style.opacity = '0'; else {
      if (cap.dataset.k !== String(hit.k)) {
        cap.innerHTML = hit.c.idx.map(j => { const w = S.words[j].word; return isKey(w) ? `<span class="k">${esc(w)}</span>` : esc(w); }).join(' ');
        cap.dataset.k = hit.k;
      }
      const p = E.outBack(inv(hit.c.start - 0.05, hit.c.start + 0.1, t), 2.4);
      cap.style.opacity = '1'; cap.style.transform = `scale(${0.6 + 0.4 * p}) rotate(${(hit.k % 3 - 1) * 1.2}deg)`;
    }
    await Promise.all(waits);
  };
})();
