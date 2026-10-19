const $ = s => document.querySelector(s);
const api = (p, o = {}) => fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = iso => iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

// Typical seconds per stage, used to animate the bar for stages that can't report exact progress.
const EXPECT = { discover: 15, plan: 360, voice: 20, media: 45, qa: 90, render: 150, upload: 60 };
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
  try { await api(`/api/runs/${id}/${a}`, { method: 'POST', body: JSON.stringify({ upload: $('#uploadToggle').checked }) }); refresh(); }
  catch (e) { alert(e.message); }
}
const actionsFor = (r, running) => {
  if (running) return [];
  if (['interrupted', 'failed', 'cancelled'].includes(r.status)) return [['resume', 'Resume', 'primary'], ['restart', 'Start over', '']];
  if (r.status === 'held' && !r.youtube_id) return [['upload', 'Upload anyway', ''], ['restart', 'Start over', 'primary']];
  if (r.status === 'done' && !r.youtube_id) return [['upload', 'Upload & schedule', '']];
  return [];
};

async function refresh() {
  const s = await api('/api/status');
  renderLive(s);
  $('#channelName').textContent = s.youtube.channel ? `· ${s.youtube.channel.title}` : '';
  $('#nowState').textContent = s.running ? 'Producing…' : 'Idle';
  $('#nowSub').textContent = s.running ? (s.stages.find(x => x.id === s.running.stage)?.label || 'starting') : 'waiting for the next run';
  $('#runNow').disabled = !!s.running;
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
  ];
  $('#checks').innerHTML = items.map(([ok, k, v]) => `<li><b class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</b><span><b>${k}</b><br><span class="muted">${v}</span></span></li>`).join('');
  $('#setup').style.display = items.every(i => i[0]) ? 'none' : '';
  const runs = await api('/api/runs');
  const label = id => s.stages.find(x => x.id === id)?.label || id || '';
  $('#runs tbody').innerHTML = runs.map(r => {
    const acts = actionsFor(r, !!s.running);
    return `<tr data-id="${r.id}">
    <td>${esc(r.id.slice(0, 10))}</td><td><b>${esc(r.title || r.topic || '…')}</b>${r.error ? `<br><span class="${r.status === 'failed' ? 'bad' : 'muted'}">${esc(r.error.slice(0, 140))}</span>` : ''}
      ${acts.length ? `<div class="row-acts">${acts.map(([a, t, c]) => `<button class="sm ${c}" data-act="${a}" data-id="${r.id}">${t}</button>`).join('')}</div>` : ''}</td>
    <td>${esc(r.style || '')}</td><td>${r.duration ? r.duration.toFixed(0) + 's' : ''}</td>
    <td><span class="chip ${r.status}">${r.status}${['running', 'interrupted', 'failed', 'cancelled'].includes(r.status) && r.stage ? ' · ' + esc(label(r.stage)) : ''}</span></td>
    <td>${r.youtube_id ? `<a href="https://youtube.com/shorts/${r.youtube_id}" target="_blank" onclick="event.stopPropagation()">${fmt(r.publish_at)}</a>` : ''}</td></tr>`;
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
  $('#dMeta').textContent = [r.style, r.duration && r.duration.toFixed(1) + 's', r.meta?.voice, r.meta?.qa?.score != null && `QA ${r.meta.qa.score}/10`].filter(Boolean).join(' · ');
  $('#dVideo').src = r.hasVideo ? `/media/${id}/final.mp4` : ''; $('#dVideo').style.display = r.hasVideo ? '' : 'none';
  $('#dSheet').src = r.hasSheet ? `/media/${id}/sheet.jpg?${Date.now()}` : ''; $('#dSheet').style.display = r.hasSheet ? '' : 'none';
  const st = await api('/api/status');
  const acts = actionsFor(r, !!st.running).map(([a, t, c]) => `<button class="${c}" data-act="${a}">${t}</button>`);
  if (st.running?.runId === id) acts.push(`<button class="danger" data-act="cancel">Cancel</button>`);
  if (r.youtube_id) acts.push(`<a href="https://studio.youtube.com/video/${r.youtube_id}/edit" target="_blank">Open in YouTube Studio →</a>`);
  $('#dActions').innerHTML = acts.join('');
  $('#dActions').onclick = async e => { const a = e.target.dataset.act; if (!a) return; if (a === 'cancel' && !confirm('Cancel this video?')) return; await act(id, a); $('#closeDrawer').click(); };
  $('#dScenes').innerHTML = (r.plan?.scenes || []).map(s => `<li>${esc(s.narration)} <span class="muted">[${esc(s.visual?.kind)}]</span></li>`).join('');
  $('#dSources').innerHTML = (r.plan?.sources || []).map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a></li>`).join('') || '<li class="muted">—</li>';
  $('#dLogs').textContent = r.logs.map(l => `${l.at.slice(11, 19)} ${l.level.padEnd(5)} ${l.msg}`).join('\n');
}

$('#runNow').onclick = async () => {
  try { await api('/api/run', { method: 'POST', body: JSON.stringify({ upload: $('#uploadToggle').checked, style: $('#styleSel').value }) }); refresh(); }
  catch (e) { alert(e.message); }
};

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

refresh(); loadSettings();
setInterval(() => refresh().catch(() => {}), 2000);
