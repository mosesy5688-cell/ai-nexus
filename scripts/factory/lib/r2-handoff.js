// V25.8.3 R2 Handoff — Reusable backup/restore for inter-workflow data.
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
        // V25.13: Lowered from 1024B to 256B. Empirical: zstd-compressed index
        // JSON for ~30 entries ≈ 700-800B, well-formed. The 1024B guard was
        // false-positiving legitimate small indexes (e.g., RSS source files
        // got blocked → RSS empty for months). 256B still catches obviously
        // broken writes (empty file, single-byte).
        const minBytes = opts.minSize ?? 256;
        if (data.length < minBytes) {
            console.error(`[R2-HANDOFF] BLOCKED: ${localPath} is only ${data.length}B (min ${minBytes}B). Refusing upload to prevent state wipe.`);
            return { success: false, reason: 'below_minimum_size' };
        }
        const ext = path.extname(r2Key).toLowerCase();
        const contentType = {
            '.json': 'application/json', '.zst': 'application/zstd',
            '.gz': 'application/gzip', '.db': 'application/x-sqlite3',
            '.bin': 'application/octet-stream', '.ndjson': 'application/x-ndjson',
            '.tar': 'application/x-tar',
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
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: r2Key }));
        const chunks = []; for await (const c of resp.Body) chunks.push(c);
        const data = Buffer.concat(chunks);
        if (resp.ContentLength && data.length < resp.ContentLength * 0.9) { console.error(`[R2-HANDOFF] Truncated: ${r2Key} (${data.length}/${resp.ContentLength}B)`); return { success: false }; }
        await fs.writeFile(localPath, data);
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

    // Write manifest with FRESH client + retry (original client stale after 2000+ ops)
    const manifestBody = JSON.stringify({ files: manifest, timestamp: new Date().toISOString(), count: manifest.length });
    let mOk = false;
    for (let i = 0; i < 3 && !mOk; i++) {
        try { const fc = createR2Client(); await fc.send(new PutObjectCommand({ Bucket: BUCKET, Key: r2Prefix + '_manifest.json', Body: manifestBody, ContentType: 'application/json' })); mOk = true; }
        catch (e) { console.error(`[R2-HANDOFF] Manifest attempt ${i+1}/3: ${e.message || e.Code || JSON.stringify(e.$metadata || {})}`); if (i < 2) await new Promise(r => setTimeout(r, 2000*(i+1))); }
    }
    if (!mOk) console.error(`[R2-HANDOFF] ⚠️ MANIFEST WRITE FAILED (${manifest.length} entries)`);

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
    } catch (e) {
        console.log(`[R2-HANDOFF] No manifest for ${r2Prefix} (${e.name || 'error'}). Listing...`);
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
    const restoredPaths = new Set();
    for (let i = 0; i < fileKeys.length; i += concurrency) {
        const batch = fileKeys.slice(i, i + concurrency);
        const results = await Promise.allSettled(batch.map(async ({ key, rel }) => {
            const r = await restoreFileFromR2(key, path.join(localDir, rel));
            if (r.success) restoredPaths.add(rel);
            return r;
        }));
        restored += results.filter(r => r.status === 'fulfilled' && r.value.success).length;
    }
    const failed = fileKeys.length - restored;
    if (failed > 0) {
        console.warn(`[R2-HANDOFF] ${failed} files missed from manifest. Supplementing via ListObjects...`);
        let token;
        do {
            const resp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: r2Prefix, MaxKeys: 1000, ContinuationToken: token }));
            for (const obj of resp.Contents || []) {
                if (obj.Key.endsWith('_manifest.json')) continue;
                const rel = obj.Key.slice(r2Prefix.length);
                if (restoredPaths.has(rel)) continue;
                for (let retry = 0; retry < 2; retry++) {
                    const r = await restoreFileFromR2(obj.Key, path.join(localDir, rel)).catch(() => ({ success: false }));
                    if (r.success) { restored++; restoredPaths.add(rel); break; }
                    if (retry === 0) await new Promise(r => setTimeout(r, 1000));
                }
            }
            token = resp.NextContinuationToken;
        } while (token);
        console.log(`[R2-HANDOFF] After ListObjects: ${restored} files total`);
    }
    console.log(`[R2-HANDOFF] Directory restore: ${restored} files`);
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
