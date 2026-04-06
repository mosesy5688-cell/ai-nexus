/**
 * V26.3 R2 Engine Bridge — Loads Rust N-API r2-engine; falls back to JS r2-helpers.js.
 *
 * Async functions: Rust returns Promise natively via napi-rs tokio runtime.
 * Rollback: Set R2_FORCE_JS=true to bypass Rust and use JS path.
 */

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _r2Engine = null;
let _mode = 'js';

function tryLoadR2Engine() {
    if (process.env.R2_FORCE_JS === 'true') return null;
    try {
        return require('../../../rust/r2-engine/r2-engine-rust.node');
    } catch { return null; }
}

/** Initialize R2 bridge. Call once at startup. */
export function initR2Bridge() {
    _r2Engine = tryLoadR2Engine();
    _mode = _r2Engine ? 'rust' : 'js';
    console.log(`[R2-BRIDGE] Mode: ${_mode}`);
    return _mode;
}

export function getR2Mode() { return _mode; }

/** Create R2 client — Rust opaque object or JS S3Client. */
export function createR2ClientFFI() {
    if (_r2Engine) {
        const config = {
            accountId: process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID || '',
            accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
            bucket: process.env.R2_BUCKET || 'ai-nexus-assets',
        };
        if (!config.accountId || !config.accessKeyId || !config.secretAccessKey) return null;
        return _r2Engine.createR2Client(config);
    }
    const { createR2Client } = require('./r2-helpers.js');
    return createR2Client();
}

/** Fetch all R2 ETags with optional prefix filtering. */
export async function fetchAllR2ETagsFFI(client, prefixFilter = []) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        const map = await _r2Engine.fetchAllR2Etags(client, prefixFilter);
        return new Map(Object.entries(map));
    }
    const { fetchAllR2ETags } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    return fetchAllR2ETags(client, bucket, prefixFilter);
}

/** Upload single file with MD5/ETag skip. */
export async function uploadFileFFI(client, localPath, remotePath, remoteETag) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        return _r2Engine.uploadFile(client, localPath, remotePath, remoteETag || null, 3);
    }
    const { uploadFile } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    return uploadFile(client, bucket, localPath, remotePath, remoteETag);
}

/** Multipart upload for files >8MB. */
export async function uploadFileMultipartFFI(client, localPath, remotePath) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        return _r2Engine.uploadFileMultipart(client, localPath, remotePath);
    }
    const { uploadFileMultipart } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    return uploadFileMultipart(client, bucket, localPath, remotePath);
}

/** Stream JSON to R2. */
export async function streamToR2FFI(client, key, data) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        const body = typeof data === 'string' ? data : JSON.stringify(data);
        return _r2Engine.streamToR2(client, key, body);
    }
    const { streamToR2 } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    return streamToR2(client, bucket, key, data);
}

/** Download from R2. Without localPath: returns parsed JSON (always JS). With localPath: writes to disk. */
export async function downloadFromR2FFI(client, key, localPath) {
    if (localPath && _r2Engine && client?.constructor?.name === 'R2Client') {
        return _r2Engine.downloadFromR2(client, key, localPath);
    }
    const { downloadFromR2 } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    const jsClient = client?.constructor?.name === 'R2Client' ? require('./r2-helpers.js').createR2Client() : client;
    return downloadFromR2(jsClient, bucket, key);
}

/** Download raw Buffer from R2 (for binary/compressed data). */
export async function downloadBufferFromR2FFI(client, key) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const jsClient = client?.constructor?.name === 'R2Client' ? require('./r2-helpers.js').createR2Client() : client;
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    const { Body } = await jsClient.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = []; for await (const c of Body) chunks.push(c);
    return Buffer.concat(chunks);
}

/** Upload a raw buffer to R2. */
export async function uploadBufferToR2FFI(client, key, buffer, contentType = 'application/octet-stream') {
    // V25.8.7: Always use S3 SDK for binary uploads.
    // Rust streamToR2 accepts String (base64) but uploads without decoding,
    // corrupting binary data (Zstd shards stored as base64 text on R2).
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const jsClient = (client?.constructor?.name === 'R2Client')
        ? require('./r2-helpers.js').createR2Client() : client;
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    await jsClient.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
    return true;
}

/** Walk directory with parallel MD5 hashing (Rust: 5-10x faster). */
export async function walkDirWithMd5FFI(dir, extensions) {
    if (_r2Engine) return _r2Engine.walkDirWithMd5(dir, extensions || null);
    // JS fallback: sequential walk + hash
    const fs = await import('fs/promises');
    const path = await import('path');
    const crypto = await import('crypto');
    const results = [];
    async function walk(current, prefix) {
        for (const entry of await fs.readdir(current, { withFileTypes: true }).catch(() => [])) {
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) { await walk(path.join(current, entry.name), rel); }
            else if (!extensions || extensions.some(ext => entry.name.endsWith(ext))) {
                const data = await fs.readFile(path.join(current, entry.name));
                results.push({ relPath: rel, size: data.length, md5: crypto.createHash('md5').update(data).digest('hex') });
            }
        }
    }
    await walk(dir, '');
    return results;
}

