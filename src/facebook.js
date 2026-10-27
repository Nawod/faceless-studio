// Facebook Page Reels: Facebook Login (a long-lived user token → never-expiring Page token) or a pasted Page token,
// then the Reels publishing API: start → binary upload to rupload.facebook.com → finish with SCHEDULED + publish time.
// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
import fs from 'node:fs';
import https from 'node:https';
import { env } from './config.js';
import { kvGet, kvSet } from './db.js';

const V = () => env('FB_GRAPH_VERSION', 'v26.0');
const GRAPH = () => `https://graph.facebook.com/${V()}`;
const SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function graph(path, { method = 'GET', params = {}, token } = {}) {
  const q = new URLSearchParams({ ...params, ...(token ? { access_token: token } : {}) });
  const url = method === 'GET' ? `${GRAPH()}${path}?${q}` : `${GRAPH()}${path}`;
  const r = await fetch(url, method === 'GET' ? {} : { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: q });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Facebook ${path}: ${j.error?.message || r.status}${j.error?.code ? ` (code ${j.error.code})` : ''}`);
  return j;
}

// Upload the video bytes to rupload.facebook.com. Streamed with node:https (fetch gives up after waiting 5 minutes
// for the reply, and Facebook only replies once a 60-80 MB file has fully arrived), and resumed from Facebook's own
// byte count if the connection drops.
function ruploadPart(url, token, file, offset, size, log) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', headers: { Authorization: `OAuth ${token}`, offset: String(offset), file_size: String(size), 'Content-Type': 'application/octet-stream', 'Content-Length': String(size - offset) } }, res => {
      let body = ''; res.on('data', d => (body += d));
      res.on('end', () => { let j = {}; try { j = JSON.parse(body); } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300 && j.success) resolve(j); else reject(new Error(`Facebook upload failed ${res.statusCode}: ${body.slice(0, 300)}`)); });
    });
    req.setTimeout(10 * 60_000, () => req.destroy(new Error('no progress for 10 minutes')));   // idle, not total, time
    req.on('error', reject);
    let sent = offset, lastLog = Date.now();
    const rs = fs.createReadStream(file, { start: offset });
    rs.on('data', c => { sent += c.length; if (Date.now() - lastLog > 60_000) { lastLog = Date.now(); log?.info(`facebook: uploaded ${(sent / 1e6).toFixed(0)} / ${(size / 1e6).toFixed(0)} MB`); } });
    rs.on('error', reject);
    rs.pipe(req);
  });
}
async function ruploadFile(file, size, videoId, token, log) {
  const url = `https://rupload.facebook.com/video-upload/${V()}/${videoId}`;
  for (let attempt = 1; ; attempt++) {
    let offset = 0;
    if (attempt > 1) {   // ask Facebook how much it already has, and continue from there
      const st = await fetch(url, { headers: { Authorization: `OAuth ${token}` } }).then(r => r.json()).catch(() => ({}));
      offset = Math.min(size, Number(st.offset ?? st.status?.uploading_phase?.bytes_transfered ?? st.status?.uploading_phase?.bytes_transferred ?? 0) || 0);
      log?.warn(`facebook: upload interrupted — resuming at ${(offset / 1e6).toFixed(1)} MB (attempt ${attempt})`);
    }
    try { return await ruploadPart(url, token, file, offset, size, log); }
    catch (e) { if (attempt >= 4) throw e; log?.warn(`facebook: ${e.message}`); await sleep(5000 * attempt); }
  }
}

export const fbConfigured = () => !!(env('FB_APP_ID') && env('FB_APP_SECRET'));
export const fbPage = () => kvGet('facebook_page');               // { id, name, token }
export const fbConnected = () => !!fbPage()?.token;
export const fbPages = () => (kvGet('facebook_pages') || []).map(({ id, name }) => ({ id, name }));

export function fbAuthUrl(redirectUri, state) {
  const p = new URLSearchParams({ client_id: env('FB_APP_ID'), redirect_uri: redirectUri, state, scope: SCOPES.join(','), response_type: 'code' });
  return `https://www.facebook.com/${V()}/dialog/oauth?${p}`;
}

