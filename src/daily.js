// CLI entry for Windows Task Scheduler / cron:  node src/daily.js [--no-upload] [--force] [--plan file.json] [--style crayon] [--resume RUN_ID]
import { runPipeline, todaysRun, reconcileStaleRuns } from './pipeline.js';

const args = process.argv.slice(2);
const flag = f => args.includes(f);
const opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

reconcileStaleRuns();
let runId = opt('--resume');
const today = todaysRun();
if (!runId && !flag('--force') && !opt('--plan') && today) {
  if (today.status === 'interrupted') { runId = today.id; console.log(`resuming today's interrupted run ${runId}`); }
  else { console.log(`today's video already exists (${today.id}); use --force to make another`); process.exit(0); }
}
try {
  const r = await runPipeline({ runId, upload: flag('--no-upload') ? false : undefined, planFile: opt('--plan'), style: opt('--style') });
  console.log(`done: ${r.title} → ${r.video_path}${r.youtube_id ? ` → https://youtube.com/shorts/${r.youtube_id}` : ''}`);
  process.exit(0);
} catch (e) {
  console.error(e.cancelled ? 'CANCELLED' : 'FAILED:', e.message);
  process.exit(1);
}
