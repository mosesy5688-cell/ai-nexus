/**
 * V25.8.3 R2 Handoff — Reusable backup/restore for inter-workflow data.
 * Replaces scattered inline `node -e` R2 scripts in workflow YAML files.
 */
import fs from 'fs/promises';
import path from 'path';
import { createR2Client } from './r2-helpers.js';
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

const BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';

/**
 * Backup a single local file to R2.
 * @param {string} localPath - Local file path
 * @param {string} r2Key - R2 object key
 * @param {object} opts - { fatal: false }
 * @returns {{ success: boolean, size?: number }}
 */
export async function backupFileToR2(localPath, r2Key, opts = {}) {
    const s3 = createR2Client();
    if (!s3) {
        console.warn('[R2-HANDOFF] No R2 credentials. Skipping backup.');
        return { success: false };
    }
    try {
        const data = await fs.readFile(localPath);
        const ext = path.extname(r2Key).toLowerCase();
        const contentType = {
            '.json': 'application/json', '.gz': 'application/gzip',
            '.db': 'application/x-sqlite3', '.bin': 'application/octet-stream',
            '.ndjson': 'application/x-ndjson', '.tar': 'application/x-tar',
        }[ext] || 'application/octet-stream';

        await s3.send(new PutObjectCommand({
            Bucket: BUCKET, Key: r2Key, Body: data, ContentType: contentType
        }));
        console.log(`[R2-HANDOFF] Backed up ${localPath} -> ${r2Key} (${(data.length/1024/1024).toFixed(1)}MB)`);
        return { success: true, size: data.length };
    } catch (e) {
        console.error(`[R2-HANDOFF] Backup failed: ${e.message}`);
        if (opts.fatal) throw e;
        return { success: false };
    }
}

/**
 * Restore a single file from R2 to local path.
 * @param {string} r2Key - R2 object key
 * @param {string} localPath - Local file path
 * @param {object} opts - { fatal: false }
 * @returns {{ success: boolean, size?: number }}
 */
export async function restoreFileFromR2(r2Key, localPath, opts = {}) {
    const s3 = createR2Client();
    if (!s3) {
        console.warn('[R2-HANDOFF] No R2 credentials. Skipping restore.');
        return { success: false };
    }
    try {
        const dir = path.dirname(localPath);
        await fs.mkdir(dir, { recursive: true });
        const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }));
        const chunks = [];
        for await (const c of Body) chunks.push(c);
        const data = Buffer.concat(chunks);
        await fs.writeFile(localPath, data);
        console.log(`[R2-HANDOFF] Restored ${r2Key} -> ${localPath} (${(data.length/1024/1024).toFixed(1)}MB)`);
        return { success: true, size: data.length };
    } catch (e) {
        console.error(`[R2-HANDOFF] Restore failed for ${r2Key}: ${e.message}`);
        if (opts.fatal) throw e;
        return { success: false };
    }
}

/**
 * Backup an entire local directory to R2 under a prefix.
 * Writes a _manifest.json for efficient restore.
 * @param {string} localDir - Local directory path
 * @param {string} r2Prefix - R2 key prefix (e.g. 'state/cycle-output/')
 * @param {object} opts - { concurrency: 5, fatal: false, extensions: null }
 * @returns {{ success: boolean, count: number, totalSize: number }}
 */
export async function backupDirectoryToR2(localDir, r2Prefix, opts = {}) {
    const s3 = createR2Client();
    if (!s3) {
        console.warn('[R2-HANDOFF] No R2 credentials. Skipping directory backup.');
        return { success: false, count: 0, totalSize: 0 };
    }
    const { concurrency = 5, extensions = null } = opts;
    const files = await walkDir(localDir, extensions);
    if (files.length === 0) {
        console.warn(`[R2-HANDOFF] No files found in ${localDir}`);
        return { success: false, count: 0, totalSize: 0 };
    }

    console.log(`[R2-HANDOFF] Backing up ${files.length} files from ${localDir} to ${r2Prefix}...`);
    let uploaded = 0, totalSize = 0;
    const manifest = [];

    // Process in batches for concurrency control
    for (let i = 0; i < files.length; i += concurrency) {
        const batch = files.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(async (relPath) => {
            const localPath = path.join(localDir, relPath);
            const r2Key = r2Prefix + relPath.replace(/\\/g, '/');
            const result = await backupFileToR2(localPath, r2Key);
            if (result.success) {
                manifest.push(relPath.replace(/\\/g, '/'));
                totalSize += result.size || 0;
            }
            return result;
        }));
        uploaded += results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    }

    // Write manifest for efficient restore
    const manifestKey = r2Prefix + '_manifest.json';
    try {
        await s3.send(new PutObjectCommand({
            Bucket: BUCKET, Key: manifestKey,
            Body: JSON.stringify({ files: manifest, timestamp: new Date().toISOString(), count: manifest.length }),
            ContentType: 'application/json'
        }));
    } catch { /* non-fatal */ }

    console.log(`[R2-HANDOFF] Directory backup: ${uploaded}/${files.length} files (${(totalSize/1024/1024).toFixed(1)}MB)`);
    return { success: uploaded > 0, count: uploaded, totalSize };
}