/** Batch upload with concurrency control. */
export async function batchUploadFFI(client, files, etagMap, concurrency) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        const etagObj = etagMap instanceof Map ? Object.fromEntries(etagMap) : etagMap;
        return _r2Engine.batchUpload(client, JSON.stringify(files), JSON.stringify(etagObj), concurrency);
    }
    // JS fallback: use processQueue pattern from r2-upload-s3.js
    const { uploadFile, uploadFileMultipart } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    let success = 0, failed = 0, unchanged = 0;
    for (const f of files) {
        const etag = etagMap instanceof Map ? etagMap.get(f.remotePath) : etagMap[f.remotePath];
        const r = await uploadFile(client, bucket, f.localPath, f.remotePath, etag);
        if (r.success) { r.skipped ? unchanged++ : success++; } else { failed++; }
    }
    return { success, failed, skipped: 0, unchanged, totalSize: 0 };
}

/** Backup directory to R2 with manifest. */
export async function backupDirectoryToR2FFI(client, localDir, r2Prefix, opts = {}) {
    // Resolve to absolute path to avoid cwd issues in Rust WalkDir
    const path = await import('path');
    const fs = await import('fs');
    const absDir = path.resolve(localDir);

    if (!fs.existsSync(absDir)) {
        console.warn(`[R2-BRIDGE] backup-dir: directory '${absDir}' does not exist`);
        return { count: 0 };
    }

    // List files for diagnostics
    const entries = fs.readdirSync(absDir);
    console.log(`[R2-BRIDGE] backup-dir: found ${entries.length} entries in ${absDir}`);

    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        // Walk with extensions filter, then upload
        const extFilter = opts.extensions || null;
        const walkResult = await _r2Engine.walkDirWithMd5(absDir, extFilter);
        console.log(`[R2-BRIDGE] backup-dir: ${walkResult.length} files matched filter`);

        let count = 0;
        for (const entry of walkResult) {
            const localPath = `${absDir}/${entry.relPath}`;
            const r2Key = `${r2Prefix}${entry.relPath}`;
            try {
                const data = fs.readFileSync(localPath);
                await _r2Engine.streamToR2(client, r2Key, data.toString('base64'));
                count++;
            } catch (e) {
                console.warn(`[R2-BRIDGE] backup-dir: failed to upload ${entry.relPath}: ${e.message}`);
            }
        }
        return { count };
    }
    const { backupDirectoryToR2 } = await import('./r2-handoff.js');
    return backupDirectoryToR2(absDir, r2Prefix, opts);
}

/** Restore directory from R2 (manifest-first, prefix-listing fallback). */
export async function restoreDirectoryFromR2FFI(client, r2Prefix, localDir, opts = {}) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        return _r2Engine.restoreDirectoryFromR2(client, r2Prefix, localDir, opts.concurrency);
    }
    const { restoreDirectoryFromR2 } = await import('./r2-handoff.js');
    return restoreDirectoryFromR2(r2Prefix, localDir, opts);
}

/** Backup a single file to R2. */
export async function backupFileToR2FFI(localPath, r2Key, opts = {}) {
    const { backupFileToR2 } = await import('./r2-handoff.js');
    return backupFileToR2(localPath, r2Key, opts);
}

/** Restore a single file from R2. */
export async function restoreFileFromR2FFI(r2Key, localPath, opts = {}) {
    if (_r2Engine) {
        const client = createR2ClientFFI();
        if (client) {
            const result = await _r2Engine.downloadFromR2(client, r2Key, localPath);
            if (result.success) {
                console.log(`[R2-BRIDGE] Restored ${r2Key} -> ${localPath}`);
                return { success: true, size: result.size };
            }
            return { success: false };
        }
    }
    const { restoreFileFromR2 } = await import('./r2-handoff.js');
    return restoreFileFromR2(r2Key, localPath, opts);
}

/** Purge uncompressed files that have Gzip equivalents (Zero Deletion Policy: disabled by default). */
export async function purgeEntropyFFI(client, etagMap) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        const etagObj = etagMap instanceof Map ? Object.fromEntries(etagMap) : etagMap;
        return _r2Engine.purgeEntropy(client, JSON.stringify(etagObj));
    }
    const { purgeEntropy } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    return purgeEntropy(client, bucket, etagMap);
}
