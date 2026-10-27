const $ = s => document.querySelector(s);
const api = (p, o = {}) => fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = iso => iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

// Typical seconds per stage, used to animate the bar for stages that can't report exact progress.
const EXPECT = { discover: 15, plan: 360, voice: 20, media: 45, qa: 90, render: 150, upload: 60, direct: 2400, facebook: 120 };
const mmss = s => s == null ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${String(Math.floor(s % 60)).padStart(2, '0')}s` : `${Math.max(0, Math.round(s))}s`;
let liveRunId = null;

function renderLive(s) {
  const r = s.running, box = $('#live');
  box.hidden = !r; liveRunId = r?.runId || null;
  if (!r) return;
  const p = r.progress || {}, stages = s.stages, cur = Math.max(0, stages.findIndex(x => x.id === (p.stage || r.stage)));
  const doneSet = new Set(p.done || []);
  $('#liveTitle').textContent = r.title || r.topic || 'Picking today’s topic…';
  const elapsed = p.startedAt ? (Date.now() - p.startedAt) / 1000 : null;
  $('#liveMeta').textContent = [r.style && `${r.style} style`, elapsed != null && `running ${mmss(elapsed)}`, r.external && 'started by the daily task'].filter(Boolean).join(' · ');
  $('#steps').innerHTML = stages.map((x, k) => {
    const cls = k < cur || doneSet.has(x.id) ? 'done' : k === cur ? 'now' : '';
    return `<li class="${cls}"><div class="dot">${cls === 'done' ? '✓' : k + 1}</div>${esc(x.label)}</li>`;
  }).join('');
  // stage progress: exact when the stage reports it (render), else estimated from typical durations
  const stId = stages[cur].id, inStage = p.stageStartedAt ? (Date.now() - p.stageStartedAt) / 1000 : 0;
  const exact = typeof p.stagePct === 'number' && p.stagePct > 0;
  const stagePct = exact ? p.stagePct : Math.min(0.92, inStage / (EXPECT[stId] || 60));
  const total = stages.reduce((a, x) => a + x.weight, 0);
  const before = stages.slice(0, cur).reduce((a, x) => a + x.weight, 0);
  const pct = Math.min(99, Math.round(100 * (before + stages[cur].weight * stagePct) / total));
  $('#barFill').style.width = pct + '%';
  $('#barFill').classList.toggle('busy', !exact);
  $('#livePct').textContent = pct + '%';
  $('#liveDetail').textContent = r.cancelling ? 'Cancelling — stopping at the next safe point…' : [p.detail || stages[cur].label + '…', p.eta ? `about ${mmss(p.eta)} left in this step` : ''].filter(Boolean).join(' · ');
  $('#cancelRun').disabled = !!r.cancelling;
}

$('#cancelRun').onclick = async () => {
  if (!liveRunId || !confirm('Cancel this video? You can resume it later from where it stopped.')) return;
  try { await api(`/api/runs/${liveRunId}/cancel`, { method: 'POST', body: '{}' }); refresh(); } catch (e) { alert(e.message); }
};

async function act(id, a) {
  if (a === 'restart' && !confirm('Start over? This picks a NEW topic and redoes every step for this run.')) return;
  if (a === 'facebook' && !confirm('Schedule this video as a Reel on your Facebook Page (next free publish slot)?')) return;
  try {
    const r = await api(`/api/runs/${id}/${a}`, { method: 'POST', body: JSON.stringify({ upload: $('#uploadToggle').checked }) });
    if (r.note) toast(r.note);
    refresh(); loadJobs();
  } catch (e) { toast(e.message, 1); }
}
// buttons stay available while a video is being made: a click joins the task list (runs in click order)
const actionsFor = (r, runningId) => {
  if (r.id === runningId || r.status === 'running') return [];
  const acts = [];
  if (['interrupted', 'failed', 'cancelled'].includes(r.status)) acts.push(['resume', 'Resume', 'primary'], ['restart', 'Start over', '']);
  else if (r.status === 'held' && !r.youtube_id && !r.facebook_id) acts.push(['upload', 'Upload anyway', ''], ['restart', 'Start over', 'primary']);
  else if (r.status === 'done' && !r.youtube_id) acts.push(['upload', 'Upload to YouTube', '']);
  // its own button: any finished video can go to the Facebook Page, whatever happened on YouTube
  if (fbOn && r.hasVideo && !r.facebook_id) acts.push(['facebook', 'Schedule on Facebook', 'fb']);
  return acts;
};

let fbOn = false;   // Facebook Page connected and enabled (offers "Schedule on Facebook" for older videos)
const toast = (msg, err) => { const t = document.createElement('div'); t.className = `toast${err ? ' err' : ''}`; t.textContent = msg; document.body.appendChild(t); setTimeout(() => t.remove(), 3500); };
const post = (p, body = {}) => api(p, { method: 'POST', body: JSON.stringify(body) });

async function refresh() {
  const s = await api('/api/status');
  fbOn = !!(s.facebook?.enabled && s.facebook?.connected);
  renderFacebook(s.facebook);
  renderPoolStatus(s);
  if (s.jobs !== loadJobs.lastCount || s.running?.runId !== loadJobs.lastRun) { loadJobs.lastCount = s.jobs; loadJobs.lastRun = s.running?.runId; loadJobs(); }
  renderLive(s);
  $('#channelName').textContent = s.youtube.channel ? `· ${s.youtube.channel.title}` : '';
  $('#nowState').textContent = s.running ? 'Producing…' : 'Idle';
  $('#nowSub').textContent = s.running ? (s.stages.find(x => x.id === s.running.stage)?.label || 'starting') : 'waiting for the next run';
  $('#runNow').title = s.running ? 'A video is being made — this joins the task list and starts after it' : '';
  $('#nextRun').textContent = fmt(s.nextRun);
  $('#nextPub').textContent = fmt(s.nextPublish);
  $('#totals').textContent = `${s.today.made} / ${s.today.target} today`;
  $('#totalsSub').textContent = `${s.totals.done || 0} made in total · ${s.totals.uploaded || 0} uploaded`;
  $('#topicCount').textContent = `${s.recentTopics} topics in the 90-day no-repeat list`;
  const c = s.checks, items = [
    [c.claude && c.claudeToken, 'Claude login', c.claudeToken ? 'found (run <code>npm run doctor</code> to test it)' : 'run <code>claude</code>, type <code>/login</code>, choose your Claude subscription'],
    [c.chrome, 'Chrome for rendering', c.chrome ? 'found' : 'install Chrome or set CHROME_PATH'],
    [c.fonts, 'Fonts', c.fonts ? 'downloaded' : 'run <code>npm run fonts</code>'],
    [c.pexels, 'Stock footage key', c.pexels ? 'set' : 'free key at pixabay.com/api/docs → PIXABAY_API_KEY (documentary, newsflash & collage need it)'],
    [s.youtube.configured, 'YouTube OAuth client', s.youtube.configured ? 'set' : 'YOUTUBE_CLIENT_ID / SECRET in .env'],
    [s.youtube.connected, 'YouTube channel', s.youtube.connected ? (s.youtube.channel?.title || 'connected') : '<a href="/oauth/start">Connect YouTube →</a>'],
    [!s.facebook.enabled || s.facebook.connected, 'Facebook Page', !s.facebook.enabled ? 'off' : s.facebook.connected ? s.facebook.page.name : 'not connected — see the Facebook Page card'],
  ];
  $('#checks').innerHTML = items.map(([ok, k, v]) => `<li><b class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</b><span><b>${k}</b><br><span class="muted">${v}</span></span></li>`).join('');
  $('#setup').style.display = items.every(i => i[0]) ? 'none' : '';
  const runs = await api('/api/runs');
  const label = id => s.stages.find(x => x.id === id)?.label || id || '';
  $('#runs tbody').innerHTML = runs.map(r => {
    const acts = actionsFor(r, s.running?.runId);
    return `<tr data-id="${r.id}">
    <td>${esc(r.id.slice(0, 10))}</td><td><b>${esc(r.title || r.topic || '…')}</b>${r.error ? `<br><span class="${r.status === 'failed' ? 'bad' : 'muted'}">${esc(r.error.slice(0, 140))}</span>` : ''}
      ${acts.length ? `<div class="row-acts">${acts.map(([a, t, c]) => `<button class="sm ${c}" data-act="${a}" data-id="${r.id}">${t}</button>`).join('')}</div>` : ''}</td>
    <td>${esc(r.style || '')}</td><td>${r.duration ? r.duration.toFixed(0) + 's' : ''}</td>
    <td><span class="chip ${r.status}">${r.status}${['running', 'interrupted', 'failed', 'cancelled'].includes(r.status) && r.stage ? ' · ' + esc(label(r.stage)) : ''}</span></td>
    <td>${r.youtube_id || r.facebook_id ? `${fmt(r.publish_at)}<br>` : ''}${r.youtube_id ? `<a href="https://youtube.com/shorts/${r.youtube_id}" target="_blank" onclick="event.stopPropagation()">YouTube</a>` : ''}${r.facebook_id ? ` <a href="https://www.facebook.com/reel/${r.facebook_id}" target="_blank" onclick="event.stopPropagation()">Facebook</a>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">No videos yet — click “Make a video now”.</td></tr>';
}

$('#runs').addEventListener('click', e => {
  const b = e.target.closest('button[data-act]'); if (b) { e.stopPropagation(); return act(b.dataset.id, b.dataset.act); }
  const tr = e.target.closest('tr[data-id]'); if (tr) openRun(tr.dataset.id);
});
$('#closeDrawer').onclick = () => { $('#drawer').hidden = true; $('#dVideo').pause(); };
$('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') $('#closeDrawer').click(); });

async function openRun(id) {
  const r = await api(`/api/runs/${id}`);
  $('#drawer').hidden = false;
  $('#dTitle').textContent = r.title || r.topic || r.id;
  $('#dMeta').textContent = [r.style, r.duration && r.duration.toFixed(1) + 's', r.meta?.voice, r.meta?.qa?.score != null && `QA ${r.meta.qa.score}/10`, r.meta?.usage && `${(r.meta.usage.tokens / 1e6).toFixed(1)}M tokens`].filter(Boolean).join(' · ');
  $('#dVideo').src = r.hasVideo ? `/media/${id}/final.mp4` : ''; $('#dVideo').style.display = r.hasVideo ? '' : 'none';
  $('#dSheet').src = r.hasSheet ? `/media/${id}/sheet.jpg?${Date.now()}` : ''; $('#dSheet').style.display = r.hasSheet ? '' : 'none';
  const st = await api('/api/status');
  const acts = actionsFor(r, st.running?.runId).map(([a, t, c]) => `<button class="${c}" data-act="${a}">${t}</button>`);
  if (st.running?.runId === id) acts.push(`<button class="danger" data-act="cancel">Cancel</button>`);
  if (r.youtube_id) acts.push(`<a href="https://studio.youtube.com/video/${r.youtube_id}/edit" target="_blank">Open in YouTube Studio →</a>`);
  if (r.facebook_id) acts.push(`<a href="https://business.facebook.com/latest/content_calendar" target="_blank">Facebook content calendar →</a>`);
  $('#dActions').innerHTML = acts.join('');
  $('#dActions').onclick = async e => { const a = e.target.dataset.act; if (!a) return; if (a === 'cancel' && !confirm('Cancel this video?')) return; await act(id, a); $('#closeDrawer').click(); };
  $('#dScenes').innerHTML = (r.plan?.scenes || []).map(s => `<li>${esc(s.narration)} <span class="muted">[${esc(s.visual?.kind)}]</span></li>`).join('');
  $('#dSources').innerHTML = (r.plan?.sources || []).map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a></li>`).join('') || '<li class="muted">—</li>';
  $('#dLogs').textContent = r.logs.map(l => `${l.at.slice(11, 19)} ${l.level.padEnd(5)} ${l.msg}`).join('\n');
}

