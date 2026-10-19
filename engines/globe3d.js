// GLOBE3D — a real 3D Earth (Three.js): Natural Earth coastlines, atmosphere glow, star field.
// The camera flies to each scene's places; pins pulse, labels track, great-circle arcs draw between places.
(function () {
  const { S, W, H, clamp, lerp, inv, E, spring, hash, el, esc, fmtNum, buildChunks, chunkAt, isKey, scenes, phase } = FS;
  const T3 = window.THREE, ACC = S.accent || '#FFD23F';
  document.head.insertAdjacentHTML('beforeend', `<style>
    #stage{background:#030814;font-family:Inter,sans-serif;color:#fff}
    #gl{position:absolute;inset:0}
    .scene{position:absolute;inset:0;z-index:5;background:linear-gradient(#030814e6 0%,#03081499 30%,#03081400 48%)}
    .area{position:absolute;left:70px;right:70px;top:220px;height:560px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center}
    .glass{background:rgba(10,22,48,.62);border:2px solid rgba(140,200,255,.35);border-radius:30px;box-shadow:0 20px 60px #0008,inset 0 1px 0 rgba(255,255,255,.15)}
    .hd{font-weight:900;letter-spacing:-.03em;line-height:.98;text-shadow:0 6px 30px #000c}
    .hd .em{color:${ACC}}
    .num{font-weight:900;font-size:220px;letter-spacing:-.05em;line-height:1;color:${ACC};text-shadow:0 0 50px ${ACC}66}
    .lb{font-weight:700;font-size:52px;color:#cfe3ff;margin-top:12px}
    .it{display:flex;gap:24px;align-items:center;width:820px;padding:24px 32px;margin:9px 0;font-weight:800;font-size:50px;text-align:left}
    .it b{color:${ACC};font-size:56px;min-width:60px}
    .pin{position:absolute;z-index:6;transform:translate(-50%,-140%);white-space:nowrap;font-weight:800;font-size:44px;color:#0b1020;background:#fff;padding:10px 26px;border-radius:999px;box-shadow:0 10px 30px #0008}
    .pin:after{content:'';position:absolute;left:50%;bottom:-16px;margin-left:-12px;border:12px solid transparent;border-top:16px solid #fff}
    .plh{position:absolute;left:0;right:0;top:230px;text-align:center;z-index:6}
    #cap{position:absolute;left:50px;right:50px;top:1300px;text-align:center;font-weight:900;font-size:86px;line-height:1.04;text-shadow:0 0 26px #000,0 6px 18px #000c;z-index:20}
    #cap .on{color:${ACC}}
  </style>`);

  // ---------- three.js scene ----------
  const canvas = el('canvas'); canvas.id = 'gl'; canvas.width = W; canvas.height = H;
  const renderer = new T3.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
  renderer.setPixelRatio(1); renderer.setSize(W, H, false); renderer.setClearColor(0x030814, 1);
  const scene = new T3.Scene();
  const camera = new T3.PerspectiveCamera(36, W / H, 0.01, 200);

  // texture: ocean, graticule, land, glowing coastline
  const tex = document.createElement('canvas'); tex.width = 4096; tex.height = 2048; const tg = tex.getContext('2d');
  const og = tg.createLinearGradient(0, 0, 0, 2048); og.addColorStop(0, '#0B3B7A'); og.addColorStop(0.5, '#1557A8'); og.addColorStop(1, '#0B3B7A');
  tg.fillStyle = og; tg.fillRect(0, 0, 4096, 2048);
  tg.strokeStyle = 'rgba(160,215,255,0.16)'; tg.lineWidth = 2;
  for (let lo = -180; lo <= 180; lo += 15) { const x = (lo + 180) / 360 * 4096; tg.beginPath(); tg.moveTo(x, 0); tg.lineTo(x, 2048); tg.stroke(); }
  for (let la = -75; la <= 75; la += 15) { const y = (90 - la) / 180 * 2048; tg.beginPath(); tg.moveTo(0, y); tg.lineTo(4096, y); tg.stroke(); }
  const P = ([lo, la]) => [(lo + 180) / 360 * 4096, (90 - la) / 180 * 2048];
  tg.fillStyle = '#3FB06E'; tg.strokeStyle = '#B9FFD6'; tg.lineWidth = 4; tg.lineJoin = 'round';
  for (const ring of window.LAND || []) { tg.beginPath(); ring.forEach((pt, k) => { const [x, y] = P(pt); k ? tg.lineTo(x, y) : tg.moveTo(x, y); }); tg.closePath(); tg.fill(); tg.stroke(); }
  const map = new T3.CanvasTexture(tex); map.colorSpace = T3.SRGBColorSpace; map.anisotropy = 8;
  const earth = new T3.Mesh(new T3.SphereGeometry(1, 128, 64), new T3.MeshPhongMaterial({ map, shininess: 14, specular: new T3.Color(0x335577) }));
  scene.add(earth);
  // atmosphere (fresnel rim)
  const atmo = new T3.Mesh(new T3.SphereGeometry(1.1, 96, 48), new T3.ShaderMaterial({
    side: T3.BackSide, transparent: true, blending: T3.AdditiveBlending, depthWrite: false,
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying vec3 vN; void main(){ float i = pow(0.72 - dot(vN, vec3(0.0,0.0,1.0)), 3.2); gl_FragColor = vec4(0.35,0.72,1.0,1.0) * i * 1.6; }',
  }));
  scene.add(atmo);
  scene.add(new T3.AmbientLight(0xffffff, 0.55));
  const sun = new T3.DirectionalLight(0xffffff, 1.9); scene.add(sun);
  // stars
  { const n = 2200, pos = new Float32Array(n * 3); for (let k = 0; k < n; k++) { const u = hash(k, 1) * 2 - 1, a = hash(k, 2) * Math.PI * 2, r = 60; pos[k * 3] = Math.sqrt(1 - u * u) * Math.cos(a) * r; pos[k * 3 + 1] = u * r; pos[k * 3 + 2] = Math.sqrt(1 - u * u) * Math.sin(a) * r; }
    const gm = new T3.BufferGeometry(); gm.setAttribute('position', new T3.BufferAttribute(pos, 3));
    scene.add(new T3.Points(gm, new T3.PointsMaterial({ color: 0xffffff, size: 0.12, sizeAttenuation: true, transparent: true, opacity: 0.85 }))); }

  const vec = (lat, lon, r = 1) => { const ph = (90 - lat) * Math.PI / 180, th = (lon + 180) * Math.PI / 180; return new T3.Vector3(-r * Math.sin(ph) * Math.cos(th), r * Math.cos(ph), r * Math.sin(ph) * Math.sin(th)); };

  // ---------- per-scene content ----------
  const placesOf = v => (v.places || []).filter(p => Number.isFinite(+p.lat) && Number.isFinite(+p.lon)).slice(0, 5).map(p => ({ name: p.name, lat: +p.lat, lon: +p.lon }));
  const accentColor = new T3.Color(ACC);
  const built = scenes.map((sc, i) => {
    const v = sc.visual || {};
    const places = placesOf(v);
    const root = el('div', 'scene');
    const pins = places.map(p => {
      const g = new T3.Group(), pos = vec(p.lat, p.lon, 1.002);
      g.position.copy(pos); g.lookAt(pos.clone().multiplyScalar(2));
      const head = new T3.Mesh(new T3.SphereGeometry(0.018, 16, 12), new T3.MeshBasicMaterial({ color: accentColor })); g.add(head);
      const ring = new T3.Mesh(new T3.RingGeometry(0.03, 0.04, 48), new T3.MeshBasicMaterial({ color: accentColor, transparent: true, side: T3.DoubleSide })); g.add(ring);
      g.visible = false; scene.add(g);
      const label = el('div', 'pin', document.getElementById('stage'), esc(p.name)); label.style.display = 'none';
      return { p, g, ring, label, pos };
    });
    const arcs = [];
    for (let k = 1; k < places.length; k++) {
      const a = vec(places[k - 1].lat, places[k - 1].lon), b = vec(places[k].lat, places[k].lon);
      const pts = []; for (let s = 0; s <= 64; s++) { const f = s / 64, q = a.clone().lerp(b, f).normalize(); pts.push(q.multiplyScalar(1 + 0.18 * Math.sin(Math.PI * f) * a.distanceTo(b) / 2)); }
      const geo = new T3.TubeGeometry(new T3.CatmullRomCurve3(pts), 64, 0.006, 8, false);
      const mesh = new T3.Mesh(geo, new T3.MeshBasicMaterial({ color: accentColor })); mesh.visible = false; scene.add(mesh);
      arcs.push({ mesh, count: geo.index.count });
    }
    let upd = null;
    if (!places.length || v.kind !== 'map') upd = overlay(el('div', 'area', root), v, sc);
    else if (v.heading) { const h = el('div', 'plh hd', root, esc(v.heading)); h.style.fontSize = '96px'; upd = l => { h.style.transform = `scale(${E.outBack(inv(0, 0.4, l))})`; }; }
    // camera target for this scene
    const tgt = places.length
      ? { lat: places.reduce((s, p) => s + p.lat, 0) / places.length, lon: places.length > 1 ? midLon(places) : places[0].lon, dist: places.length > 1 ? 2.3 + spread(places) * 1.2 : 1.85, cy: 830 }
      : { lat: 18, lon: null, dist: 4.9, cy: 1180 };
    return { root, pins, arcs, upd, tgt, map: places.length > 0 && v.kind === 'map' };
  });
  function midLon(ps) { let x = 0, y = 0; ps.forEach(p => { x += Math.cos(p.lon * Math.PI / 180); y += Math.sin(p.lon * Math.PI / 180); }); return Math.atan2(y, x) * 180 / Math.PI; }
  function spread(ps) { let m = 0; for (const a of ps) for (const b of ps) m = Math.max(m, vec(a.lat, a.lon).distanceTo(vec(b.lat, b.lon))); return m; }

  function overlay(a, v, sc) {
    const dur = sc.end - sc.start;
    switch (v.kind) {
      case 'stat': { const n = el('div', 'num', a), lb = el('div', 'lb', a, esc(v.label || '')), target = Number(v.value) || 0;
        return l => { n.textContent = `${v.prefix || ''}${fmtNum(target * E.outExpo(inv(0.15, 1.6, l)), target)}${v.suffix || ''}`; n.style.transform = `scale(${0.7 + 0.3 * spring(l, { freq: 2, zeta: 0.55 })})`; lb.style.opacity = String(inv(0.5, 0.8, l)); }; }
      case 'list': case 'timeline': { if (v.heading) el('div', 'hd', a, esc(v.heading)).style.cssText += ';font-size:76px;margin-bottom:16px';
        const its = (v.items || []).slice(0, 4).map((t, k) => el('div', 'it glass', a, `<b>${String(k + 1).padStart(2, '0')}</b><span>${esc(t)}</span>`)), step = Math.max(0.45, (dur - 0.8) / Math.max(1, its.length));
        return l => its.forEach((it, k) => { const p = spring(l - 0.3 - k * step, { freq: 2.2, zeta: 0.65 }); it.style.opacity = String(clamp(p * 1.4)); it.style.transform = `translateY(${(1 - p) * 60}px)`; }); }
      case 'compare': { const row = el('div', '', a); row.style.cssText = 'display:flex;gap:30px;align-items:center';
        const mk = (t, c) => { const d = el('div', 'glass hd', row, esc(t)); d.style.cssText += `;width:380px;height:300px;display:flex;align-items:center;justify-content:center;font-size:66px;padding:20px;box-sizing:border-box;border-color:${c}`; return d; };
        const L = mk(v.left || '', 'rgba(140,200,255,.5)'); const vs = el('div', 'hd', row, 'VS'); vs.style.cssText += `;font-size:80px;color:${ACC}`; const R = mk(v.right || '', ACC);
        if (v.heading) { const h = el('div', 'hd', a, esc(v.heading)); h.style.cssText += ';font-size:70px;order:-1;margin-bottom:24px'; }
        return l => { L.style.transform = `translateX(${(1 - E.outExpo(inv(0, 0.5, l))) * -700}px)`; R.style.transform = `translateX(${(1 - E.outExpo(inv(0.2, 0.7, l))) * 700}px)`; vs.style.transform = `scale(${E.outBack(inv(0.5, 0.8, l), 3)})`; }; }
      case 'icons': { if (v.heading) el('div', 'hd', a, esc(v.heading)).style.cssText += ';font-size:76px;margin-bottom:20px';
        const row = el('div', '', a); row.style.cssText = 'display:flex;gap:22px;flex-wrap:wrap;justify-content:center';
        const em = (v.emoji || []).slice(0, 6).map(e => { const d = el('div', 'glass', row, e); d.style.cssText += ';width:170px;height:170px;font-size:100px;display:flex;align-items:center;justify-content:center'; return d; });
        return l => em.forEach((e, k) => { e.style.transform = `scale(${E.outBack(inv(0.2 + k * 0.12, 0.5 + k * 0.12, l), 2.4)})`; }); }
      case 'quote': { const q = el('div', 'glass hd', a, '“' + esc(v.heading || '') + '”'); q.style.cssText += ';font-size:70px;padding:44px 48px;max-width:860px';
        const w = v.label ? el('div', 'lb', a, '— ' + esc(v.label)) : null; return l => { q.style.transform = `scale(${E.outBack(inv(0, 0.4, l))})`; if (w) w.style.opacity = String(inv(0.5, 0.8, l)); }; }
      case 'image': if (v.img) { const c = el('div', 'glass', a); c.style.cssText += ';padding:14px;overflow:hidden'; const im = el('img', '', c); im.src = v.img; im.style.cssText = 'display:block;width:760px;height:520px;object-fit:cover;border-radius:20px';
        return l => { c.style.transform = `scale(${0.85 + 0.15 * spring(l, { freq: 1.6, zeta: 0.7 })})`; im.style.transform = `scale(${1.05 + 0.08 * l / dur})`; }; } // falls through
      default: { const words = (v.heading || (v.places || []).map(p => p.name).join(' · ') || sc.narration.split(/\s+/).slice(0, 4).join(' ')).split(/\s+/);
        const h = el('div', 'hd', a); const longest = Math.max(...words.map(w => w.length), 4); h.style.fontSize = Math.min(170, Math.floor(900 / (longest * 0.6))) + 'px';
        const em = (v.emphasis || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const sp = words.map(w => { const s = el('span', w.toLowerCase().replace(/[^a-z0-9]/g, '') === em ? 'em' : '', h, esc(w)); s.style.display = 'inline-block'; s.style.margin = '0 .13em'; return s; });
        return l => sp.forEach((s, k) => { const p = spring(l - 0.05 - k * 0.08, { freq: 2.3, zeta: 0.6 }); s.style.opacity = String(clamp(p * 1.5)); s.style.transform = `translateY(${(1 - p) * 60}px)`; }); }
    }
  }

  // ---------- camera ----------
  function camState(i, t) {
    const b = built[i].tgt;
    return { lat: b.lat, lon: b.lon ?? (-40 + i * 37 + t * 4), dist: b.dist, cy: b.cy };
  }
  const wrap180 = x => ((x + 540) % 360) - 180;
  function camera_at(t) {
    const { i } = FS.sceneAt(t), s = scenes[i];
    const cur = camState(i, t);
    if (i === 0) return cur;
    const prev = camState(i - 1, t);
    const p = E.inOutCubic(inv(s.start - 0.25, s.start + 1.0, t));
    return { lat: lerp(prev.lat, cur.lat, p), lon: prev.lon + wrap180(cur.lon - prev.lon) * p, dist: lerp(prev.dist, cur.dist, p) + Math.sin(Math.PI * p) * 0.9, cy: lerp(prev.cy, cur.cy, p) };
  }

  const cap = el('div'); cap.id = 'cap';
  const chunks = buildChunks(S.words, 3, 18);
  const proj = new T3.Vector3();

  window.DUR = S.duration;
  window.__ready = document.fonts.ready;
  window.render = t => {
    const c = camera_at(t);
    const pos = vec(c.lat, c.lon, c.dist);
    camera.position.copy(pos); camera.up.set(0, 1, 0); camera.lookAt(0, 0, 0);
    camera.setViewOffset(W, H, 0, H / 2 - c.cy, W, H); camera.updateProjectionMatrix();
    sun.position.copy(vec(c.lat + 25, c.lon - 40, 10));
    const { i } = FS.sceneAt(t);
    built.forEach((b, k) => {
      const s = scenes[k], local = t - s.start, active = k === i;
      b.root.style.display = active ? '' : 'none';
      if (active && b.upd) b.upd(Math.max(0, local), s.end - s.start);
      b.pins.forEach((pn, m) => {
        const appear = inv(0.5 + m * 0.5, 0.9 + m * 0.5, local);
        pn.g.visible = active && appear > 0;
        if (!pn.g.visible) { pn.label.style.display = 'none'; return; }
        const pulse = (local * 0.9 + m * 0.3) % 1;
        pn.ring.scale.setScalar(1 + pulse * 2.2); pn.ring.material.opacity = 1 - pulse;
        pn.g.scale.setScalar(E.outBack(appear, 2.5));
        proj.copy(pn.pos).project(camera);
        const facing = pn.pos.clone().normalize().dot(camera.position.clone().normalize()) > 0.25;
        pn.label.style.display = facing ? '' : 'none';
        pn.label.style.left = ((proj.x + 1) / 2 * W) + 'px'; pn.label.style.top = ((1 - proj.y) / 2 * H) + 'px';
        pn.label.style.opacity = String(inv(0.7 + m * 0.5, 1.0 + m * 0.5, local));
      });
      b.arcs.forEach((a, m) => { const p = E.inOutCubic(inv(1.0 + m * 0.6, 2.0 + m * 0.6, local)); a.mesh.visible = active && p > 0; a.mesh.geometry.setDrawRange(0, Math.floor(a.count * p / 3) * 3); });
    });
    renderer.render(scene, camera);
    const hit = chunkAt(chunks, t);
    if (!hit) cap.style.opacity = '0'; else {
      if (cap.dataset.k !== String(hit.k)) { cap.innerHTML = hit.c.idx.map(j => `<span>${esc(S.words[j].word)}</span>`).join(' '); cap.dataset.k = hit.k; }
      const sp = cap.children; hit.c.idx.forEach((j, q) => sp[q].classList.toggle('on', t >= S.words[j].start - 0.03 && t < S.words[j].end + 0.08));
      cap.style.opacity = '1'; cap.style.transform = `translateY(${(1 - E.outCubic(inv(hit.c.start - 0.05, hit.c.start + 0.15, t))) * 30}px)`;
    }
  };
})();
