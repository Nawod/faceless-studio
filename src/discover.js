// Trend discovery from free, key-less sources (plus YouTube mostPopular when a key is set).
// Every source is best-effort: one failing never stops the run.
import { env } from './config.js';

const UA = 'faceless-studio/0.1 (trend discovery; contact: owner)';

async function get(url, { json = true, timeout = 15000, headers = {} } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, ...headers } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return json ? await r.json() : await r.text();
  } finally { clearTimeout(t); }
}

const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();

async function googleTrends(geo) {
  const xml = await get(`https://trends.google.com/trending/rss?geo=${geo}`, { json: false });
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map(m => {
    const item = m[1];
    const title = decode(item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '');
    const traffic = decode(item.match(/<ht:approx_traffic>([\s\S]*?)<\/ht:approx_traffic>/)?.[1] || '');
    const news = [...item.matchAll(/<ht:news_item_title>([\s\S]*?)<\/ht:news_item_title>/g)].slice(0, 2).map(n => decode(n[1]));
    return { source: `google-trends-${geo}`, title, signal: traffic, context: news.join(' | ') };
  }).filter(x => x.title);
}

async function wikipediaTop() {
  const d = new Date(Date.now() - 36 * 3600_000);
  const y = d.getUTCFullYear(), m = String(d.getUTCMonth() + 1).padStart(2, '0'), day = String(d.getUTCDate()).padStart(2, '0');
  const j = await get(`https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/${y}/${m}/${day}`);
  const skip = /^(Main_Page|Special:|Wikipedia:|Portal:|File:|Help:|Template:|Category:|Talk:|Deaths_in|List_of|XXX|Cleopatra)/;
  return (j.items?.[0]?.articles || []).filter(a => !skip.test(a.article)).slice(0, 25)
    .map(a => ({ source: 'wikipedia-top', title: a.article.replace(/_/g, ' '), signal: `${a.views} views` }));
}

async function reddit(sub) {
  const j = await get(`https://www.reddit.com/r/${sub}/top.json?t=day&limit=15`);
  return (j.data?.children || []).filter(c => !c.data.over_18)
    .map(c => ({ source: `reddit-${sub}`, title: c.data.title.replace(/^TIL( that)?:?\s*/i, ''), signal: `${c.data.score} upvotes` }));
}

async function youtubePopular(region) {
  const key = env('YOUTUBE_API_KEY');
  if (!key) return [];
  const j = await get(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&chart=mostPopular&regionCode=${region}&maxResults=25&key=${key}`);
  return (j.items || []).map(v => ({ source: `youtube-popular-${region}`, title: v.snippet.title, signal: `${v.statistics?.viewCount || '?'} views`, context: v.snippet.tags?.slice(0, 5).join(', ') }));
}

export async function discover(log) {
  const jobs = {
    'google-trends-US': () => googleTrends('US'),
    'google-trends-GB': () => googleTrends('GB'),
    'wikipedia': wikipediaTop,
    'reddit-todayilearned': () => reddit('todayilearned'),
    'reddit-science': () => reddit('science'),
    'reddit-space': () => reddit('space'),
    'reddit-natureisfuckinglit': () => reddit('NatureIsFuckingLit'),
    'youtube-US': () => youtubePopular('US'),
    'youtube-GB': () => youtubePopular('GB'),
  };
  const results = await Promise.allSettled(Object.values(jobs).map(f => f()));
  const all = [];
  Object.keys(jobs).forEach((k, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') all.push(...r.value);
    else log?.warn(`trend source ${k} failed: ${r.reason?.message || r.reason}`);
  });
  log?.info(`discovered ${all.length} trend candidates`);
  return all;
}
