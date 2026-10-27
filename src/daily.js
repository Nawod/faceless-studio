// CLI entry for Windows Task Scheduler / cron. Makes today's videos until the daily quota (videosPerDay) is met.
//   node src/daily.js [--no-upload] [--force] [--plan file.json] [--style crayon] [--resume RUN_ID]
import { runPipeline, todayStatus, reconcileStaleRuns, lockOwnerAlive } from './pipeline.js';
import { kvGet } from './db.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_LIMIT_WAIT = 6 * 3600_000;   // the task may run 10 h; wait out a usage-limit reset up to 6 h

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const upload = flag('--no-upload') ? false : undefined;

async function one(runId) {
  const r = await runPipeline({ runId, upload, planFile: opt('--plan'), style: opt('--style') });
  console.log(`${r.status}: ${r.title} → ${r.video_path}${r.youtube_id ? ` → https://youtube.com/shorts/${r.youtube_id} (${r.publish_at})` : ''}`);
}

reconcileStaleRuns();
if (lockOwnerAlive()) { console.log('a run is already in progress (dashboard?) — it will make today\'s videos'); process.exit(0); }
try {
  // single, explicit runs
  if (opt('--resume') || opt('--plan') || flag('--force')) { await one(opt('--resume')); process.exit(0); }
  // the daily quota: resume an interrupted run first, then make videos until today's target is met
  // Each run (21:15, and the 23:45 catch-up) gets its own budget of attempts, so a bad first run can't
  // use up the retry. Stops as soon as today's quota of finished videos is met.
  console.log(`\n=== daily run ${new Date().toLocaleString()} ===`);
  let attempts = 0;
  const budget = todayStatus().target + 3;
  for (let guard = 0; guard < budget + 2; guard++) {
    const t = todayStatus();
    if (t.made >= t.target) { console.log(`today: ${t.made}/${t.target} videos made — done`); break; }
    const until = kvGet('claudeLimitUntil') || 0;
    if (until > Date.now()) {
      const wait = until - Date.now() + 2 * 60_000;
      if (wait > MAX_LIMIT_WAIT) { console.log(`Claude usage limit until ${new Date(until).toLocaleString()} — too long to wait; the next run continues`); break; }
      console.log(`Claude usage limit reached — waiting until ${new Date(until + 120_000).toLocaleTimeString()} to continue`);
      await sleep(wait); guard--; continue;
    }
    if (attempts >= budget) { console.log(`today: ${t.made}/${t.target} made after ${attempts} attempts this run — stopping (the catch-up run will try again)`); break; }
    attempts++;
    if (t.interrupted) { console.log(`resuming interrupted run ${t.interrupted.id}`); await one(t.interrupted.id).catch(e => { if (e.limit) attempts--; console.error(e.limit ? 'PAUSED:' : 'FAILED:', e.message); }); continue; }
    console.log(`making video ${t.made + 1} of ${t.target} (attempt ${attempts}/${budget})`);
    await one().catch(e => { if (e.limit) attempts--; console.error(e.cancelled ? 'CANCELLED' : e.limit ? 'PAUSED:' : 'FAILED:', e.message); });
  }
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
