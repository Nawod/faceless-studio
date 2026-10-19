// Spread already-scheduled uploads that share a publish time across the free daily slots.
//   node src/tools/respread.js            → show the plan only
//   node src/tools/respread.js --apply    → change the publish times on YouTube
import { db, updateRun } from '../db.js';
import { channel } from '../config.js';
import { nextFreeSlot, reschedule } from '../youtube.js';

const apply = process.argv.includes('--apply');
const cfg = channel();
const runs = db.prepare("SELECT id, title, youtube_id, publish_at FROM runs WHERE youtube_id IS NOT NULL AND publish_at > ? ORDER BY created_at").all(new Date().toISOString());
const seen = new Set();
for (const r of runs) {
  const key = r.publish_at.slice(0, 16);
  if (!seen.has(key)) { seen.add(key); console.log(`keep  ${r.publish_at}  ${r.title}`); continue; }
  // free this run's slot in the DB view, then take the next free one
  updateRun(r.id, { publish_at: null });
  const slot = nextFreeSlot(cfg.schedule);
  if (apply) {
    await reschedule(r.youtube_id, slot, { madeForKids: cfg.youtube.madeForKids, synthetic: cfg.youtube.containsSyntheticMedia });
    updateRun(r.id, { publish_at: slot });
    console.log(`moved ${r.publish_at} → ${slot}  ${r.title}`);
  } else {
    updateRun(r.id, { publish_at: slot });            // reserve it so the next row picks a different slot
    console.log(`would move ${r.publish_at} → ${slot}  ${r.title}`);
  }
  seen.add(slot.slice(0, 16));
}
if (!apply) {
  // restore the original times in the DB (dry run)
  for (const r of runs) updateRun(r.id, { publish_at: r.publish_at });
  console.log('\n(dry run — nothing changed on YouTube; run with --apply to do it)');
}
process.exit(0);
