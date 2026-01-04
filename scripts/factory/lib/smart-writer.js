/**
 * Smart Writer Module V14.4
 * Constitution Reference: Art 2.2 (No Raw Data), Art 2.3 (Cache Safety Net)
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

/**
 * Generate SHA-256 hash of content
 */
export function generateHash(content) {
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Smart write - only write if content changed (Art 2.2)
 * @param {string} key - R2 object key
 * @param {Object} data - Data to write
 * @param {string} outputDir - Output directory
 * @returns {boolean} Whether write occurred
 */
export async function smartWrite(key, data, outputDir = './artifacts') {
    const content = JSON.stringify(data, null, 2);
    const localHash = generateHash(content);

    // Check remote hash (simulated - in real impl, use R2 HEAD request)
    const remoteHash = await getRemoteHash(key, outputDir);

    if (localHash === remoteHash) {
        console.log(`[SKIP] ${key} - no changes`);
        return false;
    }

    await writeToLocal(key, content, { checksum: localHash }, outputDir);
    console.log(`[WRITE] ${key} - updated`);
    return true;
}

async function getRemoteHash(key, outputDir) {
    try {
        const metaPath = path.join(outputDir, `${key}.meta.json`);
        const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
        return meta.checksum;
    } catch {
        return null;
    }
}

async function writeToLocal(key, content, metadata, outputDir) {
    const filePath = path.join(outputDir, key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
    await fs.writeFile(`${filePath}.meta.json`, JSON.stringify(metadata));
}

/**
 * Write with version rotation (Art 2.4)
 */
export async function writeWithVersioning(key, data, outputDir = './output') {
    const filePath = path.join(outputDir, key);
    const dir = path.dirname(filePath);
    const base = path.basename(filePath, '.json');

    await fs.mkdir(dir, { recursive: true });

    // Rotate versions
    try {
        const v2Path = path.join(dir, `${base}.v-2.json`);
        const v1Path = path.join(dir, `${base}.v-1.json`);
        const currentPath = filePath;

        // Delete v-2 if exists
        await fs.unlink(v2Path).catch(() => { });

        // Move v-1 to v-2
        await fs.rename(v1Path, v2Path).catch(() => { });

        // Move current to v-1
        await fs.rename(currentPath, v1Path).catch(() => { });
    } catch {
        // First write, no rotation needed
    }

    // Write new current
    const content = JSON.stringify(data, null, 2);
    const checksum = generateHash(content);

    await fs.writeFile(filePath, content);
    await fs.writeFile(`${filePath}.meta.json`, JSON.stringify({ checksum }));
}

/**
 * Sync to R2 backup (Art 2.3 Cache Safety Net)
 */
export async function backupToR2Output(sourcePath, outputDir = './output') {
    try {
        const content = await fs.readFile(sourcePath, 'utf-8');
        const destPath = path.join(outputDir, 'meta', 'backup', path.basename(sourcePath));
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, content);
        console.log(`[BACKUP] ${path.basename(sourcePath)}`);
    } catch (error) {
        console.warn(`[WARN] Backup failed: ${error.message}`);
    }
}
