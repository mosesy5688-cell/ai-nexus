/**
 * Aggregator Incremental Logic V16.11.0 (CES Compliant)
 * Extracted from aggregator-utils.js to meet Art 5.1 (250-line limit)
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * Check if a task should be skipped based on data checksum (V2.0 Incremental)
 */
export async function checkIncrementalProgress(taskId, entities, logicHash = '') {
    const checksumFile = './cache/task-checksums.json.gz';
    const dataHash = crypto.createHash('md5').update(JSON.stringify(entities.map(e => ({ id: e.id, fni: e.fni_score }))).substring(0, 1000000)).digest('hex');
    const combinedHash = crypto.createHash('md5').update(dataHash + logicHash).digest('hex');

    try {
        let data = await fs.readFile(checksumFile);
        if (data[0] === 0x1f && data[1] === 0x8b) {
            const zlib = await import('zlib');
            data = zlib.gunzipSync(data);
        }
        const checksums = JSON.parse(data.toString('utf-8'));
        if (checksums[taskId] === combinedHash) {
            console.log(`[INCREMENTAL] ⚡ Task ${taskId} checksum matches (Data + Logic). Skipping processing.`);
            return true;
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
