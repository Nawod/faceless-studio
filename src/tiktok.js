// TikTok drafts: Login Kit (OAuth 2 + PKCE) → the Content Posting API "Upload" flow, which puts the video in your
// TikTok inbox as a draft; you open the notification in TikTok, paste the caption and post. No API audit is needed
// for this (direct posting stays private-only until TikTok audits the app). Pure API calls — no AI.
// Docs: https://developers.tiktok.com/doc/content-posting-api-get-started-upload-content
import fs from 'node:fs';
import crypto from 'node:crypto';
import { env } from './config.js';
import { kvGet, kvSet } from './db.js';

const API = 'https://open.tiktokapis.com/v2';
const SCOPES = ['user.info.basic', 'video.upload'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const ttConfigured = () => !!(env('TIKTOK_CLIENT_KEY') && env('TIKTOK_CLIENT_SECRET'));
export const ttAccount = () => kvGet('tiktok');                 // { open_id, name, access_token, refresh_token, expires_at, refresh_expires_at }
export const ttConnected = () => !!ttAccount()?.refresh_token && (ttAccount().refresh_expires_at || Infinity) > Date.now();
export function ttDisconnect() { kvSet('tiktok', null); }

/** Login URL. TikTok's desktop flow wants PKCE with a hex SHA-256 challenge; the verifier is kept until the callback. */
export function ttAuthUrl(redirectUri, state) {
  const verifier = crypto.randomBytes(48).toString('base64url');
  kvSet('tiktok_pkce', { state, verifier });
  const p = new URLSearchParams({
    client_key: env('TIKTOK_CLIENT_KEY'), scope: SCOPES.join(','), response_type: 'code', redirect_uri: redirectUri, state,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('hex'), code_challenge_method: 'S256',
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${p}`;
}

async function tokenCall(params) {
  const r = await fetch(`${API}/oauth/token/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_key: env('TIKTOK_CLIENT_KEY'), client_secret: env('TIKTOK_CLIENT_SECRET'), ...params }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !j.access_token) throw new Error(`TikTok login: ${j.error_description || j.error || r.status}`);
  return { access_token: j.access_token, refresh_token: j.refresh_token, open_id: j.open_id, scope: j.scope,
    expires_at: Date.now() + (j.expires_in || 86400) * 1000 - 60_000, refresh_expires_at: Date.now() + (j.refresh_expires_in || 31536000) * 1000 };
}

async function api(path, { method = 'GET', body, token } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json; charset=UTF-8' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.error?.code && j.error.code !== 'ok')) throw new Error(`TikTok ${path}: ${j.error?.message || j.error?.code || r.status}`);
  return j.data || {};
}

export async function ttExchangeCode(code, redirectUri, state) {
  const pk = kvGet('tiktok_pkce');
  if (!pk || pk.state !== state) throw new Error('login state mismatch — start again from the dashboard');
  const t = await tokenCall({ code, grant_type: 'authorization_code', redirect_uri: redirectUri, code_verifier: pk.verifier });
  let name = '';
  try { name = (await api('/user/info/?fields=open_id,display_name', { token: t.access_token })).user?.display_name || ''; } catch {}
  kvSet('tiktok', { ...t, name }); kvSet('tiktok_pkce', null);
  return { name };
}

/** A valid access token (they last 24 h; the refresh token ~1 year). */
async function token() {
  const a = ttAccount();
  if (!a?.refresh_token) throw new Error('TikTok is not connected');
  if (a.expires_at > Date.now()) return a.access_token;
  const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: a.refresh_token });
  kvSet('tiktok', { ...a, ...t });
  return t.access_token;
}

export async function ttCheck() {
  const u = (await api('/user/info/?fields=open_id,display_name', { token: await token() })).user || {};
  return { name: u.display_name || ttAccount()?.name || 'TikTok account' };
}

/**
 * Send a finished MP4 to the TikTok inbox as a draft. Returns { id } (the publish_id).
 * Chunks: one chunk up to 64 MB; above that 10 MB chunks, the last one carrying the remainder (TikTok's rules).
 */
export async function sendDraft(file, log) {
  const tok = await token();
  const size = fs.statSync(file).size;
  const single = size <= 64 * 1024 * 1024;
  const chunk = single ? size : 10 * 1024 * 1024;
  const count = single ? 1 : Math.floor(size / chunk);
  const init = await api('/post/publish/inbox/video/init/', { method: 'POST', token: tok,
    body: { source_info: { source: 'FILE_UPLOAD', video_size: size, chunk_size: chunk, total_chunk_count: count } } });
  log?.info(`tiktok: uploading ${(size / 1e6).toFixed(1)} MB to your TikTok drafts…`);
  const fd = fs.openSync(file, 'r');
  try {
    for (let k = 0; k < count; k++) {
      const start = k * chunk, end = k === count - 1 ? size - 1 : start + chunk - 1;
      const buf = Buffer.alloc(end - start + 1); fs.readSync(fd, buf, 0, buf.length, start);
      for (let attempt = 1; ; attempt++) {
        const r = await fetch(init.upload_url, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(buf.length), 'Content-Range': `bytes ${start}-${end}/${size}` }, body: buf });
        if (r.ok || r.status === 201 || r.status === 206) break;
        if (attempt >= 3) throw new Error(`TikTok upload failed ${r.status}: ${(await r.text()).slice(0, 200)}`);
        await sleep(3000 * attempt);
      }
    }
  } finally { fs.closeSync(fd); }
  // wait until TikTok has it in the inbox (or reports a failure)
  for (let k = 0; k < 40; k++) {
    await sleep(6000);
    const s = await api('/post/publish/status/fetch/', { method: 'POST', token: tok, body: { publish_id: init.publish_id } }).catch(() => ({}));
    if (s.status === 'FAILED') throw new Error(`TikTok rejected the video: ${s.fail_reason || 'unknown reason'}`);
    if (['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE'].includes(s.status)) break;
  }
  log?.info(`tiktok: draft ${init.publish_id} is in your TikTok inbox — open the notification in TikTok to post it`);
  return { id: init.publish_id };
}

/**
 * The caption to paste in TikTok (TikTok's video-drafts API has no caption field): the video's hook title and exactly
 * 5 hashtags — 2 about this topic, then the channel's own. Built from the plan by code (no AI).
 */
export function ttCaption(plan, cfg) {
  const tag = t => String(t || '').toLowerCase().replace(/^#/, '').replace(/[^\p{L}\p{N}]/gu, '');
  const channelTags = (cfg.tiktok?.hashtags || ['earthhasbugs', 'science', 'facts']).map(tag).filter(Boolean);
  const topicTags = (plan.tags || []).map(tag).filter(t => t.length >= 3 && t.length <= 24 && !channelTags.includes(t) && t !== 'shorts');
  const tags = [...new Set([...topicTags.slice(0, 2), ...channelTags])].slice(0, 5);
  return `${String(plan.title || plan.topic || '').replace(/#\S+/g, '').trim()}\n${tags.map(t => '#' + t).join(' ')}`;
}
