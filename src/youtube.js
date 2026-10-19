// YouTube Data API v3: OAuth (Desktop/installed client, loopback redirect) + resumable upload with scheduled publish.
import fs from 'node:fs';
import { env } from './config.js';
import { db, kvGet, kvSet } from './db.js';

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

export function authUrl(redirectUri) {
  const p = new URLSearchParams({
    client_id: env('YOUTUBE_CLIENT_ID'), redirect_uri: redirectUri, response_type: 'code',
    scope: SCOPES.join(' '), access_type: 'offline', prompt: 'consent select_account',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export async function exchangeCode(code, redirectUri) {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: env('YOUTUBE_CLIENT_ID'), client_secret: env('YOUTUBE_CLIENT_SECRET'), redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const j = await r.json();
  if (!j.refresh_token) throw new Error(`OAuth failed: ${JSON.stringify(j)}`);
  kvSet('youtube_token', { refresh_token: j.refresh_token, access_token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 });
  return channelInfo();
}

async function accessToken() {
  const tok = kvGet('youtube_token');
  if (!tok) throw new Error('YouTube not connected — open the dashboard and click "Connect YouTube".');
  if (tok.access_token && tok.expires > Date.now()) return tok.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: env('YOUTUBE_CLIENT_ID'), client_secret: env('YOUTUBE_CLIENT_SECRET'), refresh_token: tok.refresh_token, grant_type: 'refresh_token' }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token refresh failed: ${JSON.stringify(j)}`);
  kvSet('youtube_token', { ...tok, access_token: j.access_token, expires: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

export function isConnected() { return !!kvGet('youtube_token'); }

export async function channelInfo() {
  const t = await accessToken();
  const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true', { headers: { Authorization: `Bearer ${t}` } });
  const j = await r.json();
  const c = j.items?.[0];
  const info = c ? { id: c.id, title: c.snippet.title, subs: c.statistics?.subscriberCount, videos: c.statistics?.videoCount } : null;
  if (info) kvSet('youtube_channel', info);
  return info;
}

/** The earliest daily slot (UTC "HH:MM" list) that is ≥ 30 min ahead and not already taken by a scheduled upload. */
export function nextFreeSlot(schedule = {}) {
  const slots = (schedule.publishSlotsUTC?.length ? schedule.publishSlotsUTC : [schedule.publishAtUTC || '18:00']).slice().sort();
  const taken = new Set(db.prepare('SELECT publish_at FROM runs WHERE publish_at IS NOT NULL AND youtube_id IS NOT NULL').all()
    .map(r => new Date(r.publish_at).toISOString().slice(0, 16)));
  const start = new Date(); start.setUTCHours(0, 0, 0, 0); start.setUTCDate(start.getUTCDate() + (schedule.leadDays || 0));
  for (let day = 0; day < 60; day++) {
    for (const s of slots) {
      const [h, m] = s.split(':').map(Number);
      const d = new Date(start); d.setUTCDate(d.getUTCDate() + day); d.setUTCHours(h, m, 0, 0);
      if (d.getTime() < Date.now() + 30 * 60_000) continue;
      if (!taken.has(d.toISOString().slice(0, 16))) return d.toISOString();
    }
  }
  return nextSlot(slots[0], schedule.leadDays);
}

/** Next publish slot (UTC HH:MM), at least 30 minutes ahead. */
export function nextSlot(publishAtUTC = '18:00', leadDays = 0) {
  const [h, m] = publishAtUTC.split(':').map(Number);
  const d = new Date(); d.setUTCHours(h, m, 0, 0); d.setUTCDate(d.getUTCDate() + leadDays);
  while (d.getTime() < Date.now() + 30 * 60_000) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Move a scheduled (private + publishAt) video to a new publish time. */
export async function reschedule(videoId, publishAt, { madeForKids = false, synthetic = true } = {}) {
  const t = await accessToken();
  const r = await fetch('https://www.googleapis.com/youtube/v3/videos?part=status', {
    method: 'PUT', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, status: { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: madeForKids, containsSyntheticMedia: synthetic, embeddable: true, license: 'youtube' } }),
  });
  if (!r.ok) throw new Error(`reschedule ${videoId} failed ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return publishAt;
}

export async function uploadVideo(file, { title, description, tags, categoryId = '27', publishAt, madeForKids = false, synthetic = true }, log) {
  const t = await accessToken();
  const size = fs.statSync(file).size;
  const meta = {
    snippet: { title: title.slice(0, 100), description: description.slice(0, 4900), tags, categoryId, defaultLanguage: 'en', defaultAudioLanguage: 'en' },
    status: { privacyStatus: 'private', publishAt, selfDeclaredMadeForKids: madeForKids, containsSyntheticMedia: synthetic, embeddable: true, license: 'youtube' },
  };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Length': String(size), 'X-Upload-Content-Type': 'video/mp4' },
    body: JSON.stringify(meta),
  });
  if (!init.ok) throw new Error(`upload init ${init.status}: ${await init.text()}`);
  const loc = init.headers.get('location');
  log?.info(`uploading ${(size / 1e6).toFixed(1)} MB…`);
  const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(size) }, body: fs.readFileSync(file) });
  const j = await put.json();
  if (!put.ok || !j.id) throw new Error(`upload failed ${put.status}: ${JSON.stringify(j).slice(0, 400)}`);
  log?.info(`uploaded https://youtube.com/shorts/${j.id} (scheduled ${publishAt})`);
  return j.id;
}
