// MOTION — a shared "camera operator" layered on top of every style (wraps window.render, like brand.js).
// Hook slam on frame one, a punch-in on every cut, a pulse on every key word / number as it is spoken,
// and a constant handheld drift — so no frame is ever perfectly still. Captions and the logo stay steady.
(function () {
  const { S, inv, E, noise1, isKey, scenes } = FS;
  const stage = document.getElementById('stage');
  const KEEP = new Set(['cap', 'big', 'wm', 'end', 'flash', 'grain', 'vig', 'shade']);
  const cam = document.createElement('div');
  cam.id = 'cam';
  cam.style.cssText = 'position:absolute;inset:0;transform-origin:50% 42%;will-change:transform';
  [...stage.children].filter(c => !KEEP.has(c.id)).forEach(c => cam.appendChild(c));
  stage.insertBefore(cam, stage.firstChild);
  const flash = document.createElement('div');
  flash.style.cssText = 'position:absolute;inset:0;background:#fff;pointer-events:none;opacity:0;z-index:8000';
  stage.appendChild(flash);

  const keyTimes = S.words.filter(w => isKey(w.word)).map(w => w.start);
  const cuts = scenes.slice(1).map(s => s.start);

  function camera(t) {
    let s = 1, x = 0, y = 0, r = 0, fl = 0;
    // hook slam: starts pushed in and tilted, slams into place with a decaying shake and a flash
    const h = E.outExpo(inv(0, 0.45, t));
    s *= 1 + 0.1 * (1 - h); r += -1.5 * (1 - h);
    const shake = t > 0.3 ? Math.max(0, 1 - t / 1.1) : 0;
    x += noise1(t * 22, 1) * 14 * shake; y += noise1(t * 22, 2) * 10 * shake;
    if (t > 0.3) fl = 0.35 * (1 - inv(0.32, 0.55, t));
    // punch-in on every cut, alternating direction
    cuts.forEach((c, k) => {
      const d = t - c; if (d < 0 || d > 0.5) return;
      const p = 1 - E.outCubic(d / 0.5);
      s *= 1 + 0.07 * p; x += (k % 2 ? 1 : -1) * 26 * p; r += (k % 2 ? 0.6 : -0.6) * p;
    });
    // pulse on key words / numbers as they are spoken
    for (const k of keyTimes) { const d = t - k; if (d >= 0 && d < 0.3) s *= 1 + 0.035 * (1 - d / 0.3); }
    // handheld drift
    x += noise1(t * 0.35, 7) * 9; y += noise1(t * 0.3, 8) * 7; r += noise1(t * 0.25, 9) * 0.35;
    s *= 1.015 + 0.012 * Math.sin(t * 0.5);
    return { s, x, y, r, fl };
  }

  const base = window.render;
  window.render = async t => {
    await base(t);
    const c = camera(t);
    cam.style.transform = `translate(${c.x.toFixed(2)}px, ${c.y.toFixed(2)}px) rotate(${c.r.toFixed(3)}deg) scale(${c.s.toFixed(4)})`;
    flash.style.opacity = c.fl.toFixed(3);
  };
})();
