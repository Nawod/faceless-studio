const $ = s => document.querySelector(s);
const api = (p, o = {}) => fetch(p, { headers: { 'Content-Type': 'application/json' }, ...o }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j; });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const fmt = iso => iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

async function refresh() {
  const s = await api('/api/status');
  $('#channelName').textContent = s.youtube.channel ? `· ${s.youtube.channel.title}` : '';
  $('#nowState').textContent = s.running ? 'Producing…' : 'Idle';
  $('#nowSub').textContent = s.running ? `stage: ${s.running.stage}` : 'waiting for the next run';
  $('#runNow').disabled = !!s.running;
  $('#nextRun').textContent = fmt(s.nextRun);
  $('#nextPub').textContent = fmt(s.nextPublish);
  $('#totals').textContent = `${s.totals.done || 0} made`;
  $('#totalsSub').textContent = `${s.totals.uploaded || 0} uploaded · ${s.totals.failed || 0} failed`;
  $('#topicCount').textContent = `${s.recentTopics} topics in the 90-day no-repeat list`;
  const c = s.checks, items = [
    [c.claude && c.claudeToken, 'Claude Code token', c.claudeToken ? 'set' : 'run <code>claude setup-token</code> and put it in .env as CLAUDE_CODE_OAUTH_TOKEN'],
    [c.chrome, 'Chrome for rendering', c.chrome ? 'found' : 'install Chrome or set CHROME_PATH'],
    [c.fonts, 'Fonts', c.fonts ? 'downloaded' : 'run <code>npm run fonts</code>'],
    [c.pexels, 'Stock footage key', c.pexels ? 'set' : 'free key at pixabay.com/api/docs → PIXABAY_API_KEY (documentary, newsflash & collage need it)'],
    [s.youtube.configured, 'YouTube OAuth client', s.youtube.configured ? 'set' : 'YOUTUBE_CLIENT_ID / SECRET in .env'],
    [s.youtube.connected, 'YouTube channel', s.youtube.connected ? (s.youtube.channel?.title || 'connected') : '<a href="/oauth/start">Connect YouTube →</a>'],
  ];
  $('#checks').innerHTML = items.map(([ok, k, v]) => `<li><b class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✗'}</b><span><b>${k}</b><br><span class="muted">${v}</span></span></li>`).join('');
  $('#setup').style.display = items.every(i => i[0]) ? 'none' : '';
  const runs = await api('/api/runs');
  $('#runs tbody').innerHTML = runs.map(r => `<tr data-id="${r.id}">
    <td>${esc(r.id.slice(0, 10))}</td><td><b>${esc(r.title || r.topic || '…')}</b>${r.error ? `<br><span class="bad">${esc(r.error.slice(0, 120))}</span>` : ''}</td>
    <td>${esc(r.style || '')}</td><td>${r.duration ? r.duration.toFixed(0) + 's' : ''}</td>
    <td><span class="chip ${r.status}">${r.status}${r.status === 'running' ? ' · ' + esc(r.stage || '') : ''}</span></td>
    <td>${r.youtube_id ? `<a href="https://youtube.com/shorts/${r.youtube_id}" target="_blank" onclick="event.stopPropagation()">${fmt(r.publish_at)}</a>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">No videos yet — click “Make a video now”.</td></tr>';
}

$('#runs').addEventListener('click', e => { const tr = e.target.closest('tr[data-id]'); if (tr) openRun(tr.dataset.id); });
$('#closeDrawer').onclick = () => { $('#drawer').hidden = true; $('#dVideo').pause(); };
$('#drawer').addEventListener('click', e => { if (e.target.id === 'drawer') $('#closeDrawer').click(); });

async function openRun(id) {
  const r = await api(`/api/runs/${id}`);
  $('#drawer').hidden = false;
  $('#dTitle').textContent = r.title || r.topic || r.id;
  $('#dMeta').textContent = [r.style, r.duration && r.duration.toFixed(1) + 's', r.meta?.voice, r.meta?.qa?.score != null && `QA ${r.meta.qa.score}/10`].filter(Boolean).join(' · ');
  $('#dVideo').src = r.hasVideo ? `/media/${id}/final.mp4` : ''; $('#dVideo').style.display = r.hasVideo ? '' : 'none';
  $('#dSheet').src = r.hasSheet ? `/media/${id}/sheet.jpg?${Date.now()}` : ''; $('#dSheet').style.display = r.hasSheet ? '' : 'none';
  const acts = [];
  if (r.status === 'failed') acts.push(`<button class="primary" data-act="retry">Resume this run</button>`);
  if (r.status === 'done' && !r.youtube_id) acts.push(`<button class="primary" data-act="upload">Upload & schedule</button>`);
  if (r.youtube_id) acts.push(`<a href="https://studio.youtube.com/video/${r.youtube_id}/edit" target="_blank">Open in YouTube Studio →</a>`);
  $('#dActions').innerHTML = acts.join('');
  $('#dActions').onclick = async e => { const a = e.target.dataset.act; if (!a) return; try { await api(`/api/runs/${id}/${a}`, { method: 'POST', body: '{}' }); $('#closeDrawer').click(); refresh(); } catch (err) { alert(err.message); } };
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
  f.runAtLocal.value = cfg.schedule.runAtLocal; f.publishAtUTC.value = cfg.schedule.publishAtUTC; f.autoUpload.checked = cfg.youtube.autoUpload;
  $('#styleToggles').innerHTML = Object.entries(cfg.styles).map(([k, v]) => `<label class="toggle"><input type="checkbox" data-style="${k}" ${v.enabled ? 'checked' : ''}> ${k}</label>`).join('');
}
$('#settings').onsubmit = async e => {
  e.preventDefault(); const f = e.target;
  cfg.channelName = f.channelName.value; cfg.audience = f.audience.value; cfg.niche.primary = f.niche.value;
  cfg.niche.avoid = f.avoid.value.split('\n').map(s => s.trim()).filter(Boolean); cfg.niche.trendWeight = +f.trendWeight.value;
  cfg.video.targetSeconds = Math.max(61, +f.targetSeconds.value); cfg.schedule.runAtLocal = f.runAtLocal.value; cfg.schedule.publishAtUTC = f.publishAtUTC.value;
  cfg.youtube.autoUpload = f.autoUpload.checked;
  document.querySelectorAll('[data-style]').forEach(i => { cfg.styles[i.dataset.style].enabled = i.checked; });
  if (!Object.values(cfg.styles).some(s => s.enabled)) return alert('Enable at least one style');
  await api('/api/config', { method: 'PUT', body: JSON.stringify(cfg) });
  $('#saved').textContent = 'Saved ✓'; setTimeout(() => ($('#saved').textContent = ''), 2000); refresh();
};

refresh(); loadSettings();
setInterval(refresh, 5000);
