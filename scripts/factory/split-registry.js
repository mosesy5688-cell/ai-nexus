/**
 * Registry Splitter Utility V18.12.5.5 (Streaming Edition)
 * 
 * Responsibilities:
 * 1. Load the monolithic merged.json.gz (NDJSON format).
 * 2. Split it into 20 shards via streaming to bypass 4GB Buffer limit.
 * 3. Perform a mandatory count integrity check.
 */

import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import readline from 'readline';

const TOTAL_SHARDS = 20;
const DATA_DIR = 'data';
const INPUT_FILE = path.join(DATA_DIR, 'merged.json.gz');

async function splitRegistry() {
    console.log(`\n🔪 [Splitter] Starting monolithic registry decomposition (Streaming)...`);

    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`❌ [Splitter] ERROR: Monolith ${INPUT_FILE} not found!`);
        process.exit(1);
    }

    const startTime = Date.now();
    let totalCount = 0;
    const shards = Array.from({ length: TOTAL_SHARDS }, () => []);

    // 1. Create Streaming Reader
    const fileStream = fs.createReadStream(INPUT_FILE);
    const gunzip = zlib.createGunzip();
    const rl = readline.createInterface({
        input: fileStream.pipe(gunzip),
        crlfDelay: Infinity
    });

    console.log(`   🔄 Decompressing and distributing into ${TOTAL_SHARDS} shards...`);

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const entity = JSON.parse(line);
            const shardIdx = totalCount % TOTAL_SHARDS;
            shards[shardIdx].push(entity);
            totalCount++;

            if (totalCount % 50000 === 0) {
                console.log(`   ⏳ Processed ${totalCount} entities...`);
            }
        } catch (e) {
            console.error(`   ⚠️ Failed to parse line ${totalCount + 1}: ${e.message}`);
        }
    }

    // 2. Write shards and verify integrity
    let sumCount = 0;
    for (let i = 0; i < TOTAL_SHARDS; i++) {
        const shardData = shards[i];
        sumCount += shardData.length;

        const outPath = path.join(DATA_DIR, `merged_shard_${i}.json.gz`);
        const compressedShard = zlib.gzipSync(JSON.stringify(shardData));
        fs.writeFileSync(outPath, compressedShard);

        // Dispose shard early to free memory
        shards[i] = null;
    }

    // 3. Final Integrity Check
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
