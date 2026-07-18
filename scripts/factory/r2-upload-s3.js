/**
 * R2 Upload with S3 API - V16.8.3 Optimized
 * Modularized for CES Compliance (Art 5.1)
 */
import fs from 'fs/promises';
import path from 'path';
import { pathToFileURL } from 'url';
import dotenv from 'dotenv';
import { initR2Bridge, createR2ClientFFI, fetchAllR2ETagsFFI, uploadFileFFI, uploadFileMultipartFFI, headObjectIdentityFFI } from './lib/r2-bridge.js';
import { isSitemapIndex, isSitemapChild, publishSitemapIndex } from './lib/sitemap-publication.js';
import { isR5StagingPath } from './lib/r5-staging.js';

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

export function toRemotePath(localPath) {
    return localPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^output\//, '');
}

// Stamp the local-sync manifest with each file's hash. R5 FIX: a FAILED upload is
// NEVER stamped "synced" (else a never-uploaded file would be locally skipped next
// run). Failure path only — successful/skipped files are stamped exactly as before.
export function applySyncedHashes(localManifest, filesToUpload, failedPaths) {
    const failed = failedPaths || new Set();
    for (const file of filesToUpload) {
        const remotePath = toRemotePath(file.path);
        if (failed.has(remotePath)) continue;
        localManifest.hashes[remotePath] = file.localHash;
    }
    return localManifest;
}

