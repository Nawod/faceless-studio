// BRAND — channel watermark + end card, layered on top of every engine (wraps window.render).
(function () {
  const { S, W, H, clamp, inv, E, hash, el, esc } = FS;
  const B = S.brand; if (!B) return;
  document.head.insertAdjacentHTML('beforeend', `<style>
    #wm{position:absolute;left:34px;top:46px;display:flex;align-items:center;gap:10px;z-index:9000;pointer-events:none}
    #wm img{height:92px;filter:drop-shadow(0 4px 10px #0006)}
    #wm span{font-family:'Archivo Black',sans-serif;font-size:30px;line-height:.95;color:#fff;-webkit-text-stroke:7px #12121a;paint-order:stroke fill;letter-spacing:.01em;text-transform:uppercase}
    #wm .g{position:absolute;inset:0;mix-blend-mode:screen;opacity:0}
    #end{position:absolute;inset:0;z-index:9100;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:34px;pointer-events:none;opacity:0}
    #end .bg{position:absolute;inset:0;background:radial-gradient(900px 1200px at 50% 42%,#ffffffee,#e9f3ffee 60%,#cfe3f7f2)}
    #end img{position:relative;width:860px;filter:drop-shadow(0 18px 30px #0003)}
    #end .h{position:relative;font-family:Inter,sans-serif;font-weight:900;font-size:64px;color:#12121a;background:#fff;border:6px solid #12121a;border-radius:999px;padding:14px 46px;box-shadow:0 10px 0 #12121a}
    #end .f{position:relative;font-family:Inter,sans-serif;font-weight:800;font-size:46px;color:#2b3a55}
  </style>`);
  const stage = document.getElementById('stage');
  const wm = el('div', '', stage); wm.id = 'wm';
  wm.innerHTML = `<img src="${B.globe}"><span>${esc(B.name).replace(/ /g, '<br>')}</span>`;
  const img = wm.querySelector('img');
  const end = el('div', '', stage); end.id = 'end';
  end.innerHTML = `<div class="bg"></div><img src="${B.wordmark}"><div class="h">${esc(B.handle)}</div><div class="f">Follow for more bugs 🐛</div>`;
  const [ebg, ewm, eh, ef] = end.children;
  const END = Math.max(0, S.duration - 1.9);

  const base = window.render;
  window.__ready = Promise.all([window.__ready, img.decode().catch(() => {}), ewm.decode().catch(() => {})]);
  window.render = async t => {
    await base(t);
    // watermark: gentle bob + a short "bug" glitch every few seconds
    const g = Math.floor(t / 4.3), gt = t - g * 4.3, glitch = gt > 3.0 && gt < 3.16;
    const dx = glitch ? (hash(Math.floor(t * 30), g) - 0.5) * 14 : 0;
    wm.style.transform = `translate(${dx}px, ${Math.sin(t * 2.1) * 3}px)`;
    img.style.transform = `rotate(${Math.sin(t * 1.3) * 4}deg)`;
    img.style.filter = glitch ? 'drop-shadow(5px 0 0 #ff2bd6) drop-shadow(-5px 0 0 #18e0ff)' : 'drop-shadow(0 4px 10px #0006)';
    wm.style.opacity = String(0.92 * (1 - inv(END, END + 0.25, t)));
    // end card
    const p = inv(END, END + 0.35, t);
    end.style.opacity = String(p);
    ewm.style.transform = `scale(${E.outBack(inv(END + 0.05, END + 0.5, t), 1.9)}) rotate(${(1 - E.outCubic(inv(END, END + 0.5, t))) * -6}deg)`;
    eh.style.transform = `translateY(${(1 - E.outBack(inv(END + 0.3, END + 0.7, t))) * 200}px)`;
    eh.style.opacity = String(inv(END + 0.3, END + 0.5, t));
    ef.style.opacity = String(inv(END + 0.55, END + 0.8, t));
  };
})();
