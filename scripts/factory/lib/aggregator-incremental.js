/**
 * Aggregator Incremental Logic V16.11.0 (CES Compliant)
 * Extracted from aggregator-utils.js to meet Art 5.1 (250-line limit)
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

const TASK_OUTPUT_MAP = {
    'trending': ['output/cache/trending.json.gz'],
    'search': ['output/cache/search-core.json.gz', 'output/cache/search-manifest.json'],
    'rankings': ['output/cache/rankings', 'output/cache/category_stats.json'],
    'sitemap': ['output/sitemap.xml'],
    'relations': ['output/cache/relations.json.gz', 'output/cache/mesh/graph.json.gz'],
    'trend': ['output/cache/trend-data.json.gz']
};

/**
 * Check if a task should be skipped based on data checksum (V2.0 Incremental)
 */
export async function checkIncrementalProgress(taskId, entities, logicHash = '') {
    const checksumFile = './cache/task-checksums.json.gz';
    const dataHash = crypto.createHash('md5').update(JSON.stringify(entities.map(e => ({ id: e.id, fni: e.fni_score }))).substring(0, 1000000)).digest('hex');
    const combinedHash = crypto.createHash('md5').update(dataHash + logicHash).digest('hex');

    try {
        // 1. Check Checksum
        let data = await fs.readFile(checksumFile);
        if (data[0] === 0x1f && data[1] === 0x8b) {
            const zlib = await import('zlib');
            data = zlib.gunzipSync(data);
        }
        const checksums = JSON.parse(data.toString('utf-8'));

        if (checksums[taskId] === combinedHash) {
            // 2. Check File Existence (V18.2.3: Prevent "false skip" in CI)
            const requiredFiles = TASK_OUTPUT_MAP[taskId] || [];
            if (requiredFiles.length === 0) {
                console.log(`[INCREMENTAL] ⚡ Task ${taskId} checksum matches. Skipping.`);
                return true;
            }

            let allExist = true;
            for (const file of requiredFiles) {
                try {
                    await fs.access(path.resolve(process.cwd(), file));
                } catch {
                    allExist = false;
                    console.warn(`[INCREMENTAL] ⚠️ Task ${taskId} checksum matches but ${file} is missing. Re-running.`);
                    break;
                }
            }

            if (allExist) {
                console.log(`[INCREMENTAL] ⚡ Task ${taskId} checksum matches and files exist. Skipping.`);
                return true;
            }
        }
    } catch {
        // File missing or corrupt, assume first run
    }
    return false;
}

/**
 * Update task checksum after successful processing
 */
export async function updateTaskChecksum(taskId, entities, logicHash = '') {
    const checksumFile = './cache/task-checksums.json.gz';
    const dataHash = crypto.createHash('md5').update(JSON.stringify(entities.map(e => ({ id: e.id, fni: e.fni_score }))).substring(0, 1000000)).digest('hex');
    const combinedHash = crypto.createHash('md5').update(dataHash + logicHash).digest('hex');

    let checksums = {};
    try {
        let data = await fs.readFile(checksumFile);
        if (data[0] === 0x1f && data[1] === 0x8b) {
            const zlib = await import('zlib');
            data = zlib.gunzipSync(data);
        }
        checksums = JSON.parse(data.toString('utf-8'));
    } catch {
        // Try legacy fallback
        try {
            const data = await fs.readFile('./cache/task-checksums.json', 'utf-8');
            checksums = JSON.parse(data);
        } catch { }
    }

    checksums[taskId] = combinedHash;
    await fs.mkdir(path.dirname(checksumFile), { recursive: true });
    const zlib = await import('zlib');
    await fs.writeFile(checksumFile, zlib.gzipSync(JSON.stringify(checksums, null, 2)));
    console.log(`[INCREMENTAL] ✅ Updated combined checksum for ${taskId} (Compressed)`);
}
