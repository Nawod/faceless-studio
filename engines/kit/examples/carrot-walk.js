// EXAMPLE film (kit usage reference, not a template): a carrot walks through a parallax landscape,
// the sun waves hello, then morphs into a heart. Shows: master timeline, onFrame procedural rig, parallax,
// MorphSVG, staggered pops, lip-sync, blink, eyes that look, captions, grain.
const { W, H, tl, at, onFrame, svgLayer, el, rng } = Film;
const PAL = { sky0: '#FFE6C7', sky1: '#FFC9A3', hill1: '#F4A261', hill2: '#E76F51', hill3: '#8AB17D', ground: '#5E8C61', ink: '#2B2D42', carrot: '#F77F00', leaf: '#3A7D44', sun: '#FFD166' };

// ---------- sky ----------
const sky = svgLayer(0);
sky.innerHTML = `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${PAL.sky0}"/><stop offset="1" stop-color="${PAL.sky1}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#sky)"/>`;

// ---------- sun with a face → morphs into a heart ----------
const sunG = el('g', { transform: 'translate(780 430)' }, sky);
const rays = el('g', {}, sunG);
for (let k = 0; k < 12; k++) el('path', { d: 'M0,-150 L10,-200 L-10,-200 Z', fill: PAL.sun, transform: `rotate(${k * 30})` }, rays);
const sunBody = el('path', { d: 'M0,-120 C66,-120 120,-66 120,0 C120,66 66,120 0,120 C-66,120 -120,66 -120,0 C-120,-66 -66,-120 0,-120 Z', fill: PAL.sun, stroke: PAL.ink, 'stroke-width': 8 }, sunG);
const heart = 'M0,110 C-40,80 -120,30 -120,-30 C-120,-80 -80,-110 -45,-110 C-20,-110 -5,-95 0,-80 C5,-95 20,-110 45,-110 C80,-110 120,-80 120,-30 C120,30 40,80 0,110 Z';
const sunFace = el('g', {}, sunG, `<circle cx="-38" cy="-18" r="10" fill="${PAL.ink}"/><circle cx="38" cy="-18" r="10" fill="${PAL.ink}"/><path d="M-36,28 Q0,58 36,28" fill="none" stroke="${PAL.ink}" stroke-width="8" stroke-linecap="round"/>`);

// ---------- parallax hills (tile twice and scroll at different speeds = the camera is walking) ----------
function hills(color, baseY, amp, seed) {
  const r = rng(seed); let d = `M0,${H} L0,${baseY}`;
  for (let x = 0; x <= 2160; x += 180) d += ` Q${x + 90},${baseY - amp * (0.4 + r())} ${x + 180},${baseY}`;
  return `<path d="${d} L2160,${H} Z" fill="${color}"/>`;
}
const layers = [[PAL.hill1, 1180, 220, 1, 30], [PAL.hill2, 1290, 160, 2, 70], [PAL.hill3, 1400, 90, 3, 140]].map(([c, y, a, s, speed]) => {
  const g = el('g', {}, sky); g.innerHTML = hills(c, y, a, s) + `<g transform="translate(2160 0)">${hills(c, y, a, s)}</g>`; return { g, speed };
});
const ground = el('rect', { x: 0, y: 1500, width: W, height: 420, fill: PAL.ground }, sky);

// ---------- Carl the carrot (rig) ----------
const char = svgLayer(5);
const root = el('g', {}, char);
const legL = el('path', { fill: 'none', stroke: PAL.ink, 'stroke-width': 16, 'stroke-linecap': 'round' }, root);
const legR = el('path', { fill: 'none', stroke: PAL.ink, 'stroke-width': 16, 'stroke-linecap': 'round' }, root);
const shoeL = el('ellipse', { rx: 34, ry: 16, fill: PAL.ink }, root), shoeR = el('ellipse', { rx: 34, ry: 16, fill: PAL.ink }, root);
const body = el('g', {}, root);
const leaves = [-28, 0, 28].map((a, k) => el('path', { d: 'M0,0 C-30,-60 -10,-130 0,-170 C10,-130 30,-60 0,0 Z', fill: PAL.leaf, stroke: PAL.ink, 'stroke-width': 6 }, body));
el('path', { d: 'M-115,-300 C-120,-340 120,-340 115,-300 C110,-180 50,-20 10,40 C4,48 -4,48 -10,40 C-50,-20 -110,-180 -115,-300 Z', fill: PAL.carrot, stroke: PAL.ink, 'stroke-width': 8 }, body);
[-230, -150, -80].forEach((y, k) => el('path', { d: `M${-60 + k * 15},${y} q30,-8 50,0`, fill: 'none', stroke: '#C75D00', 'stroke-width': 6, 'stroke-linecap': 'round' }, body));
const eyeW = [-45, 45].map(x => el('ellipse', { cx: x, cy: -245, rx: 26, ry: 30, fill: '#fff', stroke: PAL.ink, 'stroke-width': 6 }, body));
const pupils = [-45, 45].map(x => el('circle', { cx: x, cy: -245, r: 12, fill: PAL.ink }, body));
const mouthP = el('path', { fill: '#7A1F2B', stroke: PAL.ink, 'stroke-width': 6, 'stroke-linejoin': 'round' }, body);
const armL = el('path', { fill: 'none', stroke: PAL.ink, 'stroke-width': 13, 'stroke-linecap': 'round' }, root);
const armR = el('path', { fill: 'none', stroke: PAL.ink, 'stroke-width': 13, 'stroke-linecap': 'round' }, root);
const handL = el('circle', { r: 18, fill: '#fff', stroke: PAL.ink, 'stroke-width': 6 }, root), handR = el('circle', { r: 18, fill: '#fff', stroke: PAL.ink, 'stroke-width': 6 }, root);

