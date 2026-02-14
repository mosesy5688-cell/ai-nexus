/**
 * Smart Writer Module V14.4
 * Constitution Reference: Art 2.2 (No Raw Data), Art 2.3 (Cache Safety Net)
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import zlib from 'zlib';

/**
 * Generate MD5 hash of content (Aligned with S3 ETag for Gzip support)
 */
export function generateHash(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}

/**
 * Smart write - only write if content changed (Art 2.2)
 * @param {string} key - R2 object key
 * @param {Object} data - Data to write
 * @param {string} outputDir - Output directory
 * @returns {boolean} Whether write occurred
 */
export async function smartWrite(key, data, outputDir = './output') {
    const content = JSON.stringify(data);
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
        const meta = JSON.parse(await fs.readFile(metaPath));
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
 * Smart Write with Version Rotation (Art 2.2 + Art 2.4)
 * - Only writes if content changed (saves operations)
 * - Maintains 3-version history for data safety
 * @param {string} key - R2 object key
 * @param {Object} data - Data to write
 * @param {string} outputDir - Output directory
 * @param {Object} options - { compress: boolean }
 * @returns {boolean} Whether write occurred
 */
export async function smartWriteWithVersioning(key, data, outputDir = './output', options = {}) {
    let content = JSON.stringify(data);
    let finalKey = key;

    // V18.2.3: Unified Compression Logic
    // If extension is .gz OR options.compress is true, we MUST compress.
    const shouldCompress = options.compress || key.endsWith('.gz');

    if (shouldCompress) {
        content = zlib.gzipSync(content);
        if (!finalKey.endsWith('.gz')) {
            finalKey += '.gz';
        }
    }

    const localHash = generateHash(content);

    // Check if content changed (Art 2.2)
    const remoteHash = await getRemoteHash(finalKey, outputDir);
    if (localHash === remoteHash) {
        return false; // No changes, skip silently
    }

    const filePath = path.join(outputDir, finalKey);
    const dir = path.dirname(filePath);

    // Determine base name for versioning, stripping either .json or .json.gz
    const ext = finalKey.endsWith('.gz') ? '.json.gz' : '.json';
    const base = path.basename(filePath, ext);

    await fs.mkdir(dir, { recursive: true });

    // Rotate versions (Art 2.4: Keep 3 versions max)
    const v2Path = path.join(dir, `${base}.v-2${ext}`);
    const v1Path = path.join(dir, `${base}.v-1${ext}`);

    // Delete v-2 (oldest)
    await fs.unlink(v2Path).catch(() => { });
    // Move v-1 to v-2
    await fs.rename(v1Path, v2Path).catch(() => { });
    // Move current to v-1
    await fs.rename(filePath, v1Path).catch(() => { });

    // Write new current version
    await fs.writeFile(filePath, content);
    await fs.writeFile(`${filePath}.meta.json`, JSON.stringify({ checksum: localHash }));

    return true;
}

// Keep original for backward compatibility
export async function writeWithVersioning(key, data, outputDir = './output', options = {}) {
    return smartWriteWithVersioning(key, data, outputDir, options);
}

/**
 * Sync to R2 backup (Art 2.3 Cache Safety Net)
 */
export async function backupToR2Output(sourcePath, outputDir = './output') {
    try {
        const content = await fs.readFile(sourcePath);
        const destPath = path.join(outputDir, 'meta', 'backup', path.basename(sourcePath));
        await fs.mkdir(path.dirname(destPath), { recursive: true });
        await fs.writeFile(destPath, content);
        console.log(`[BACKUP] ${path.basename(sourcePath)}`);
    } catch (error) {
        console.warn(`[WARN] Backup failed: ${error.message}`);
    }
}