/**
 * Restore a directory from R2 using manifest (fast) or prefix listing (fallback).
 * @param {string} r2Prefix - R2 key prefix
 * @param {string} localDir - Local directory to restore to
 * @param {object} opts - { concurrency: 5, fatal: false }
 * @returns {{ success: boolean, count: number }}
 */
export async function restoreDirectoryFromR2(r2Prefix, localDir, opts = {}) {
    const s3 = createR2Client();
    if (!s3) {
        console.warn('[R2-HANDOFF] No R2 credentials. Skipping directory restore.');
        return { success: false, count: 0 };
    }
    const { concurrency = 5 } = opts;

    // Try manifest-based restore first (faster, no listing needed)
    let fileKeys = [];
    try {
        const { Body } = await s3.send(new GetObjectCommand({
            Bucket: BUCKET, Key: r2Prefix + '_manifest.json'
        }));
        const chunks = [];
        for await (const c of Body) chunks.push(c);
        const manifest = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        fileKeys = (manifest.files || []).map(f => ({ key: r2Prefix + f, rel: f }));
        console.log(`[R2-HANDOFF] Manifest found: ${fileKeys.length} files`);
    } catch {
        // Fallback: list all objects under prefix
        console.log(`[R2-HANDOFF] No manifest. Listing ${r2Prefix}...`);
        let token;
        do {
            const resp = await s3.send(new ListObjectsV2Command({
                Bucket: BUCKET, Prefix: r2Prefix, MaxKeys: 1000, ContinuationToken: token
            }));
            for (const obj of resp.Contents || []) {
                if (obj.Key.endsWith('_manifest.json')) continue;
                const rel = obj.Key.slice(r2Prefix.length);
                fileKeys.push({ key: obj.Key, rel });
            }
            token = resp.NextContinuationToken;
        } while (token);
    }

    if (fileKeys.length === 0) {
        console.warn(`[R2-HANDOFF] No files found under ${r2Prefix}`);
        return { success: false, count: 0 };
    }

    console.log(`[R2-HANDOFF] Restoring ${fileKeys.length} files to ${localDir}...`);
    let restored = 0;
    for (let i = 0; i < fileKeys.length; i += concurrency) {
        const batch = fileKeys.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(({ key, rel }) => {
            const localPath = path.join(localDir, rel);
            return restoreFileFromR2(key, localPath);
        }));
        restored += results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    }

    console.log(`[R2-HANDOFF] Directory restore: ${restored}/${fileKeys.length} files`);
    return { success: restored > 0, count: restored };
}

/**
 * Walk a directory recursively, return relative file paths.
 */
async function walkDir(dir, extensions = null) {
    const results = [];
    async function walk(current, prefix) {
        const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(path.join(current, entry.name), relPath);
            } else if (!extensions || extensions.some(ext => entry.name.endsWith(ext))) {
                results.push(relPath);
            }
        }
    }
    await walk(dir, '');
    return results;
}

// CLI entry point
if (process.argv[1]?.endsWith('r2-handoff.js')) {
    const [action, src, dest] = process.argv.slice(2);
    if (action === 'backup-dir') {
        backupDirectoryToR2(src, dest).then(r => console.log(JSON.stringify(r)));
    } else if (action === 'restore-dir') {
        restoreDirectoryFromR2(src, dest).then(r => console.log(JSON.stringify(r)));
    } else {
        console.log('Usage: r2-handoff.js <backup-dir|restore-dir> <src> <dest>');
    }
}
