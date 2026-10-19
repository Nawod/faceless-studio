// CLI entry for Windows Task Scheduler / cron. Makes today's videos until the daily quota (videosPerDay) is met.
//   node src/daily.js [--no-upload] [--force] [--plan file.json] [--style crayon] [--resume RUN_ID]
import { runPipeline, todayStatus, reconcileStaleRuns, lockOwnerAlive } from './pipeline.js';

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
  for (let guard = 0; guard < 8; guard++) {
    const t = todayStatus();
    if (t.interrupted) { console.log(`resuming interrupted run ${t.interrupted.id}`); await one(t.interrupted.id).catch(e => console.error('FAILED:', e.message)); continue; }
    if (!t.needMore) { console.log(`today: ${t.made}/${t.target} videos made — done`); break; }
    console.log(`making video ${t.made + 1} of ${t.target}`);
    await one().catch(e => console.error(e.cancelled ? 'CANCELLED' : 'FAILED:', e.message));
  }
  process.exit(0);
} catch (e) {
  console.error('FAILED:', e.message);
  process.exit(1);
}