/** OAuth code → long-lived user token → the user's Pages (their Page tokens don't expire). Picks the channel's Page when it can. */
export async function fbExchangeCode(code, redirectUri, preferName = '') {
  const short = await graph('/oauth/access_token', { params: { client_id: env('FB_APP_ID'), client_secret: env('FB_APP_SECRET'), redirect_uri: redirectUri, code } });
  const long = await graph('/oauth/access_token', { params: { grant_type: 'fb_exchange_token', client_id: env('FB_APP_ID'), client_secret: env('FB_APP_SECRET'), fb_exchange_token: short.access_token } });
  const pages = (await graph('/me/accounts', { params: { fields: 'id,name,access_token,tasks', limit: '100' }, token: long.access_token })).data || [];
  const usable = pages.filter(p => p.access_token && (!p.tasks || p.tasks.includes('CREATE_CONTENT') || p.tasks.includes('MANAGE')));
  if (!usable.length) throw new Error('No Facebook Page found that you can post to. Make sure you ticked your Page in the Facebook dialog.');
  kvSet('facebook_pages', usable.map(p => ({ id: p.id, name: p.name, token: p.access_token })));
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const pick = usable.length === 1 ? usable[0] : usable.find(p => norm(p.name) === norm(preferName));
  if (pick) kvSet('facebook_page', { id: pick.id, name: pick.name, token: pick.access_token });
  return { pages: usable.map(p => ({ id: p.id, name: p.name })), selected: pick ? { id: pick.id, name: pick.name } : null };
}

export function fbSelectPage(id) {
  const p = (kvGet('facebook_pages') || []).find(x => x.id === String(id));
  if (!p) throw new Error('unknown page');
  kvSet('facebook_page', p);
  return { id: p.id, name: p.name };
}

/** Backup path: paste a Page access token (e.g. from the Graph API Explorer). */
export async function fbUseToken(token) {
  const me = await graph('/me', { params: { fields: 'id,name' }, token });
  kvSet('facebook_page', { id: me.id, name: me.name, token });
  kvSet('facebook_pages', [{ id: me.id, name: me.name, token }]);
  return { id: me.id, name: me.name };
}

export function fbDisconnect() { kvSet('facebook_page', null); kvSet('facebook_pages', null); }

/** Check the stored token still works (dashboard). */
export async function fbCheck() {
  const p = fbPage(); if (!p?.token) return null;
  const me = await graph('/me', { params: { fields: 'id,name,followers_count' }, token: p.token });
  return { id: me.id, name: me.name, followers: me.followers_count };
}

/**
 * Upload a 9:16 MP4 as a Reel and schedule it. Facebook accepts 3–90 s, scheduled 10 min – 29 days ahead.
 * publishAt: ISO time (moved to ≥ 15 min ahead if needed). Returns { id, publishAt }.
 */
export async function uploadReel(file, { description, title, publishAt }, log) {
  const page = fbPage();
  if (!page?.token) throw new Error('Facebook Page is not connected');
  const size = fs.statSync(file).size;
  let at = new Date(publishAt || Date.now()).getTime();
  if (at < Date.now() + 15 * 60_000) at = Date.now() + 20 * 60_000;
  if (at > Date.now() + 28 * 86400_000) throw new Error('publish time is more than 28 days ahead (Facebook allows 29)');

  const start = await graph(`/${page.id}/video_reels`, { method: 'POST', params: { upload_phase: 'start' }, token: page.token });
  log?.info(`facebook: uploading ${(size / 1e6).toFixed(1)} MB as a Reel to "${page.name}"…`);
  await ruploadFile(file, size, start.video_id, page.token, log);

  const params = { video_id: start.video_id, video_state: 'SCHEDULED', scheduled_publish_time: String(Math.floor(at / 1000)), description: description.slice(0, 2200), title: (title || '').slice(0, 255), is_ai_generated: 'true' };
  try { await graph(`/${page.id}/video_reels`, { method: 'POST', params: { ...params, upload_phase: 'finish' }, token: page.token }); }
  catch (e) {
    if (!/upload_phase|param/i.test(e.message)) throw e;
    await graph(`/${page.id}/video_reels`, { method: 'POST', params: { ...params, upload_phase: 'complete' }, token: page.token });
  }
  // wait until Facebook has processed it and confirms the schedule (or reports an error)
  for (let k = 0; k < 40; k++) {
    await sleep(15_000);
    const s = (await graph(`/${start.video_id}`, { params: { fields: 'status' }, token: page.token }).catch(() => ({}))).status || {};
    const proc = s.processing_phase?.status, pub = s.publishing_phase?.status;
    if (s.video_status === 'error' || proc === 'error' || pub === 'error') throw new Error(`Facebook rejected the Reel: ${JSON.stringify(s.processing_phase?.errors || s.publishing_phase?.errors || s).slice(0, 300)}`);
    if (['ready', 'upload_complete', 'published'].includes(s.video_status) || pub === 'complete' || s.publishing_phase?.publish_status === 'scheduled') break;
  }
  const publishIso = new Date(at).toISOString();
  log?.info(`facebook: Reel ${start.video_id} scheduled for ${publishIso}`);
  return { id: start.video_id, publishAt: publishIso };
}
