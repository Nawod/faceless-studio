// Re-plan the visuals of an existing run (same script and voice), then re-render it without uploading.
//   node src/tools/fix-visuals.js <runId>
import fs from 'node:fs';
import path from 'node:path';
import { RUNS } from '../config.js';
import { makeLogger } from '../log.js';
import { visualProblems } from '../planner.js';
import { runPipeline } from '../pipeline.js';
import { askClaude } from '../claude.js';
import { updateRun } from '../db.js';

const runId = process.argv[2];
const dir = path.join(RUNS, runId), sf = path.join(dir, 'state.json');
const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
const log = makeLogger(runId);
const { enforce } = await import('../planner.js').then(m => ({ enforce: m.enforceVisualsForRun }));
st.plan = await enforce(st.plan, log, dir);
// fetch all stock media again (with the relevance filter)
for (const s of st.plan.scenes) { delete s.visual.img; delete s.visual.video; }
if (st.plan.subject) delete st.plan.subject.img;
log.info(`visual problems left: ${visualProblems(st.plan).length}`);
st.done = st.done.filter(s => !['media', 'qa', 'render', 'upload'].includes(s));
delete st.held; delete st.recorded;
fs.writeFileSync(sf, JSON.stringify(st, null, 1));
fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(st.plan, null, 2));
updateRun(runId, { status: 'interrupted' });
const r = await runPipeline({ runId, upload: false });
console.log(r.status, r.video_path);
process.exit(0);
