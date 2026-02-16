/**
 * Registry Splitter Utility V18.12.5.1 (Architectural Restore)
 * 
 * Responsibilities:
 * 1. Load the monolithic merged.json.gz generated in Stage 1/4.
 * 2. Split it into 20 shards required for Stage 2/4 Matrix Processing.
 * 3. Perform a mandatory count integrity check.
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

const TOTAL_SHARDS = 20;
const DATA_DIR = 'data';
const INPUT_FILE = path.join(DATA_DIR, 'merged.json.gz');

async function splitRegistry() {
    console.log(`\n🔪 [Splitter] Starting monolithic registry decomposition...`);

    if (!await fs.stat(INPUT_FILE).catch(() => null)) {
        console.error(`❌ [Splitter] ERROR: Monolith ${INPUT_FILE} not found!`);
        process.exit(1);
    }

    // 1. Load and decompress monolith
    const startTime = Date.now();
    const data = await fs.readFile(INPUT_FILE);
    const decompressed = zlib.gunzipSync(data);
    const entities = JSON.parse(decompressed);
    console.log(`   ✓ Loaded ${entities.length} entities from monolith.`);

    // 2. Clear buffers immediately to save heap
    const totalCount = entities.length;

    // 3. Create shards using rotational distribution
    console.log(`   🔄 Distributing into ${TOTAL_SHARDS} shards...`);
    const shards = Array.from({ length: TOTAL_SHARDS }, () => []);

    // Memory-efficient iteration: move references, then empty source
    while (entities.length > 0) {
        const entity = entities.pop();
        const shardIdx = entities.length % TOTAL_SHARDS;
        shards[shardIdx].push(entity);
    }

    // 4. Write shards and verify integrity
    let sumCount = 0;
    for (let i = 0; i < TOTAL_SHARDS; i++) {
        const shardData = shards[i];
        sumCount += shardData.length;

        const compressedShard = zlib.gzipSync(JSON.stringify(shardData));
        const outPath = path.join(DATA_DIR, `merged_shard_${i}.json.gz`);
        await fs.writeFile(outPath, compressedShard);

        // Dispose shard early
        shards[i] = null;
    }

    // 5. Final Integrity Check
    console.log(`\n⚖️ [Splitter] Integrity Verification:`);
    console.log(`   - Expected: ${totalCount}`);
    console.log(`   - Verified: ${sumCount}`);

    if (sumCount !== totalCount) {
        console.error(`   ❌ CRITICAL: Integrity Violation! Lost ${totalCount - sumCount} entities during split.`);
        process.exit(1);
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`✅ [Splitter] Decomposition complete in ${duration}s. Shards are ready for Factory 2/4.`);
}

splitRegistry().catch(err => {
    console.error(`\n❌ [Splitter] Fatal Error:`, err);
    process.exit(1);
});
