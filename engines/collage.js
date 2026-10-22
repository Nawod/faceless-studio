// COLLAGE — editorial halftone paper-collage: flat colour fields, B&W halftone cut-outs, ransom letters, tape, stop-motion jitter.
(function () {
  const { S, W, H, clamp, lerp, inv, E, spring, rng, hash, el, esc, loadImage, fmtNum, buildChunks, chunkAt, scenes, phase } = FS;
  const R = rng(S.seed * 97 + 13);
  const BASE = ['#E63B2E', '#F5C518', '#1FA39A', '#6B4EFF', '#2D5BFF', '#FF7A1A', '#F06AA8'];
  const start = BASE.indexOf(S.accent) >= 0 ? BASE.indexOf(S.accent) : 0;
  const bgOf = i => BASE[(start + i * 3) % BASE.length];
  const CREAM = '#F3EBDD', INK = '#151515';
  const FONTS = ["'Archivo Black'", 'Anton', "'DM Serif Display'", "'Courier Prime'", 'Inter'];
  document.head.insertAdjacentHTML('beforeend', `<style>
    #stage{background:${bgOf(0)};font-family:Inter,sans-serif}
    .sheet{position:absolute;left:-300px;top:-400px;width:1700px;height:2800px}
    .scene{position:absolute;inset:0}
    .area{position:absolute;left:70px;right:70px;top:230px;height:930px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .ransom{display:flex;flex-wrap:wrap;justify-content:center;gap:10px 6px;max-width:940px}
    .ransom .gap{width:34px}
    .ch{display:inline-block;padding:4px 12px 0;line-height:1.05;box-shadow:3px 5px 0 #0000002e}
    .cut{position:relative;background:${CREAM};padding:14px;box-shadow:0 18px 30px #00000040}
    .cut canvas{display:block}
    .tape{position:absolute;width:170px;height:54px;background:#f6e7b8cc;box-shadow:0 2px 4px #0002}
    .strip{background:${CREAM};padding:20px 34px;font-family:'Courier Prime',monospace;font-weight:700;font-size:54px;color:${INK};margin:14px 0;box-shadow:0 10px 18px #0003;text-align:left}
    .blob{position:absolute;border-radius:50%}
    .sticker{display:inline-block;font-size:150px;filter:drop-shadow(5px 0 0 #fff) drop-shadow(-5px 0 0 #fff) drop-shadow(0 5px 0 #fff) drop-shadow(0 -5px 0 #fff) drop-shadow(0 10px 14px #0005)}
    .papercard{background:${CREAM};padding:60px 56px;box-shadow:0 18px 34px #00000045;position:relative}
    .qt{font-family:'DM Serif Display',serif;font-size:84px;line-height:1.05;color:${INK}}
    .who{font-family:'Courier Prime',monospace;font-weight:700;font-size:42px;margin-top:26px;color:${INK}}
    #cap{position:absolute;left:0;right:0;top:1250px;display:flex;justify-content:center}
    #cap .box{background:${INK};padding:12px 30px 6px;font-family:Anton,sans-serif;font-size:92px;line-height:1.1;color:#fff;text-transform:uppercase;letter-spacing:.01em;box-shadow:6px 8px 0 #00000040;max-width:900px;text-align:center}
    #cap .on{color:#FFE14D}
    #grain{position:absolute;inset:0;pointer-events:none;mix-blend-mode:multiply;opacity:.22}
    #vig{position:absolute;inset:0;pointer-events:none;background:radial-gradient(1300px 1900px at 50% 45%,transparent 55%,#0000004d 100%)}
  </style>`);

  // ---------- helpers ----------
  const torn = (n = 26, amp = 1.2) => { const r = rng(Math.floor(R() * 1e6)); const pts = []; for (let k = 0; k <= n; k++) pts.push(`${(k / n) * 100}% ${r() * amp}%`); for (let k = n; k >= 0; k--) pts.push(`${(k / n) * 100}% ${100 - r() * amp}%`); return `polygon(${pts.join(',')})`; };
  function ransom(parent, text, size = 120) {
    const box = el('div', 'ransom', parent), chars = [];
    const words = String(text || '').toUpperCase().split(/\s+/).filter(Boolean);
    const longest = Math.max(...words.map(w => w.length), 3);
    size = Math.min(size, Math.floor(860 / (longest * 0.82)));
    words.forEach((w, wi) => {
      const word = el('span', '', box); word.style.display = 'inline-flex'; word.style.gap = '4px';
      for (const c of w) {
        const s = el('span', 'ch', word, esc(c));
        const bgPick = R();
        const bg = bgPick < 0.3 ? '#fff' : bgPick < 0.55 ? INK : bgPick < 0.75 ? CREAM : bgPick < 0.88 ? '#FFE14D' : BASE[Math.floor(R() * BASE.length)];
        s.style.background = bg; s.style.color = (bg === INK || BASE.includes(bg)) ? '#fff' : INK;
        s.style.fontFamily = FONTS[Math.floor(R() * FONTS.length)]; s.style.fontWeight = '900';
        s.style.fontSize = Math.round(size * (0.85 + R() * 0.3)) + 'px';
        s._rot = (R() - 0.5) * 14; s._dy = (R() - 0.5) * 16;
        chars.push(s);
      }
      if (wi < words.length - 1) el('span', 'gap', box);
    });
    return local => chars.forEach((s, k) => {
      const p = E.outBack(inv(0.05 + k * 0.035, 0.3 + k * 0.035, local), 2.2);
      const jit = (hash(Math.floor(local * 8), k) - 0.5) * 2.2;
      s.style.transform = `translateY(${s._dy}px) rotate(${s._rot + jit}deg) scale(${p})`;
    });
  }
  async function halftone(src, w, h, cell = 9, paper = CREAM) {
    const img = await loadImage(src); if (!img) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d');
    const s = Math.max(w / img.width, h / img.height), iw = img.width * s, ih = img.height * s;
    const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h;
    const tg = tmp.getContext('2d'); tg.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih);
    const d = tg.getImageData(0, 0, w, h).data;
    if (paper) { g.fillStyle = paper; g.fillRect(0, 0, w, h); }        // paper = null → dots only, the colour field shows through
    g.fillStyle = INK;
    for (let y = 0; y < h; y += cell) for (let x = (y / cell) % 2 ? cell / 2 : 0; x < w; x += cell) {
      const i = (Math.min(h - 1, Math.floor(y)) * w + Math.min(w - 1, Math.floor(x))) * 4;
      let L = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) / 255;
      L = clamp((L - 0.5) * 1.5 + 0.5);                      // punchy contrast
      const r = (1 - L) * cell * 0.62;
      if (r > 0.4) { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); }
    }
    return c;
  }
  function cutout(parent, canvas, rot) {
    const card = el('div', 'cut', parent); card.appendChild(canvas);
    card.style.clipPath = torn(30, 1.4);
    const t1 = el('div', 'tape', parent), t2 = el('div', 'tape', parent);
    return { card, tapes: [t1, t2], rot };
  }

  // ---------- kinds ----------
  const pending = [];
  // The photo is printed as a FULL-SCREEN halftone straight onto the scene's colour field (no card, no frame),
  // and keeps moving: a slow push with stop-motion jitter. Behind stats/stickers it sits fainter.
  function photoLayer(root, v, i, big) {
    if (!v.img) return null;
    const scene = root.parentElement;
    const layer = el('div', '', scene); layer.style.cssText = `position:absolute;inset:-4%;opacity:${big ? 1 : 0.42};mix-blend-mode:multiply`;
    scene.insertBefore(layer, root);
    const state = { ready: false };
    pending.push(halftone(v.img, 1140, 2020, big ? 13 : 15, null).then(c => {
      if (!c) return;
      c.style.cssText = 'width:100%;height:100%;display:block'; layer.appendChild(c); state.ready = true;
    }));
    const dir = i % 2 ? 1 : -1;
    return (local, dur = 4) => {
      if (!state.ready) return;
      const p = clamp(local / dur), wipe = E.outExpo(inv(0, 0.45, local));
      const jit = (hash(Math.floor(local * 8), i) - 0.5) * 1.4;          // stop-motion (8 fps) wobble
      layer.style.transform = `translateX(${dir * 30 * p + jit * 3}px) scale(${1.02 + 0.08 * p}) rotate(${jit * 0.4}deg)`;
      layer.style.clipPath = `inset(0 ${(1 - wipe) * 100}% 0 0)`;          // printed on with a wipe
    };
  }

  const KINDS = {
    headline(root, v) { return ransom(root, v.heading || '', 130); },
    image(root, v, i) {
      const ph = photoLayer(root, v, i, true);
      let rs = null; if (v.heading) { const b = el('div', '', root); b.style.cssText = 'position:absolute;left:0;right:0;top:40px;display:flex;justify-content:center'; rs = ransom(b, v.heading, 110); }
      return (l, d) => { ph?.(l, d); rs?.(l - 0.5); };
    },
    stat(root, v, i) {
      const ph = photoLayer(root, v, i, false);
      const top = el('div', '', root); top.style.cssText = `position:absolute;left:0;right:0;top:420px;display:flex;flex-direction:column;align-items:center`;
      const holder = el('div', '', top), lab = el('div', 'strip', top, esc(v.label || ''));
      const target = Number(v.value) || 0;
      const num = el('div', 'ransom', holder);
      return local => {
        ph?.(local);
        const p = E.outExpo(inv(0.2, 1.6, local)), txt = (v.prefix || '') + fmtNum(target * p, target) + (v.suffix || '');
        if (num.dataset.t !== txt) {
          num.dataset.t = txt; num.innerHTML = '';
          [...txt].forEach((c, k) => { const s = el('span', 'ch', num, esc(c)); const r = rng(k * 31 + i); const bg = [INK, '#fff', '#FFE14D', CREAM][k % 4]; s.style.cssText += `;background:${bg};color:${bg === INK ? '#fff' : INK};font-family:${FONTS[Math.floor(r() * 3)]};font-size:${170 + r() * 24}px;transform:rotate(${(r() - 0.5) * 10}deg)`; });
        }
        num.style.transform = `scale(${E.outBack(inv(0.1, 0.45, local))})`;
        const lp = E.outCubic(inv(0.6, 1, local)); lab.style.transform = `rotate(-2deg) translateX(${(1 - lp) * -1100}px)`;
      };
    },
    list(root, v, i, dur) {
      const head = v.heading ? ransom(root, v.heading, 90) : null;
      const items = (v.items || []).slice(0, 4).map((t, k) => { const s = el('div', 'strip', root, `${k + 1}. ${esc(t)}`); s._rot = (k % 2 ? 1.6 : -1.8); s.style.clipPath = torn(16, 6); return s; });
      const step = Math.max(0.45, (dur - 0.8) / Math.max(1, items.length));
      return local => { head?.(local); items.forEach((s, k) => { const p = E.outExpo(inv(0.3 + k * step, 0.65 + k * step, local)); s.style.transform = `translateX(${(1 - p) * (k % 2 ? 1100 : -1100)}px) rotate(${s._rot}deg)`; }); };
    },
    compare(root, v, i) {
      const head = v.heading ? ransom(root, v.heading, 80) : null;
      const row = el('div', '', root); row.style.cssText = 'display:flex;gap:40px;align-items:center;margin-top:40px';
      const mk = (txt, bg, fg) => { const c = el('div', 'papercard', row); c.style.cssText += `;background:${bg};width:300px;height:420px;display:flex;align-items:center;justify-content:center;font-family:'Archivo Black';font-size:64px;line-height:1;color:${fg};text-transform:uppercase`; c.textContent = txt; return c; };
      const L = mk(v.left || '', CREAM, INK);
      const vs = el('div', '', row); vs.style.cssText = `font-family:Anton;font-size:120px;color:#fff;background:${INK};padding:8px 26px;transform:rotate(-8deg)`; vs.textContent = 'VS';
      const Rr = mk(v.right || '', INK, '#fff');
      return local => { head?.(local); const a = E.outBack(inv(0.1, 0.5, local)), b = E.outBack(inv(0.3, 0.7, local)), c = E.outBack(inv(0.55, 0.85, local), 3);
        L.style.transform = `rotate(${-5 * a}deg) translateY(${(1 - a) * 900}px)`; Rr.style.transform = `rotate(${4 * b}deg) translateY(${(1 - b) * -1200}px)`; vs.style.transform = `rotate(-8deg) scale(${c})`; };
    },
    icons(root, v, i) {
      const ph = photoLayer(root, v, i, false);
      const head = v.heading ? (() => { const b = el('div', '', root); b.style.cssText = `position:absolute;left:0;right:0;top:330px;display:flex;justify-content:center`; return ransom(b, v.heading, 96); })() : null;
      const row = el('div', '', root); row.style.cssText = `position:absolute;left:60px;right:60px;top:640px;display:flex;flex-wrap:wrap;justify-content:center;gap:30px`;
      const st = (v.emoji || []).slice(0, 6).map(e => { const s = el('span', 'sticker', row, e); s._r = (R() - 0.5) * 30; return s; });
      return local => { ph?.(local); head?.(local - 0.3); st.forEach((s, k) => { const p = E.outBack(inv(0.2 + k * 0.12, 0.5 + k * 0.12, local), 2.6); const jit = (hash(Math.floor(local * 6), k + 9) - 0.5) * 6; s.style.transform = `rotate(${s._r + jit}deg) scale(${p})`; }); };
    },
    quote(root, v) {
      const card = el('div', 'papercard', root); card.style.maxWidth = '820px'; card.style.clipPath = torn(24, 1.5);
      el('div', 'qt', card, '“' + esc(v.heading || '') + '”'); if (v.label) el('div', 'who', card, '— ' + esc(v.label));
      const tape = el('div', 'tape', root); tape.style.cssText += ';top:300px;left:440px;transform:rotate(4deg)';
      return local => { const p = spring(local, { freq: 1.5, zeta: 0.6 }); card.style.transform = `rotate(${-2 + (1 - p) * 20}deg) translateY(${(1 - p) * 1100}px)`; tape.style.opacity = inv(0.5, 0.6, local); };
    },
    timeline(root, v, i, dur) {
      const items = (v.items || []).slice(0, 4);
      const step = Math.max(0.45, (dur - 0.8) / Math.max(1, items.length));
      const rows = items.map((t, k) => { const [yr, ...rest] = t.split(/\s+[—–-]\s+/); const r = el('div', '', root); r.style.cssText = 'display:flex;align-items:center;gap:22px;margin:16px 0'; const y = el('span', 'ch', r, esc(yr)); y.style.cssText += `;background:${k % 2 ? INK : '#FFE14D'};color:${k % 2 ? '#fff' : INK};font-family:Anton;font-size:84px`; el('span', 'strip', r, esc(rest.join(' — '))).style.margin = '0'; return r; });
      return local => rows.forEach((r, k) => { const p = E.outExpo(inv(0.25 + k * step, 0.6 + k * step, local)); r.style.transform = `translateX(${(1 - p) * -1200}px) rotate(${k % 2 ? 1 : -1}deg)`; });
    },
    drawing(root, v) {
      const card = el('div', 'papercard', root); card.style.padding = '30px';
      card.innerHTML = `<svg viewBox="0 0 400 400" width="660" height="660">${v.svg || ''}</svg>`;
      const head = v.heading ? (() => { const b = el('div', '', root); b.style.marginTop = '30px'; return ransom(b, v.heading, 80); })() : null;
      return local => { const p = spring(local, { freq: 1.6, zeta: 0.6 }); card.style.transform = `rotate(${3 - 6 * p}deg) translateY(${(1 - p) * 1000}px)`; head?.(local - 0.4); };
    },
  };
  KINDS.model3d = KINDS.headline;

  // ---------- build ----------
  const built = scenes.map((sc, i) => {
    const sheet = el('div', 'sheet'); sheet.style.background = bgOf(i); sheet.style.clipPath = torn(40, 0.6); sheet.style.zIndex = String(i * 2);
    const root = el('div', 'scene'); root.style.zIndex = String(i * 2 + 1);
    const area = el('div', 'area', root);
    let v = sc.visual || { kind: 'headline' };
    if (!KINDS[v.kind] || (v.kind === 'image' && !v.img)) v = { ...v, kind: 'headline', heading: v.heading || sc.narration.split(/\s+/).slice(0, 4).join(' ') };
    const upd = KINDS[v.kind](area, v, i, sc.end - sc.start);
    return { sheet, root, upd, i };
  });
  const grain = el('canvas'); grain.id = 'grain'; grain.width = W / 2; grain.height = H / 2;
  { const g = grain.getContext('2d'), id = g.createImageData(grain.width, grain.height), r = rng(7); for (let k = 0; k < id.data.length; k += 4) { const v = 200 + r() * 55; id.data[k] = id.data[k + 1] = id.data[k + 2] = v; id.data[k + 3] = 255; } g.putImageData(id, 0, 0); grain.style.width = W + 'px'; grain.style.height = H + 'px'; grain.style.zIndex = '900'; }
  const vig = el('div'); vig.id = 'vig'; vig.style.zIndex = '901';
  const cap = el('div'); cap.id = 'cap'; cap.style.zIndex = '950';
  const chunks = buildChunks(S.words, 3, 16);

  window.DUR = S.duration;
  window.__ready = Promise.all([document.fonts.ready, ...pending]);
  window.render = t => {
    built.forEach(({ sheet, root, upd, i }) => {
      const s = scenes[i];
      const inP = i === 0 ? 1 : E.outExpo(inv(s.start - 0.12, s.start + 0.38, t));
      const visible = t >= s.start - 0.15 && t < (scenes[i + 1] ? scenes[i + 1].start + 0.45 : Infinity);
      sheet.style.display = root.style.display = visible ? '' : 'none';
      if (!visible) return;
      sheet.style.transform = `rotate(-9deg) translate(${(1 - inP) * 1900}px, ${(1 - inP) * 500}px)`;
      const next = scenes[i + 1];
      const out = next ? E.inCubic(inv(next.start - 0.1, next.start + 0.3, t)) : 0;
      root.style.transform = `translate(${(1 - inP) * 1900 - out * 400}px, ${(1 - inP) * 500}px) rotate(${(1 - inP) * -9}deg)`;
      upd(Math.max(0, t - s.start), s.end - s.start);
    });
    const hit = chunkAt(chunks, t);
    if (!hit) cap.style.opacity = '0'; else {
      if (cap.dataset.k !== String(hit.k)) { cap.innerHTML = `<div class="box">${hit.c.idx.map(j => `<span>${esc(S.words[j].word)}</span>`).join(' ')}</div>`; cap.dataset.k = hit.k; }
      const spans = cap.querySelectorAll('span');
      hit.c.idx.forEach((j, m) => spans[m].classList.toggle('on', t >= S.words[j].start - 0.03 && t < S.words[j].end + 0.1));
      const p = E.outBack(inv(hit.c.start - 0.06, hit.c.start + 0.12, t), 2);
      cap.style.opacity = '1'; cap.firstChild.style.transform = `rotate(${(hit.k % 2 ? 1.5 : -1.5)}deg) scale(${p})`;
    }
  };
})();
