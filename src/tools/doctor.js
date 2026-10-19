// npm run doctor — checks every dependency the daily run needs, including a live Claude call.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { bins, env, ROOT } from '../config.js';
import { askClaude } from '../claude.js';
import { isConnected, channelInfo } from '../youtube.js';

const ok = (m) => console.log(`  ✓ ${m}`), bad = (m) => console.log(`  ✗ ${m}`);
const run = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return null; } };

console.log('Faceless Studio — doctor\n');
bins.chrome ? ok(`Chrome: ${bins.chrome}`) : bad('Chrome not found (set CHROME_PATH)');
run(bins.ffmpeg, ['-version']) ? ok('ffmpeg') : bad('ffmpeg not found (set FFMPEG_PATH)');
const py = run(bins.python, ['-c', 'import edge_tts, numpy, scipy; print(edge_tts.__version__)']);
py ? ok(`Python + edge-tts ${py} (${bins.python})`) : bad(`Python packages missing: ${bins.python} -m pip install -U edge-tts numpy scipy`);
fs.existsSync(path.join(ROOT, 'engines', 'fonts', 'fonts.css')) ? ok('fonts') : bad('fonts missing: npm run fonts');
(env('PIXABAY_API_KEY') || env('PEXELS_API_KEY')) ? ok(`stock media key (${[env('PIXABAY_API_KEY') && 'Pixabay', env('PEXELS_API_KEY') && 'Pexels'].filter(Boolean).join(' + ')})`) : bad('PIXABAY_API_KEY not set (documentary/newsflash/collage fall back to graphics)');
bins.claude ? ok(`Claude CLI: ${bins.claude}`) : bad('Claude Code CLI not found (set CLAUDE_BIN)');
if (bins.claude) {
  try { const r = await askClaude('Reply with {"ok": true}', { schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] }, model: 'haiku', maxTurns: 2, timeoutMs: 120_000, retries: 0 }); r.ok ? ok('Claude subscription auth works') : bad('Claude replied unexpectedly'); }
  catch (e) { bad(`Claude: ${e.message}  → run "claude setup-token" and set CLAUDE_CODE_OAUTH_TOKEN in .env`); }
}
if (!env('YOUTUBE_CLIENT_ID')) bad('YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET not set');
else if (!isConnected()) bad('YouTube not connected: npm start → open the dashboard → Connect YouTube');
else { try { const c = await channelInfo(); ok(`YouTube channel: ${c?.title}`); } catch (e) { bad(`YouTube: ${e.message}`); } }