export async function processQueue(s3, files, uploadedSet, checkpoint, r2ETagMap, deps = {}) {
    // R5 fence: the legacy fixed-key uploader NEVER touches the content-addressed
    // staging prefixes (data/blobs|cycles|quarantine). Even though the R2_PREFIX_FILTER
    // includes the broad `data/` prefix, an R5 staging path is excluded here, so the
    // legacy path's new-prefix PUT count is STRICTLY 0 in production (stage_disabled).
    const uploadOne = deps.uploadFile || uploadFileFFI;
    const uploadMulti = deps.uploadFileMultipart || uploadFileMultipartFFI;
    let success = 0, fail = 0, unchanged = 0, childFail = 0;
    const changedPaths = [];
    const failedPaths = new Set();
    const queue = files.filter(f => {
        const remotePath = toRemotePath(f.path);
        if (CONFIG.PREFIX_FILTER.length > 0 && !CONFIG.PREFIX_FILTER.some(p => remotePath.startsWith(p))) return false;
        if (isR5StagingPath(remotePath)) return false; // R5 fence — never via the legacy path
        // D-140 §5: the sitemap INDEX is NEVER part of the unordered Phase-1
        // concurrency batch. It is published in a separate Phase 2 (publishSitemapIndex)
        // strictly AFTER every referenced child is uploaded + remotely verified.
        if (isSitemapIndex(remotePath)) return false;
        return !uploadedSet.has(remotePath);
    });

    console.log(`📊 To upload: ${queue.length} files`);
    if (queue.length === 0) return { success: 0, fail: 0, skipped: files.length, unchanged: 0, changedPaths, childFail: 0, failedPaths };

    for (let i = 0; i < queue.length; i += CONFIG.CONCURRENCY) {
        const batch = queue.slice(i, i + CONFIG.CONCURRENCY);
        // V25.8 §2.2: Use multipart for fused-shard-*.bin (>8MB) when enabled
        const useMultipart = process.env.R2_MULTIPART_ENABLED === 'true';
        const results = await Promise.all(batch.map(file => {
            const remotePath = toRemotePath(file.path);
            if (useMultipart && file.size > 8 * 1024 * 1024 && remotePath.includes('fused-shard')) {
                return uploadMulti(s3, file.path, remotePath);
            }
            return uploadOne(s3, file.path, remotePath, r2ETagMap.get(remotePath));
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
                failedPaths.add(result.path); // R5: a FAILED upload must never be stamped "synced"
                // D-140 §5: a child-shard upload failure must block index publication.
                if (isSitemapChild(result.path)) childFail++;
            }
        }

        const processed = i + batch.length;
        const percent = ((processed / queue.length) * 100).toFixed(1);
        process.stdout.write(`\r   [PROGRESS] ${percent}% (${processed}/${queue.length}) | New: ${success}, Unchanged: ${unchanged}, Fail: ${fail}`);

        if ((success + unchanged) % 1000 === 0) await saveCheckpoint(checkpoint);
    }
    console.log(''); // New line after progress
    return { success, fail, skipped: files.length - queue.length, unchanged, changedPaths, childFail, failedPaths };
}

export async function main() {
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

    const { success, fail, skipped, unchanged, changedPaths, childFail, failedPaths } = await processQueue(s3, filesToUpload, new Set(checkpoint.uploaded), checkpoint, r2ETagMap);

    // Update local manifest with new hashes (R5 failed-never-synced fix in helper).
    applySyncedHashes(localManifest, filesToUpload, failedPaths);
    await saveLocalManifest(localManifestPath, localManifest);

    await saveCheckpoint(checkpoint);

    // D-140 §5 PHASE 2 — child-before-index publication barrier. Phase 1 above
    // uploaded every child shard (and all non-index objects) but NEVER the index.
    // Now (only after Phase 1) verify each referenced child exists on R2, then
    // publish the index. One missing/failed child -> index NOT published -> JOB_FAIL.
    const indexItems = allFiles
        .map(f => ({ localPath: f.path, remotePath: toRemotePath(f.path) }))
        .filter(it => isSitemapIndex(it.remotePath)
            && (CONFIG.PREFIX_FILTER.length === 0 || CONFIG.PREFIX_FILTER.some(p => it.remotePath.startsWith(p))));
    const candidate = indexItems.find(it => it.remotePath === 'sitemaps/sitemap-index.xml');
    let indexPublishFailed = false;
    if (candidate) {
        const pub = await publishSitemapIndex({
            phase1Ok: childFail === 0,
            indexItems,
            candidateIndexLocalPath: candidate.localPath,
            headFn: (rp) => headObjectIdentityFFI(s3, rp),
            uploadFn: (lp, rp) => uploadFileFFI(s3, lp, rp, r2ETagMap.get(rp)),
        });
        console.log(`[SITEMAP-PUBLISH] candidateChildren=${pub.candidateChildren} verifiedChildren=${pub.verifiedChildren} status=${pub.status} published=${pub.published}`);
        if (!pub.published) indexPublishFailed = true; // fail-loud: never downgrade to a warning.
    }

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
        .filter(p => (CONFIG.PREFIX_FILTER.length === 0 || CONFIG.PREFIX_FILTER.some(pf => p.startsWith(pf))) && !isR5StagingPath(p));
    await fs.writeFile(purgeListPath, JSON.stringify({
        changed: allManifestPaths, fresh_uploads: changedPaths, ts: new Date().toISOString(),
    }));
    console.log(`[PURGE-LIST] ${allManifestPaths.length} paths (full manifest, ${changedPaths.length} fresh) → ${purgeListPath}`);

    console.log(`\n✅ Upload Complete! New: ${success}, Locally Skipped: ${locallySkipped}, Unchanged on R2: ${unchanged}, Fail: ${fail}`);
    if (indexPublishFailed) {
        console.error('❌ JOB_FAIL: sitemap INDEX_NOT_PUBLISHED (child-before-index barrier). Old index left in place.');
        process.exit(1);
    }
    if (fail > 0) process.exit(1);
}

// The R5 fenced STAGE + VERIFY entrypoints live in lib/r5-staging.js and
// acceptance-staged-cycle.js (separate workflow steps) — NOT here — so this remains
// the sole (once-referenced) public CDN write step, fully covered by the FINAL_UPLOAD
// capacity gate. Exports above are behind this guard so tests can import without running.
const isMainModule = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) main().catch(err => { console.error('❌ Fatal error:', err); process.exit(1); });