async function makeNow(style) {
  try {
    const r = await api('/api/run', { method: 'POST', body: JSON.stringify({ upload: $('#uploadToggle').checked, style }) });
    toast(r.note || 'Started'); refresh(); loadJobs(); window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (e) { toast(e.message, 1); }
}

// ---------- task list ----------
async function loadJobs() {
  const jobs = await api('/api/jobs');
  const waiting = jobs.filter(j => j.status === 'waiting'), failed = jobs.filter(j => j.status === 'failed'), running = jobs.find(j => j.status === 'running');
  $('#jobsCard').hidden = !waiting.length && !failed.length;
  $('#jCount').textContent = waiting.length;
  $('#jobList').innerHTML = [
    running ? `<li class="running"><span class="n">▶</span><span class="t"><b>${esc(running.label)}</b><small>running now</small></span></li>` : '',
    ...waiting.map((j, k) => `<li><span class="n">${k + 1}</span><span class="t"><b>${esc(j.label)}</b><small>added ${new Date(j.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></span>
      <span class="acts"><button class="sm danger" data-job="${j.id}" title="Remove from the task list">✕</button></span></li>`),
    ...failed.map(j => `<li class="failed"><span class="n">!</span><span class="t"><b>${esc(j.label)}</b><small class="bad">couldn't run: ${esc(j.error || '')}</small></span></li>`),
  ].join('');
  $('#jobsClear').hidden = !failed.length;
}
$('#jobList').onclick = async e => {
  const b = e.target.closest('[data-job]'); if (!b) return;
  try { await api(`/api/jobs/${b.dataset.job}`, { method: 'DELETE' }); loadJobs(); } catch (err) { toast(err.message, 1); }
};
$('#jobsClear').onclick = async () => { await post('/api/jobs/clear-failed'); loadJobs(); };
$('#runNow').onclick = () => makeNow($('#styleSel').value);

// ---------- animation styles: the director's visual languages (+ the fast template engines) ----------
const TEMPLATES = ['kinetic', 'collage', 'crayon', 'documentary', 'blueprint3d', 'mascot', 'globe3d', 'newsflash'];
async function loadStyles() {
  const [langs, c] = await Promise.all([api('/api/languages'), api('/api/config')]);
  const mode = c.direction?.mode || 'templates';
  document.querySelectorAll('[name=dirMode]').forEach(r => (r.checked = r.value === mode));
  $('#stylesHint').textContent = mode === 'bespoke'
    ? 'Each daily video is hand-animated in one of these styles. The director picks the best fit for the story from the styles in rotation and avoids repeating recent looks. Use “Make one now” to choose a style yourself.'
    : 'Daily videos use the fast template engines (see Channel settings). You can still make a single hand-animated video in any style below.';
  $('#gallery').innerHTML = langs.map(l => {
    const ref = l.refs[0];
    const thumb = ref ? `style="background-image:url('/kit-refs/thumbs/${ref}.jpg')"` : '';
    const badge = l.recentlyUsed ? '<span class="badge">used recently</span>' : '';
    return `<article class="sty ${l.enabled ? '' : 'disabled'}">
      <div class="thumb ${ref ? '' : 'gen-' + l.id}" ${thumb} role="img" aria-label="${esc(l.name)} reference">${badge}</div>
      <div class="body"><b>${esc(l.name)}</b><p>${esc(l.blurb)}</p><div class="best">Best for: ${esc(l.bestFor)}</div>
        <div class="foot"><label class="toggle"><input type="checkbox" data-lang="${l.id}" ${l.enabled ? 'checked' : ''}> in rotation</label>
        <button class="sm" data-make="film:${l.id}">Make one now</button></div></div></article>`;
  }).join('');
  const opts = `<option value="">Auto style</option>
    <optgroup label="Hand-animated (director)">${langs.map(l => `<option value="film:${l.id}">${esc(l.name)}</option>`).join('')}</optgroup>
    <optgroup label="Fast templates">${TEMPLATES.map(t => `<option value="tpl:${t}">${t}</option>`).join('')}</optgroup>`;
  for (const sel of [$('#styleSel'), $('#queueStyle')]) { const keep = sel.value; sel.innerHTML = opts; sel.value = keep; }
  styleNames = Object.fromEntries(langs.map(l => [`film:${l.id}`, l.name]).concat(TEMPLATES.map(t => [`tpl:${t}`, t])));
}
$('#gallery').onclick = e => {
  const b = e.target.closest('[data-make]'); if (!b) return;
  const name = b.closest('.sty').querySelector('b').textContent;
  if (confirm(`Make a hand-animated video now in the “${name}” style? It usually takes 30–60 minutes.`)) makeNow(b.dataset.make);
};
async function saveDirection(mutate) {
  const c = await api('/api/config'); c.direction ||= { mode: 'bespoke', fallback: true }; c.direction.languages ||= {};
  mutate(c.direction);
  const ids = [...document.querySelectorAll('[data-lang]')].map(i => i.dataset.lang);
  if (!ids.some(id => c.direction.languages[id] !== false)) { alert('Keep at least one style in rotation'); return loadStyles(); }
  await api('/api/config', { method: 'PUT', body: JSON.stringify(c) }); cfg = c; loadStyles();
}
$('#gallery').onchange = e => { const i = e.target.closest('[data-lang]'); if (i) saveDirection(d => { d.languages[i.dataset.lang] = i.checked; }); };
document.querySelectorAll('[name=dirMode]').forEach(r => (r.onchange = () => saveDirection(d => { d.mode = r.value; })));

let cfg;
async function loadSettings() {
  cfg = await api('/api/config');
  const f = $('#settings');
  f.channelName.value = cfg.channelName; f.audience.value = cfg.audience; f.niche.value = cfg.niche.primary;
  f.avoid.value = cfg.niche.avoid.join('\n'); f.trendWeight.value = cfg.niche.trendWeight; f.targetSeconds.value = cfg.video.targetSeconds;
  f.runAtLocal.value = cfg.schedule.runAtLocal; f.autoUpload.checked = cfg.youtube.autoUpload;
  f.videosPerDay.value = cfg.schedule.videosPerDay || 1;
  f.publishSlotsUTC.value = (cfg.schedule.publishSlotsUTC || [cfg.schedule.publishAtUTC]).join(', ');
  $('#styleToggles').innerHTML = Object.entries(cfg.styles).map(([k, v]) => `<label class="toggle"><input type="checkbox" data-style="${k}" ${v.enabled ? 'checked' : ''}> ${k}</label>`).join('');
}
$('#settings').onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  cfg.channelName = f.channelName.value; cfg.audience = f.audience.value; cfg.niche.primary = f.niche.value;
  cfg.niche.avoid = f.avoid.value.split('\n').map(s => s.trim()).filter(Boolean); cfg.niche.trendWeight = +f.trendWeight.value;
  cfg.video.targetSeconds = Math.max(61, +f.targetSeconds.value); cfg.schedule.runAtLocal = f.runAtLocal.value;
  const slots = f.publishSlotsUTC.value.split(/[,\s]+/).filter(x => /^\d{1,2}:\d{2}$/.test(x)).map(x => x.padStart(5, '0'));
  if (!slots.length) return alert('Enter at least one publish slot, e.g. 13:00, 18:00, 22:00');
  cfg.schedule.publishSlotsUTC = slots; cfg.schedule.publishAtUTC = slots[0];
  cfg.schedule.videosPerDay = Math.min(6, Math.max(1, +f.videosPerDay.value || 1));
  cfg.youtube.autoUpload = f.autoUpload.checked;
  document.querySelectorAll('[data-style]').forEach(i => { cfg.styles[i.dataset.style].enabled = i.checked; });
  if (!Object.values(cfg.styles).some(s => s.enabled)) return alert('Enable at least one style');
  await api('/api/config', { method: 'PUT', body: JSON.stringify(cfg) });
  $('#saved').textContent = 'Saved ✓'; setTimeout(() => ($('#saved').textContent = ''), 2000); refresh();
};

