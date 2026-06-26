// V26.3 R2 Engine Bridge — Rust N-API r2-engine with JS fallback. Set R2_FORCE_JS=true to bypass Rust.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

let _r2Engine = null;
let _mode = 'js';
let _cachedJsClient = null;

function tryLoadR2Engine() {
    if (process.env.R2_FORCE_JS === 'true') return null;
    try {
        return require('../../../rust/r2-engine/r2-engine-rust.node');
    } catch (e) { console.warn(`[R2-BRIDGE] Rust FFI load failed: ${e.message}`); return null; }
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

/** Fetch all R2 ETags with optional prefix filtering. P2: directory-level LIST → S3 SDK. */
export async function fetchAllR2ETagsFFI(client, prefixFilter = []) {
    const { fetchAllR2ETags } = await import('./r2-helpers.js');
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    const s3 = (_r2Engine && client?.constructor?.name === 'R2Client')
        ? (_cachedJsClient ||= (await import('./r2-helpers.js')).createR2Client())
        : client;
    return fetchAllR2ETags(s3, bucket, prefixFilter);
}

// V25.13: Single-part with MD5 skip; auto-routes to multipart for files >2GB (R2's 5GB cap). Both paths stream from disk.
export async function uploadFileFFI(client, localPath, remotePath, remoteETag) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') {
        try {
            const { stat } = await import('fs/promises');
            if ((await stat(localPath)).size > 2147483648) return _r2Engine.uploadFileMultipart(client, localPath, remotePath);
        } catch { /* stat failed — use non-multipart path */ }
        return _r2Engine.uploadFile(client, localPath, remotePath, remoteETag || null, 3);
    }
    const { uploadFile } = await import('./r2-helpers.js');
    return uploadFile(client, process.env.R2_BUCKET || 'ai-nexus-assets', localPath, remotePath, remoteETag);
}

// Multipart upload for files >8MB. Streams 8MB chunks from disk per part.
export async function uploadFileMultipartFFI(client, localPath, remotePath) {
    if (_r2Engine && client?.constructor?.name === 'R2Client') return _r2Engine.uploadFileMultipart(client, localPath, remotePath);
    const { uploadFileMultipart } = await import('./r2-helpers.js');
    return uploadFileMultipart(client, process.env.R2_BUCKET || 'ai-nexus-assets', localPath, remotePath);
}

/**
 * HEAD a remote object to prove existence/identity (D-140 §5 child verification).
 * Returns { exists, etag }. 404 -> exists:false; any other error is surfaced
 * fail-loud (never masked as "missing"). Always uses the JS S3 client (the Rust
 * R2Client has no HEAD path); reuses the cached JS client for connection reuse.
 */
export async function headObjectIdentityFFI(client, remotePath) {
    const { HeadObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = (client && client.constructor?.name !== 'R2Client')
        ? client
        : (_cachedJsClient ||= require('./r2-helpers.js').createR2Client());
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    try {
        const r = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: remotePath }));
        return { exists: true, etag: r.ETag?.replace(/"/g, '') };
    } catch (e) {
        const code = e?.$metadata?.httpStatusCode, name = e?.name || '';
        if (code === 404 || name === 'NotFound' || name === 'NoSuchKey') return { exists: false, etag: undefined };
        throw new Error(`HEAD ${remotePath} failed: ${e?.message || name || 'unknown'}`);
    }
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

/** Download raw Buffer from R2 (binary/compressed). Caches JS S3Client for connection reuse. */
export async function downloadBufferFromR2FFI(client, key) {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    if (client?.constructor?.name === 'R2Client') {
        if (!_cachedJsClient) _cachedJsClient = require('./r2-helpers.js').createR2Client();
        client = _cachedJsClient;
    }
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    const { Body } = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const chunks = []; for await (const c of Body) chunks.push(c);
    return Buffer.concat(chunks);
}

export async function uploadBufferToR2FFI(client, key, buffer, contentType = 'application/octet-stream') {
    const jsClient = (client?.constructor?.name === 'R2Client') ? require('./r2-helpers.js').createR2Client() : client;
    const bucket = process.env.R2_BUCKET || 'ai-nexus-assets';
    if (buffer.length > 100 * 1024 * 1024) {
        const { Upload } = await import('@aws-sdk/lib-storage');
        await new Upload({ client: jsClient, params: { Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }, partSize: 64 * 1024 * 1024 }).done();
    } else {
        const { PutObjectCommand } = await import('@aws-sdk/client-s3');
        await jsClient.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: contentType }));
    }
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

/** Backup directory to R2 with manifest. P2: directory-level ops → AWS S3 SDK (reliable). */
export async function backupDirectoryToR2FFI(client, localDir, r2Prefix, opts = {}) {
    const path = await import('path');
    const fs = await import('fs');
    const absDir = path.resolve(localDir);
    if (!fs.existsSync(absDir)) { console.warn(`[R2-BRIDGE] backup-dir: '${absDir}' not found`); return { count: 0 }; }
    console.log(`[R2-BRIDGE] backup-dir: ${fs.readdirSync(absDir).length} entries in ${absDir}`);
    const { backupDirectoryToR2 } = await import('./r2-handoff.js');
    return backupDirectoryToR2(absDir, r2Prefix, opts);
}

/** Restore directory from R2. P2: directory-level ops → AWS S3 SDK (reliable). */
export async function restoreDirectoryFromR2FFI(client, r2Prefix, localDir, opts = {}) {
    const { restoreDirectoryFromR2 } = await import('./r2-handoff.js');
    return restoreDirectoryFromR2(r2Prefix, localDir, opts);
}

/** Backup a single file to R2. */
export async function backupFileToR2FFI(localPath, r2Key, opts = {}) {
    const { backupFileToR2 } = await import('./r2-handoff.js');
    return backupFileToR2(localPath, r2Key, opts);
}

/** Restore a single file from R2. Rust-first, JS fallback on Rust failure. */
export async function restoreFileFromR2FFI(r2Key, localPath, opts = {}) {
    if (_r2Engine) {
        const client = createR2ClientFFI();
        if (client) {
            try {
                const result = await _r2Engine.downloadFromR2(client, r2Key, localPath);
                if (result.success) return { success: true, size: result.size };
            } catch (e) { console.warn(`[R2-BRIDGE] Rust download failed for ${r2Key}: ${e.message || 'unknown'}`); }
        }
    }
    const { restoreFileFromR2 } = await import('./r2-handoff.js');
    return restoreFileFromR2(r2Key, localPath, opts);
}

/** Purge entropy. P2: cross-key batch op → S3 SDK. */
export async function purgeEntropyFFI(client, etagMap) {
    const { purgeEntropy } = await import('./r2-helpers.js');
    return purgeEntropy(client, process.env.R2_BUCKET || 'ai-nexus-assets', etagMap);
}
