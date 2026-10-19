// Preview helpers for humans (ignored by the renderer, which drives window.render directly).
//   index.html?t=12.5     show one frame
//   index.html?play       play in real time (loops), scaled to fit the window
(function () {
  const q = new URLSearchParams(location.search);
  if (!q.has('t') && !q.has('play')) return;
  const fit = () => { const s = Math.min(innerWidth / FS.W, innerHeight / FS.H); document.body.style.transform = `scale(${s})`; document.body.style.transformOrigin = '0 0'; };
  addEventListener('resize', fit); fit();
  window.__ready.then(async () => {
    if (q.has('t')) return window.render(parseFloat(q.get('t')) || 0);
    const t0 = performance.now();
    const loop = async () => { await window.render(((performance.now() - t0) / 1000) % window.DUR); requestAnimationFrame(loop); };
    loop();
  });
})();
