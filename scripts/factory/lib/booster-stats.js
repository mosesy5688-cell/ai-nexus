/**
 * V25.8.9 Booster Stats Writer
 *
 * Writes per-partition run statistics to `output/booster-stats-${partition}.json`
 * so the Factory 1.5 workflow's "Enrichment Summary" step can aggregate real
 * numbers across the 8 matrix partitions.
 *
 * Prior state: the workflow summary expected these files but density-booster.js
 * never wrote them, so `upload-artifact` with `if-no-files-found: ignore`
 * silently produced empty artifacts and the summary aggregation always showed
 * `SUCCESS: 0 | Remaining: 0` regardless of actual partition output. This
 * observability gap has existed since the stats-writing code was removed in
 * an earlier V25.8.x refactor without also removing the workflow summary step.
 *
 * Schema (only `success` and `remaining` are read by the workflow today, the
 * rest are forward-looking observability fields):
 *   {
 *     partition: "00",
 *     processed: 8547,
 *     success: 1342,
 *     partial: 12,
 *     skipped: 5331,
 *     failed: 0,
 *     remaining: 9019,
 *     timestamp: "2026-04-12T00:00:00.000Z"
 *   }
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export function writeBoosterStats(partitionStart, stats) {
    const outputDir = 'output';
    try {
        mkdirSync(outputDir, { recursive: true });
        const file = join(outputDir, `booster-stats-${partitionStart}.json`);
        const payload = { partition: partitionStart, ...stats, timestamp: new Date().toISOString() };
        writeFileSync(file, JSON.stringify(payload, null, 2));
        console.log(`[BOOSTER] Wrote stats → ${file}`);
    } catch (e) {
        console.warn(`[BOOSTER] Failed to write stats: ${e?.message || e}`);
    }
}
