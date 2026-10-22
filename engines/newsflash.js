// NEWSFLASH — news-explainer Shorts: footage with a graded look, red news graphics, lower-thirds,
// fact panels, press-quote cards and key words that punch huge in the centre.
(function () {
  const { S, W, H, clamp, lerp, inv, E, spring, hash, el, esc, fmtNum, buildChunks, chunkAt, isKey, scenes } = FS;
  const RED = '#E10600', YEL = '#FFB800', INK = '#0E0F12';
  document.head.insertAdjacentHTML('beforeend', `<style>
    #stage{background:#000;font-family:Inter,sans-serif}
    .layer{position:absolute;inset:0;overflow:hidden}
    .layer video,.layer img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:contrast(1.12) saturate(.82) brightness(.88)}
    .fb{position:absolute;inset:0;background:radial-gradient(circle at 50% 40%,#2a2f3a,#07080b)}
    #shade{position:absolute;inset:0;z-index:300;background:linear-gradient(#000c 0%,#0000 25%,#0000 50%,#000d 100%),radial-gradient(1200px 1800px at 50% 45%,transparent 45%,#000b 100%)}
    #grain{position:absolute;inset:0;z-index:301;mix-blend-mode:overlay;opacity:.35}
    .tag{position:absolute;z-index:400;left:60px;top:190px;display:flex;align-items:stretch;font-weight:900;font-size:40px;letter-spacing:.04em}
    .tag span{padding:10px 22px}.tag .a{background:${RED};color:#fff}.tag .b{background:#fff;color:${INK}}
    .ov{position:absolute;z-index:350;left:60px;right:60px}
    .lt{top:1000px}
    .lt .k{display:inline-block;background:${YEL};color:${INK};font-weight:900;font-size:36px;padding:6px 18px;letter-spacing:.05em}
    .lt .h{background:${RED};color:#fff;font-weight:900;font-size:62px;line-height:1.05;padding:16px 26px;text-transform:uppercase;box-shadow:0 10px 30px #0008}
    .panel{top:340px;color:#fff;padding:10px 0 10px 34px;border-left:14px solid ${RED};text-shadow:0 0 22px #000,0 6px 18px #000d}
    .panel .t{font-weight:900;font-size:36px;letter-spacing:.08em;color:${RED};margin-bottom:12px}
    .panel .n{font-weight:900;font-size:170px;line-height:1;letter-spacing:-.04em}
    .panel .l{font-weight:700;font-size:48px;margin-top:6px}
    .panel .row{display:flex;gap:20px;align-items:center;font-weight:800;font-size:48px;margin:12px 0}
    .panel .row b{background:${RED};color:#fff;min-width:64px;height:64px;display:flex;align-items:center;justify-content:center;font-size:36px}
    .quote{font-family:'DM Serif Display',serif;font-size:74px;line-height:1.08}
    .quote mark{background:linear-gradient(transparent 55%,${YEL}aa 55%);color:inherit}
    .src{font-weight:800;font-size:38px;margin-top:18px;color:${YEL}}
    .loc{top:300px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}
    .loc .p{background:#fff;color:${INK};font-weight:900;font-size:58px;padding:12px 26px}
    .loc .c{background:${INK};color:${YEL};font-family:'Space Mono',monospace;font-weight:700;font-size:34px;padding:8px 20px}
    .split{top:330px;display:flex;gap:24px}
    .split div{flex:1;color:#fff;font-weight:900;font-size:76px;line-height:.95;text-align:center;padding:20px 10px;text-transform:uppercase;-webkit-text-stroke:10px #000;paint-order:stroke fill}
    .split div:last-child{color:${YEL}}
    #big{position:absolute;z-index:450;left:0;right:0;top:780px;text-align:center;font-weight:900;font-size:170px;letter-spacing:-.03em;color:#fff;text-transform:uppercase;-webkit-text-stroke:14px #000;paint-order:stroke fill;text-shadow:0 10px 40px #000}
    #cap{position:absolute;z-index:460;left:60px;right:60px;top:1210px;text-align:center;font-weight:800;font-size:66px;line-height:1.1;color:#fff;text-shadow:0 0 18px #000,0 4px 10px #000}
    #cap .k{color:${YEL}}
    #flash{position:absolute;inset:0;z-index:500;background:#fff;opacity:0}
    #wipe{position:absolute;top:0;bottom:0;width:220px;z-index:490;background:${RED};transform:skewX(-12deg)}
  </style>`);

  const firstSource = (S.sources || [])[0];
  const layers = scenes.map((sc, i) => {
    const v = sc.visual || {};
    const layer = el('div', 'layer'); layer.style.zIndex = String(10 + i);
    let media = null, kind = 'none';
    if (v.video) { media = el('video', '', layer); media.muted = true; media.preload = 'auto'; media.src = v.video; kind = 'video'; }
    else if (v.img) { media = el('img', '', layer); media.src = v.img; kind = 'img'; }
    else el('div', 'fb', layer);
    // graphics for this scene
    const g = el('div', '', layer); g.style.cssText = 'position:absolute;inset:0;z-index:350';
    let upd = () => {};
    if (v.kind === 'stat') {
      const p = el('div', 'ov panel', g, `<div class="t">BY THE NUMBERS</div><div class="n"></div><div class="l">${esc(v.label || '')}</div>`);
      const n = p.querySelector('.n'), target = Number(v.value) || 0;
      upd = l => { n.textContent = `${v.prefix || ''}${fmtNum(target * E.outExpo(inv(0.2, 1.5, l)), target)}${v.suffix || ''}`; p.style.transform = `translateX(${(1 - E.outExpo(inv(0, 0.4, l))) * -1200}px)`; };
    } else if (v.kind === 'list' || v.kind === 'timeline') {
      const its = (v.items || []).slice(0, 4);
      const p = el('div', 'ov panel', g, `<div class="t">${esc((v.heading || (v.kind === 'timeline' ? 'TIMELINE' : 'WHAT WE KNOW')).toUpperCase())}</div>` + its.map((t, k) => `<div class="row"><b>${k + 1}</b><span>${esc(t)}</span></div>`).join(''));
      const rows = [...p.querySelectorAll('.row')], step = Math.max(0.45, (sc.end - sc.start - 0.8) / Math.max(1, its.length));
      upd = l => { p.style.transform = `translateX(${(1 - E.outExpo(inv(0, 0.4, l))) * -1200}px)`; rows.forEach((r, k) => { r.style.opacity = String(inv(0.3 + k * step, 0.5 + k * step, l)); }); };
    } else if (v.kind === 'quote') {
      const words = (v.heading || '').split(/\s+/), mid = Math.floor(words.length / 3);
      const html = words.map((w, k) => (k >= mid && k < mid + Math.max(2, Math.ceil(words.length / 3)) ? `<mark>${esc(w)}</mark>` : esc(w))).join(' ');
      const p = el('div', 'ov panel', g, `<div class="t">ON THE RECORD</div><div class="quote">“${html}”</div><div class="src">— ${esc(v.label || firstSource?.title || '')}</div>`);
      upd = l => { p.style.transform = `translateY(${(1 - E.outExpo(inv(0, 0.45, l))) * 300}px)`; p.style.opacity = String(inv(0, 0.25, l)); };
    } else if (v.kind === 'map' && v.places?.length) {
      const pl = v.places[0];
      const p = el('div', 'ov loc', g, `<div class="c">LOCATION</div><div class="p">📍 ${esc(pl.name)}</div><div class="c">${Math.abs(+pl.lat).toFixed(2)}°${+pl.lat >= 0 ? 'N' : 'S'}  ${Math.abs(+pl.lon).toFixed(2)}°${+pl.lon >= 0 ? 'E' : 'W'}</div>`);
      const parts = [...p.children];
      upd = l => parts.forEach((c, k) => { c.style.transform = `translateX(${(1 - E.outExpo(inv(k * 0.15, 0.4 + k * 0.15, l))) * -900}px)`; });
    } else if (v.kind === 'compare') {
      const p = el('div', 'ov split', g, `<div>${esc(v.left || '')}</div><div>${esc(v.right || '')}</div>`);
      const [a, b] = p.children;
      upd = l => { a.style.transform = `translateY(${(1 - E.outExpo(inv(0, 0.4, l))) * -800}px)`; b.style.transform = `translateY(${(1 - E.outExpo(inv(0.15, 0.55, l))) * 800}px)`; };
    } else if (v.heading) {
      const p = el('div', 'ov lt', g, `<div class="k">${i === 0 ? 'EXPLAINED' : 'KEY FACT'}</div><div class="h">${esc(v.heading)}</div>`);
      upd = l => { p.style.transform = `translateX(${(1 - E.outExpo(inv(0.1, 0.5, l))) * -1200}px)`; };
    }
    return { layer, media, kind, upd, sa: hash(i, 3), sb: hash(i, 9) };
  });
  const shade = el('div'); shade.id = 'shade';
  const grain = el('canvas'); grain.id = 'grain'; grain.width = 540; grain.height = 960; grain.style.width = W + 'px'; grain.style.height = H + 'px';
  const gctx = grain.getContext('2d'), gimg = gctx.createImageData(540, 960);
  const tag = el('div', 'tag', null, `<span class="a">EXPLAINED</span><span class="b">${esc((S.keywords?.[0] || (S.title || '').split(/\s+/).slice(0, 2).join(' ')).toUpperCase())}</span>`);
  const big = el('div'); big.id = 'big';
  const cap = el('div'); cap.id = 'cap';
  const wipe = el('div'); wipe.id = 'wipe';
  const flash = el('div'); flash.id = 'flash';
  const chunks = buildChunks(S.words, 4, 26);
  const bigWords = S.words.map((w, k) => ({ ...w, k })).filter(w => isKey(w.word) || (w.word.replace(/[^a-z]/gi, '').length >= 8 && hash(w.k, 5) < 0.35));

  const loaded = layers.filter(l => l.kind === 'video').map(l => new Promise(res => { const to = setTimeout(res, 25000); l.media.addEventListener('loadeddata', () => { clearTimeout(to); res(); }, { once: true }); l.media.addEventListener('error', () => { clearTimeout(to); l.kind = 'broken'; res(); }, { once: true }); }));
  const seek = (v, t) => new Promise(res => { if (Math.abs(v.currentTime - t) < 0.0005) return res(); const to = setTimeout(res, 3000); v.addEventListener('seeked', () => { clearTimeout(to); res(); }, { once: true }); v.currentTime = t; });

  window.DUR = S.duration;
  window.__ready = Promise.all([document.fonts.ready, ...loaded, ...layers.filter(l => l.kind === 'img').map(l => l.media.decode().catch(() => {}))]);
  window.render = async t => {
    const waits = []; let fl = 0, wipeX = -400;
    layers.forEach((L, i) => {
      const s = scenes[i], next = scenes[i + 1];
      const vis = t >= s.start - 0.02 && (!next || t < next.start + 0.25);
      L.layer.style.display = vis ? '' : 'none'; if (!vis) return;
      const local = t - s.start, dur = s.end - s.start;
      const inP = i === 0 ? 1 : E.outCubic(inv(s.start, s.start + 0.25, t));
      if (i > 0 && t >= s.start - 0.2 && t < s.start + 0.2) { wipeX = lerp(-400, W + 400, inv(s.start - 0.2, s.start + 0.2, t)); fl = Math.max(fl, 0.12 * (1 - inv(s.start, s.start + 0.15, t))); }
      L.layer.style.transform = `scale(${(1.05 + 0.1 * clamp(local / dur)) * (1 + 0.25 * (1 - inP))}) translate(${(L.sa - 0.5) * 50 * clamp(local / dur)}px, ${(L.sb - 0.5) * 30 * clamp(local / dur)}px)`;
      L.layer.style.opacity = String(i === 0 ? 1 : clamp(inP * 1.5));
      if (L.kind === 'video' && L.media.duration > 0) { const d = L.media.duration - 0.15; waits.push(seek(L.media, d > 0 ? (Math.max(0, local) * 0.95) % d : 0)); }
      L.upd(Math.max(0, local));
    });
    wipe.style.left = wipeX + 'px'; flash.style.opacity = String(fl);
    // film grain (re-seeded 12x/s)
    const seed = Math.floor(t * 12); let a = seed * 9973 + 1;
    for (let k = 0; k < gimg.data.length; k += 4) { a = (a * 1103515245 + 12345) & 0x7fffffff; const v = a & 255; gimg.data[k] = gimg.data[k + 1] = gimg.data[k + 2] = v; gimg.data[k + 3] = 40; }
    gctx.putImageData(gimg, 0, 0);
    tag.style.transform = `translateX(${(1 - E.outExpo(inv(0.1, 0.6, t))) * -700}px)`;
    // big key word punch
    const bw = bigWords.find(w => t >= w.start - 0.02 && t < w.end + 0.35);
    if (bw) { const word = bw.word.replace(/[,;:.!?]$/, ''); big.textContent = word; big.style.fontSize = Math.min(170, Math.floor(1000 / (word.length * 0.66))) + 'px'; const p = E.outBack(inv(bw.start - 0.02, bw.start + 0.12, t), 2.6); big.style.opacity = '1'; big.style.transform = `scale(${0.5 + 0.5 * p})`; }
    else big.style.opacity = '0';
    const hit = chunkAt(chunks, t);
    if (!hit) cap.style.opacity = '0'; else {
      if (cap.dataset.k !== String(hit.k)) { cap.innerHTML = hit.c.idx.map(j => { const w = S.words[j].word; return isKey(w) ? `<span class="k">${esc(w)}</span>` : esc(w); }).join(' '); cap.dataset.k = hit.k; }
      cap.style.opacity = '1';
    }
    await Promise.all(waits);
  };
})();