// ---------- facebook ----------
function renderFacebook(f) {
  const key = JSON.stringify(f); if (renderFacebook.last === key) return; renderFacebook.last = key;
  $('#fbEnabled').checked = f.enabled;
  $('#fbState').innerHTML = f.connected
    ? `<p><b class="ok">✓</b> Posting Reels to <b>${esc(f.page.name)}</b></p>`
    : `<p><b class="bad">✗</b> Not connected.${f.configured ? '' : ' <span class="muted">First add FB_APP_ID and FB_APP_SECRET to .env (README → Facebook), then restart.</span>'}</p>`;
  const acts = [];
  if (f.configured) acts.push(`<a class="btn primary" href="/fb/start">${f.connected ? 'Reconnect' : 'Connect Facebook Page'}</a>`);
  if (f.pages.length > 1) acts.push(`<select id="fbPagePick">${f.pages.map(p => `<option value="${p.id}" ${f.page?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>`);
  if (f.connected) acts.push('<button class="sm" data-fb="check">Test connection</button>', '<button class="sm danger" data-fb="disconnect">Disconnect</button>');
  $('#fbActions').innerHTML = acts.join('');
}
$('#fbActions').onclick = async e => {
  const a = e.target.closest('[data-fb]')?.dataset.fb; if (!a) return;
  try {
    if (a === 'check') { const r = await post('/api/facebook/check'); toast(`OK — ${r.name}${r.followers != null ? ` · ${r.followers} followers` : ''}`); }
    if (a === 'disconnect' && confirm('Disconnect the Facebook Page?')) { await post('/api/facebook/disconnect'); refresh(); }
  } catch (err) { toast(err.message, 1); }
};
$('#fbActions').onchange = async e => { if (e.target.id !== 'fbPagePick') return; try { const p = await post('/api/facebook/page', { id: e.target.value }); toast(`Posting to ${p.name}`); refresh(); } catch (err) { toast(err.message, 1); } };
$('#fbEnabled').onchange = async e => { await api('/api/facebook', { method: 'PUT', body: JSON.stringify({ enabled: e.target.checked }) }); refresh(); };
$('#fbTokenForm').onsubmit = async e => {
  e.preventDefault();
  try { const p = await post('/api/facebook/token', { token: e.target.token.value }); e.target.reset(); toast(`Connected to ${p.name}`); refresh(); } catch (err) { toast(err.message, 1); }
};

// ---------- queue ----------
let styleNames = {};
async function loadQueue() {
  const items = await api('/api/queue');
  const waiting = items.filter(q => q.status === 'waiting');
  $('#qCount').textContent = waiting.length;
  $('#queueList').innerHTML = items.map(q => {
    const pos = waiting.indexOf(q);
    const acts = q.status === 'running' ? '<span class="chip running">making now</span>'
      : q.status === 'failed' ? `<button class="sm" data-q="retry" data-id="${q.id}">Retry</button><button class="sm danger" data-q="remove" data-id="${q.id}">Remove</button>`
      : `<button class="sm" data-q="up" data-id="${q.id}" ${pos === 0 ? 'disabled' : ''} title="Move up">↑</button><button class="sm" data-q="down" data-id="${q.id}" ${pos === waiting.length - 1 ? 'disabled' : ''} title="Move down">↓</button><button class="sm" data-q="run" data-id="${q.id}">Make now</button><button class="sm danger" data-q="remove" data-id="${q.id}" title="Remove">✕</button>`;
    return `<li class="${q.status}"><span class="n">${q.status === 'waiting' ? pos + 1 : ''}</span>
      <span class="t"><b>${esc(q.topic)}</b>${q.style ? `<span class="tag">${esc(styleNames[q.style] || q.style)}</span>` : ''}${q.angle || q.notes ? `<small>${esc(q.angle || q.notes)}</small>` : ''}${q.status === 'failed' && q.error ? `<small class="bad">${esc(q.error.slice(0, 160))}</small>` : ''}</span>
      <span class="acts">${acts}</span></li>`;
  }).join('') || '<li class="qempty">Empty. The next video uses the best idea from the topic pool.</li>';
}
$('#queueForm').onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  try { await post('/api/queue', { topic: f.topic.value, angle: f.angle.value, style: f.style.value }); f.topic.value = ''; f.angle.value = ''; toast('Added to the queue'); loadQueue(); loadPool(); }
  catch (err) { toast(err.message, 1); }
};
$('#queueList').onclick = async e => {
  const b = e.target.closest('[data-q]'); if (!b) return;
  const id = b.dataset.id, a = b.dataset.q;
  try {
    if (a === 'up' || a === 'down') await post(`/api/queue/${id}/move`, { dir: a });
    if (a === 'retry') await post(`/api/queue/${id}/retry`);
    if (a === 'remove') { if (!confirm('Remove this topic from the queue?')) return; await api(`/api/queue/${id}`, { method: 'DELETE' }); }
    if (a === 'run') { const r = await post(`/api/queue/${id}/run`, { upload: $('#uploadToggle').checked }); toast(r.note || 'Started'); refresh(); loadJobs(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    loadQueue(); loadPool();
  } catch (err) { toast(err.message, 1); }
};

// ---------- topic pool ----------
async function loadPool() {
  const ideas = await api(`/api/pool?status=${$('#poolFilter').value}`);
  const st = $('#poolFilter').value;
  $('#poolList').innerHTML = ideas.map(b => `<li><span class="t"><b>${esc(b.topic)}</b>${b.category ? `<span class="tag">${esc(b.category)}</span>` : ''}${b.source === 'manual' ? '<span class="tag">yours</span>' : ''}
      ${b.angle ? `<small>${esc(b.angle)}</small>` : ''}${b.hook ? `<small>Hook: “${esc(b.hook)}”</small>` : ''}${st === 'rejected' && b.notes ? `<small>${esc(b.notes)}</small>` : ''}</span>
      <span class="acts">${st === 'new' ? `<button class="sm" data-b="queue" data-id="${b.id}">Queue</button><button class="sm danger" data-b="reject" data-id="${b.id}">Reject</button>` : st === 'rejected' ? `<button class="sm" data-b="restore" data-id="${b.id}">Restore</button>` : ''}</span></li>`).join('')
    || `<li class="qempty">${st === 'new' ? 'No fresh ideas yet. Click “Research 20 more ideas”, or the next video will research a batch first.' : 'Nothing here.'}</li>`;
}
$('#poolFilter').onchange = loadPool;
$('#poolList').onclick = async e => {
  const b = e.target.closest('[data-b]'); if (!b) return;
  try { await post(`/api/pool/${b.dataset.id}/${b.dataset.b}`); if (b.dataset.b === 'queue') toast('Added to the queue'); loadPool(); loadQueue(); refresh(); } catch (err) { toast(err.message, 1); }
};
$('#poolForm').onsubmit = async e => {
  e.preventDefault(); const f = e.target, body = { topic: f.topic.value, angle: f.angle.value };
  try { await post('/api/pool', body); f.reset(); toast('Idea added'); loadPool(); refresh(); }
  catch (err) {
    if (/too close/.test(err.message) && confirm(`${err.message}\n\nAdd it anyway?`)) { await post('/api/pool', { ...body, force: true }); f.reset(); loadPool(); refresh(); }
    else toast(err.message, 1);
  }
};
$('#poolResearch').onclick = async () => {
  try { const r = await post('/api/pool/research', { n: 20 }); toast(r.note); refresh(); } catch (err) { toast(err.message, 1); }
};
let poolWasGenerating = false;
function renderPoolStatus(s) {
  $('#pCount').textContent = s.pool?.fresh ?? 0;
  const gen = !!s.pool?.generating;
  $('#poolResearch').disabled = gen;
  $('#poolNote').textContent = gen ? 'Researching a batch of ideas…' : '';
  if (poolWasGenerating && !gen) loadPool();   // a batch just finished
  poolWasGenerating = gen;
  const qn = s.queue ?? 0;
  if (+$('#qCount').textContent !== qn || (s.running && !refreshQueueFor) || (!s.running && refreshQueueFor)) { loadQueue(); refreshQueueFor = s.running?.runId || null; }
}
let refreshQueueFor = null;

refresh(); loadSettings(); loadStyles().then(() => loadQueue()); loadPool();
setInterval(() => refresh().catch(() => {}), 2000);
