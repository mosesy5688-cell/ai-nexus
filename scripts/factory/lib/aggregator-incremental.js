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
    const checksumFile = './cache/task-checksums.json';
    const dataHash = crypto.createHash('md5').update(JSON.stringify(entities.map(e => ({ id: e.id, fni: e.fni_score }))).substring(0, 1000000)).digest('hex');
    const combinedHash = crypto.createHash('md5').update(dataHash + logicHash).digest('hex');

    try {
        const data = await fs.readFile(checksumFile, 'utf-8');
        const checksums = JSON.parse(data);
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
    const checksumFile = './cache/task-checksums.json';
    const dataHash = crypto.createHash('md5').update(JSON.stringify(entities.map(e => ({ id: e.id, fni: e.fni_score }))).substring(0, 1000000)).digest('hex');
    const combinedHash = crypto.createHash('md5').update(dataHash + logicHash).digest('hex');

    let checksums = {};
    try {
        const data = await fs.readFile(checksumFile, 'utf-8');
        checksums = JSON.parse(data);
    } catch {
        // No problem
    }

    checksums[taskId] = combinedHash;
    await fs.mkdir(path.dirname(checksumFile), { recursive: true });
    await fs.writeFile(checksumFile, JSON.stringify(checksums, null, 2));
    console.log(`[INCREMENTAL] ✅ Updated combined checksum for ${taskId}`);
}