// ---------- story beats on the master timeline ----------
tl.from(sunG, { scale: 0, rotation: -90, transformOrigin: '780px 430px', duration: 0.8, ease: 'back.out(2.2)' }, at(1, 0.05));
tl.to(sunG, { y: -40, duration: 0.25, yoyo: true, repeat: 3, ease: 'sine.inOut' }, at(1, 0.6));          // "hello" bounce
tl.to(sunFace, { opacity: 0, duration: 0.2 }, at(2, 0.2));
tl.to(rays, { scale: 0, transformOrigin: '0 0', duration: 0.35, ease: 'back.in(2)' }, at(2, 0.2));
tl.to(sunBody, { morphSVG: heart, fill: '#EF476F', duration: 0.7, ease: 'elastic.out(1, .5)' }, at(2, 0.35));
const pops = Array.from({ length: 6 }, (_, k) => el('path', { d: heart, fill: '#EF476F', transform: `translate(${300 + k * 90} ${700 - (k % 2) * 80}) scale(0.18)`, opacity: 0 }, sky));
tl.to(pops, { opacity: 1, y: -160, duration: 0.9, stagger: 0.08, ease: 'power2.out' }, at(2, 0.8));
tl.to(pops, { opacity: 0, duration: 0.3, stagger: 0.08 }, at(2, 1.5));

// ---------- per-frame: walking rig, parallax, face ----------
onFrame(t => {
  const walking = t < at(2, 0.3);                                           // he stops when the heart appears
  const w = walking ? Rig.walk(t, { speed: 1.4, stride: 80, lift: 36, legLen: 150 }) : { feet: [{ x: -30, y: 150 }, { x: 30, y: 150 }], hands: [{ x: 0, y: 0 }, { x: 0, y: 0 }], bob: Rig.idle(t).bob, squash: 1 };
  const hipX = 540, hipY = 1340 + w.bob;
  root.setAttribute('transform', `translate(${hipX} ${hipY})`);
  body.setAttribute('transform', `scale(${1 / w.squash} ${w.squash})`);
  legL.setAttribute('d', Rig.hose([-30, 20], [w.feet[0].x - 30, w.feet[0].y], 165, -1));
  legR.setAttribute('d', Rig.hose([30, 20], [w.feet[1].x + 30, w.feet[1].y], 165, 1));
  shoeL.setAttribute('cx', w.feet[0].x - 30 - 10); shoeL.setAttribute('cy', w.feet[0].y + 4);
  shoeR.setAttribute('cx', w.feet[1].x + 30 + 10); shoeR.setAttribute('cy', w.feet[1].y + 4);
  // arms: swing while walking, wave hello when the sun appears, hug-pose at the heart
  const wave = t > at(1, 0.4) && t < at(2, 0.2) ? Math.sin(t * 14) * 40 : 0;
  const love = t > at(2, 0.5);
  const hl = love ? [-60, -230] : [-150 + w.hands[0].x, -40];
  const hr = love ? [60, -230] : wave ? [190, -300 + wave] : [150 + w.hands[1].x, -40];
  armL.setAttribute('d', Rig.hose([-100, -160], hl, 150, 1)); armR.setAttribute('d', Rig.hose([100, -160], hr, 150, -1));
  handL.setAttribute('cx', hl[0]); handL.setAttribute('cy', hl[1]); handR.setAttribute('cx', hr[0]); handR.setAttribute('cy', hr[1]);
  leaves.forEach((lf, k) => lf.setAttribute('transform', `translate(0 -322) rotate(${[-28, 0, 28][k] + Math.sin(t * 6 + k) * (walking ? 8 : 3)})`));
  // face: blink, look at the sun/heart, lip-sync to the voice
  const open = Rig.blink(t, 2);
  eyeW.forEach(e => e.setAttribute('ry', 30 * Math.max(0.08, open)));
  const target = t > at(1, 0.2) ? [240, -910] : [0, -100];
  pupils.forEach((p, k) => { const [x, y] = Rig.look([[-45, 45][k], -245], target, 12); p.setAttribute('cx', x); p.setAttribute('cy', y); p.setAttribute('r', open < 0.3 ? 0 : 12); });
  mouthP.setAttribute('d', Rig.mouth(0, -175, 64, Film.talk(t), love ? 1.4 : 1));
  // parallax: the world scrolls while he walks
  const travel = Math.min(t, at(2, 0.3));
  layers.forEach(({ g, speed }) => g.setAttribute('transform', `translate(${-((travel * speed) % 2160)} 0)`));
  rays.setAttribute('transform', `rotate(${t * 12})`);
});

Film.captions({ style: 'pop', y: 240 });   // sky is empty up top; keep words out of YouTube's bottom UI
Film.grain({ opacity: 0.07 });
Film.vignette({ strength: 0.25 });
