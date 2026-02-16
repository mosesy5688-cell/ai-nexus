/**
 * Registry Splitter Utility V18.12.5.6 (Standard Edition)
 * 
 * Responsibilities:
 * 1. Load the monolithic merged.json.gz (Standard JSON Array).
 * 2. Split it into 20 shards required for Stage 2/4 Matrix Processing.
 * 3. Perform a mandatory count integrity check.
 * 
 * V18.12.5.6: Reverted from NDJSON to standard full-load JSON as requested.
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

const TOTAL_SHARDS = 20;
const DATA_DIR = 'data';
const INPUT_FILE = path.join(DATA_DIR, 'merged.json.gz');
const INPUT_FILE_PLAIN = path.join(DATA_DIR, 'merged.json');

async function splitRegistry() {
    console.log(`\n🔪 [Splitter] Starting monolithic registry decomposition (Standard)...`);

    const targetFile = (await fs.stat(INPUT_FILE).catch(() => null)) ? INPUT_FILE : INPUT_FILE_PLAIN;

    if (!await fs.stat(targetFile).catch(() => null)) {
        console.error(`❌ [Splitter] ERROR: Monolith ${targetFile} not found!`);
        process.exit(1);
    }

    // 1. Load and decompress monolith
    const startTime = Date.now();
    const data = await fs.readFile(targetFile);

    let entities;
    const isGzip = (data[0] === 0x1f && data[1] === 0x8b);

    if (isGzip) {
        console.log(`   💿 Decompressing ${targetFile}...`);
        const decompressed = zlib.gunzipSync(data);
        entities = JSON.parse(decompressed.toString('utf-8'));
    } else {
        console.log(`   💿 Loading plain JSON ${targetFile}...`);
        entities = JSON.parse(data.toString('utf-8'));
    }

    const totalCount = entities.length;
    console.log(`   ✓ Loaded ${totalCount} entities from monolith.`);

    // 2. Create shards using rotational distribution
    console.log(`   🔄 Distributing into ${TOTAL_SHARDS} shards...`);
    const shards = Array.from({ length: TOTAL_SHARDS }, () => []);

    // Memory-efficient iteration: move references, then empty source
    while (entities.length > 0) {
        const entity = entities.pop();
        const shardIdx = entities.length % TOTAL_SHARDS;
        shards[shardIdx].push(entity);
    }

    // 3. Write shards and verify integrity
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

    // 4. Final Integrity Check
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
