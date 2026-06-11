/**
 * R2 Upload with S3 API - V16.8.3 Optimized
 * Modularized for CES Compliance (Art 5.1)
 */
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, uploadFileFFI, uploadFileMultipartFFI } from './lib/r2-bridge.js';

dotenv.config();

const CONFIG = {
    ACCOUNT_ID: process.env.R2_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CF_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: process.env.R2_BUCKET || 'ai-nexus-assets',
    OUTPUT_DIR: './output',
    CONCURRENCY: 50,
    CHECKPOINT_FILE: './upload-checkpoint.json',
    PREFIX_FILTER: (process.env.R2_PREFIX_FILTER ? process.env.R2_PREFIX_FILTER.split(',').map(s => s.trim()) : [])
};

// B4 absence-oracle skew closer. data/id-index.bin is a COMPLETE absence oracle:
// when it loads AND a lookup misses, the read path 404s with ZERO shard probes
// (src/lib/entity-absence-oracle.ts). Final Upload PUTs are NOT atomic (50-wide
// concurrent batches, unordered readdir), so index vs meta-NN.db land in any order.
// Bad direction = OLD index + NEW shards: a net-new entity whose meta row is live
// but whose key is absent from the stale index → oracle PROVES absence → false 404.
// Safe direction = NEW index over OLD shards: the new key RESOLVES, the shard is
// probed with the real SELECT, the row is merely not-yet-there → clean POST-PROBE
// 404 (pre-skew behavior), self-healing once the shard PUT lands. So the NEW index
// bytes must land AFTER all meta shards: hold id-index.bin out of the bulk phase and
// PUT it in a dedicated step that runs strictly after the bulk completes.
const DEFERRED_LAST_REMOTE = 'data/id-index.bin';

const ARGS = process.argv.slice(2);
const prefixArgIdx = ARGS.indexOf('--prefix');
if (prefixArgIdx !== -1 && ARGS[prefixArgIdx + 1]) {
    CONFIG.PREFIX_FILTER.push(ARGS[prefixArgIdx + 1].trim());
}

// createR2Client removed (using shared helper)

async function loadCheckpoint() {
    try {
        return JSON.parse(await fs.readFile(CONFIG.CHECKPOINT_FILE, 'utf-8'));
    } catch {
        return { uploaded: [], timestamp: Date.now() };
    }
}

async function saveCheckpoint(checkpoint) {
    checkpoint.timestamp = Date.now();
    await fs.writeFile(CONFIG.CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

async function getAllFiles(dir, files = []) {
    try {
        const items = await fs.readdir(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) await getAllFiles(fullPath, files);
            else files.push({ path: fullPath, size: stat.size });
        }
    } catch (e) { console.error(`❌ Directory not found: ${dir}`); }
    return files;
}

function toRemotePath(localPath) {
    return localPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^output\//, '');
}

async function processQueue(s3, files, uploadedSet, checkpoint, r2ETagMap, opts = {}) {
    const excludeRemote = opts.excludeRemote || null;
    let success = 0, fail = 0, unchanged = 0;
    const changedPaths = [];
    const queue = files.filter(f => {
        const remotePath = toRemotePath(f.path);
        if (CONFIG.PREFIX_FILTER.length > 0 && !CONFIG.PREFIX_FILTER.some(p => remotePath.startsWith(p))) return false;
        // B4: hold the absence-oracle index out of the bulk phase so it is PUT
        // strictly AFTER all meta shards (safe direction — see DEFERRED_LAST_REMOTE).
        if (excludeRemote && remotePath === excludeRemote) return false;
        return !uploadedSet.has(remotePath);
    });

    console.log(`📊 To upload: ${queue.length} files`);
    if (queue.length === 0) return { success: 0, fail: 0, skipped: files.length, unchanged: 0 };

    for (let i = 0; i < queue.length; i += CONFIG.CONCURRENCY) {
        const batch = queue.slice(i, i + CONFIG.CONCURRENCY);
        // V25.8 §2.2: Use multipart for fused-shard-*.bin (>8MB) when enabled
        const useMultipart = process.env.R2_MULTIPART_ENABLED === 'true';
        const results = await Promise.all(batch.map(file => {
            const remotePath = toRemotePath(file.path);
            if (useMultipart && file.size > 8 * 1024 * 1024 && remotePath.includes('fused-shard')) {
                return uploadFileMultipartFFI(s3, file.path, remotePath);
            }
            return uploadFileFFI(s3, file.path, remotePath, r2ETagMap.get(remotePath));
        }));

        for (const result of results) {
            if (result.success) {
                checkpoint.uploaded.push(result.path);
                if (result.skipped) {
                    unchanged++;
                } else {
                    changedPaths.push(result.path);
                    success++;
                }
            } else {
                console.error(`\n   [FAIL] Upload: ${result.path} | Error: ${result.error}`);
                fail++;
            }
        }

        const processed = i + batch.length;
        const percent = ((processed / queue.length) * 100).toFixed(1);
        process.stdout.write(`\r   [PROGRESS] ${percent}% (${processed}/${queue.length}) | New: ${success}, Unchanged: ${unchanged}, Fail: ${fail}`);

        if ((success + unchanged) % 1000 === 0) await saveCheckpoint(checkpoint);
    }
    console.log(''); // New line after progress
    return { success, fail, skipped: files.length - queue.length, unchanged, changedPaths };
}

/**
 * B4: PUT data/id-index.bin in a single ordered op strictly AFTER the bulk phase
 * (all meta-NN.db + every other data file). Guarantees the live index is never
 * newer than the shards it points into → closes the OLD-index + NEW-shards false-404
 * window. Honors PREFIX_FILTER, MD5 ETag skip, multipart, checkpoint and the
 * changed/purge set exactly as the bulk phase — SAME single PUT, only sequenced
 * (no per-file explosion, no 50MB-rule or backup-path impact).
 */
async function uploadDeferredIndex(s3, files, uploadedSet, checkpoint, r2ETagMap) {
    const target = files.find(f => toRemotePath(f.path) === DEFERRED_LAST_REMOTE);
    if (!target) {
        console.log(`[B4-ORDER] ${DEFERRED_LAST_REMOTE} not in this upload set (PREFIX_FILTER or absent) — no deferred PUT`);
        return { success: 0, fail: 0, unchanged: 0, changedPaths: [] };
    }
    const remotePath = toRemotePath(target.path);
    if (CONFIG.PREFIX_FILTER.length > 0 && !CONFIG.PREFIX_FILTER.some(p => remotePath.startsWith(p))) {
        return { success: 0, fail: 0, unchanged: 0, changedPaths: [] };
    }
    if (uploadedSet.has(remotePath)) {
        console.log(`[B4-ORDER] ${remotePath} already in checkpoint — skip`);
        return { success: 0, fail: 0, unchanged: 0, changedPaths: [] };
    }
    console.log(`[B4-ORDER] PUTting ${remotePath} LAST (after all meta shards) to close absence-oracle skew window`);
    const useMultipart = process.env.R2_MULTIPART_ENABLED === 'true';
    const result = (useMultipart && target.size > 8 * 1024 * 1024 && remotePath.includes('fused-shard'))
        ? await uploadFileMultipartFFI(s3, target.path, remotePath)
        : await uploadFileFFI(s3, target.path, remotePath, r2ETagMap.get(remotePath));
    if (!result.success) {
        console.error(`\n   [FAIL] Deferred index upload: ${result.path} | Error: ${result.error}`);
        return { success: 0, fail: 1, unchanged: 0, changedPaths: [] };
    }
    checkpoint.uploaded.push(result.path);
    if (result.skipped) {
        console.log(`[B4-ORDER] ${remotePath} unchanged on R2 (MD5 match) — no re-PUT`);
        return { success: 0, fail: 0, unchanged: 1, changedPaths: [] };
    }
    console.log(`[B4-ORDER] ${remotePath} PUT complete (new index live after shards)`);
    return { success: 1, fail: 0, unchanged: 0, changedPaths: [result.path] };
}

async function main() {
    const { loadLocalManifest, saveLocalManifest, calculateHash } = await import('./lib/local-sync.js');
    const localManifestPath = path.join(process.env.CACHE_DIR || './cache', 'last-upload-manifest.json');
    const localManifest = await loadLocalManifest(localManifestPath);

    initR2Bridge();
    const s3 = createR2ClientFFI();
    const r2ETagMap = await fetchAllR2ETagsFFI(s3, CONFIG.PREFIX_FILTER);
    const checkpoint = await loadCheckpoint();
    const allFiles = await getAllFiles(CONFIG.OUTPUT_DIR);

    // Filter files using local manifest to skip R2 network check if hash matches
    const filesToUpload = [];
    let locallySkipped = 0;

    for (const file of allFiles) {
        const remotePath = toRemotePath(file.path);
        const localHash = await calculateHash(file.path);

        // Layer 2 Defense: If local manifest says it's already uploaded and hash matches, we can skip R2 check
        if (localManifest.hashes[remotePath] === localHash && r2ETagMap.has(remotePath)) {
            locallySkipped++;
            continue;
        }

        filesToUpload.push({ ...file, localHash });
    }

    console.log(`[LOCAL-SYNC] Locally skipped: ${locallySkipped} files (MD5 matched manifest)`);

    // B4: bulk phase uploads EVERYTHING EXCEPT data/id-index.bin. The index is then
    // PUT last (after all meta shards) so the live oracle never points into shards
    // that have not yet landed (closes the OLD-index + NEW-shards false-404 window).
    const bulkUploadedSet = new Set(checkpoint.uploaded);
    const bulk = await processQueue(s3, filesToUpload, bulkUploadedSet, checkpoint, r2ETagMap, { excludeRemote: DEFERRED_LAST_REMOTE });
    // Only publish the NEW index once the bulk (incl. every meta shard) succeeded.
    // If a shard PUT failed, hold the index back so the live oracle keeps pointing
    // at the consistent prior shard set rather than a half-written one; the failed
    // run exits non-zero (below) and re-runs, PUTting the index after a clean bulk.
    const deferred = bulk.fail === 0
        ? await uploadDeferredIndex(s3, filesToUpload, bulkUploadedSet, checkpoint, r2ETagMap)
        : (console.warn(`[B4-ORDER] Bulk phase had ${bulk.fail} failure(s) — HOLDING ${DEFERRED_LAST_REMOTE} (no stale-shard index publish)`),
           { success: 0, fail: 0, unchanged: 0, changedPaths: [] });
    const success = bulk.success + deferred.success;
    const fail = bulk.fail + deferred.fail;
    const skipped = bulk.skipped;
    const unchanged = bulk.unchanged + deferred.unchanged;
    const changedPaths = [...(bulk.changedPaths || []), ...deferred.changedPaths];

    // Update local manifest with new successful hashes
    for (const file of filesToUpload) {
        const remotePath = toRemotePath(file.path);
        localManifest.hashes[remotePath] = file.localHash;
    }
    await saveLocalManifest(localManifestPath, localManifest);

    await saveCheckpoint(checkpoint);

    // V25.8: Zero Deletion Policy — Entropy Purge permanently disabled.
    // R2 storage is append-only. Manual cleanup via wrangler CLI if needed.
    // await purgeEntropyFFI(s3, r2ETagMap);

    // V27.3: purge-list covers ALL current-manifest paths (post PREFIX_FILTER), not only
    // freshly uploaded ones. Files whose MD5 matched the existing R2 ETag still leave us
    // unable to confirm CDN edge freshness — a prior R2 version of the same path may have
    // a stale Content-Length cached at the edge (Run 25952696104 shard-579 416 class).
    // Comprehensive purge by current-manifest closes that surface deterministically.
    const purgeListPath = path.join(process.env.CACHE_DIR || './cache', 'purge-list.json');
    const allManifestPaths = allFiles
        .map(f => toRemotePath(f.path))
        .filter(p => CONFIG.PREFIX_FILTER.length === 0 || CONFIG.PREFIX_FILTER.some(pf => p.startsWith(pf)));
    await fs.writeFile(purgeListPath, JSON.stringify({
        changed: allManifestPaths, fresh_uploads: changedPaths, ts: new Date().toISOString(),
    }));
    console.log(`[PURGE-LIST] ${allManifestPaths.length} paths (full manifest, ${changedPaths.length} fresh) → ${purgeListPath}`);

    console.log(`\n✅ Upload Complete! New: ${success}, Locally Skipped: ${locallySkipped}, Unchanged on R2: ${unchanged}, Fail: ${fail}`);
    if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('❌ Fatal error:', err); process.exit(1); });
