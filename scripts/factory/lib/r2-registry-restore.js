/**
 * V25.8 R2 Registry Restore — R2-Primary Data Sovereignty
 *
 * Downloads registry shards from R2 as the authoritative source.
 * Supports both Binary NXVF (.bin) and legacy JSON.gz formats.
 *
 * Priority chain:
 *   1. R2 meta/backup/registry/   (latest pipeline output)
 *   2. R2 vault/legacy/registry/  (bootstrap migration output)
 *   3. R2 meta/backup/global-registry.json.gz (monolith fallback)
 */

import fs from 'fs/promises';
import path from 'path';
import { createR2Client } from './r2-helpers.js';
import { ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const R2_BUCKET = process.env.R2_BUCKET || 'ai-nexus-assets';
const CACHE_DIR = process.env.CACHE_DIR || './cache';
const REGISTRY_DIR = path.join(CACHE_DIR, 'registry');
const NXVF_MAGIC = Buffer.from([0x4E, 0x58, 0x56, 0x46]); // "NXVF"
const REGISTRY_FLOOR = parseInt(process.env.REGISTRY_FLOOR || '85000');

/**
 * List all objects under an R2 prefix.
 */
async function listR2Objects(s3, prefix) {
    const objects = [];
    let token;
    do {
        const resp = await s3.send(new ListObjectsV2Command({
            Bucket: R2_BUCKET, Prefix: prefix, MaxKeys: 1000, ContinuationToken: token
        }));
        for (const obj of resp.Contents || []) objects.push(obj);
        token = resp.NextContinuationToken;
    } while (token);
    return objects;
}

/**
 * Download a single R2 object to local path. Returns bytes written.
 */
async function downloadObject(s3, key, localPath) {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of Body) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);
    if (buffer.length === 0) return 0;
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buffer);
    return buffer.length;
}

/**
 * Validate shard file format (NXVF binary or gzip).
 */
async function validateShard(filePath) {
    try {
        const header = Buffer.alloc(4);
        const fh = await fs.open(filePath, 'r');
        await fh.read(header, 0, 4, 0);
        await fh.close();
        if (header.equals(NXVF_MAGIC)) return 'nxvf';
        if (header[0] === 0x1f && header[1] === 0x8b) return 'gzip';
        return null;
    } catch (e) { console.warn(`[R2-RESTORE] validateShard ${filePath}: ${e.message}`); return null; }
}

/**
 * Restore registry shards from a specific R2 prefix.
 * Returns count of valid shards downloaded.
 */
async function restoreFromPrefix(s3, prefix, label) {
    console.log(`[R2-RESTORE] Scanning ${label}: ${prefix}`);
    const objects = await listR2Objects(s3, prefix);
    const allShards = objects.filter(o =>
        (o.Key.endsWith('.bin') || o.Key.endsWith('.json.gz')) &&
        o.Key.includes('part-') && o.Size > 0
    );

    // V25.8.3: Prefer .bin (NXVF binary) over legacy .json.gz.
    // If both formats exist for a shard, only download .bin to prevent ghost files.
    const binIds = new Set(allShards.filter(o => o.Key.endsWith('.bin'))
        .map(o => path.basename(o.Key).match(/part-(\d+)/)?.[1]).filter(Boolean));
    const shards = allShards.filter(o => {
        if (o.Key.endsWith('.json.gz')) {
            const id = path.basename(o.Key).match(/part-(\d+)/)?.[1];
            if (id && binIds.has(id)) return false; // .bin exists, skip legacy
        }
        return true;
    });

    if (shards.length === 0) {
        console.log(`[R2-RESTORE] No shards found at ${prefix}`);
        return 0;
    }

    const skipped = allShards.length - shards.length;
    console.log(`[R2-RESTORE] Found ${shards.length} shards at ${label}${skipped > 0 ? ` (skipped ${skipped} legacy .json.gz)` : ''}`);
    let valid = 0;

    for (const obj of shards) {
        const filename = path.basename(obj.Key);
        const localPath = path.join(REGISTRY_DIR, filename);

        // Skip if local file exists and is non-empty
        try {
            const stat = await fs.stat(localPath);
            if (stat.size > 0) {
                const fmt = await validateShard(localPath);
                if (fmt) { valid++; continue; }
            }
        } catch (e) { /* file missing or unreadable — download from R2 */ }

        try {
            const bytes = await downloadObject(s3, obj.Key, localPath);
            const fmt = await validateShard(localPath);
            if (fmt) {
                valid++;
                console.log(`  OK: ${filename} (${(bytes / 1024).toFixed(0)}KB, ${fmt})`);
            } else {
                console.warn(`  REJECT: ${filename} (invalid format, removing)`);
                await fs.unlink(localPath).catch(() => {});
            }
        } catch (e) {
            console.warn(`  FAIL: ${filename}: ${e.message}`);
        }
    }
    return valid;
}

/**
 * Restore monolith global-registry.json.gz from R2.
 */
async function restoreMonolith(s3) {
    const localPath = path.join(CACHE_DIR, 'global-registry.json.gz');
    try {
        const stat = await fs.stat(localPath);
        if (stat.size > 100 * 1024 * 1024) {
            console.log(`[R2-RESTORE] Monolith exists (${(stat.size / 1024 / 1024).toFixed(0)}MB), skipping`);
            return true;
        }
    } catch { /* doesn't exist */ }

    const key = 'meta/backup/global-registry.json.gz';
    try {
        const bytes = await downloadObject(s3, key, localPath);
        console.log(`[R2-RESTORE] Monolith restored (${(bytes / 1024 / 1024).toFixed(1)}MB)`);
        return bytes > 0;
    } catch (e) {
        console.warn(`[R2-RESTORE] Monolith restore failed: ${e.message}`);
        return false;
    }
}

/**
 * Main: R2-Primary Registry Restoration (V25.8)
 */
export async function restoreRegistryFromR2() {
    const s3 = createR2Client();
    if (!s3) {
        console.error('[R2-RESTORE] No R2 credentials. Cannot restore.');
        return { success: false, shards: 0 };
    }

    await fs.mkdir(REGISTRY_DIR, { recursive: true });

    // Priority 1: meta/backup/registry/ (latest pipeline output)
    let shardCount = await restoreFromPrefix(s3, 'meta/backup/registry/', 'Pipeline Backup');

    // Priority 2: vault/legacy/registry/ (bootstrap migration output)
    if (shardCount === 0) {
        shardCount = await restoreFromPrefix(s3, 'vault/legacy/registry/', 'Bootstrap Vault');
    }

    // Priority 3: Monolith fallback
    if (shardCount === 0) {
        const ok = await restoreMonolith(s3);
        if (ok) console.log('[R2-RESTORE] Monolith available as fallback');
    }

    // Also restore FNI history and checksums
    await restoreFromPrefix(s3, 'meta/backup/fni-history/', 'FNI History');

    // V55.9: Try .zst first, then legacy .gz
    const checksumPath = path.join(CACHE_DIR, 'entity-checksums.json.zst');
    try {
        await fs.stat(checksumPath);
    } catch {
        await downloadObject(s3, 'meta/backup/entity-checksums.json.zst', checksumPath)
            .catch(() => downloadObject(s3, 'meta/backup/entity-checksums.json.gz', path.join(CACHE_DIR, 'entity-checksums.json.gz')).catch(() => {}));
    }

    console.log(`[R2-RESTORE] Complete: ${shardCount} registry shards restored`);
    return { success: shardCount > 0, shards: shardCount };
}

// CLI entry point
if (process.argv[1]?.includes('r2-registry-restore')) {
    restoreRegistryFromR2().then(r => {
        if (!r.success) process.exit(1);
    }).catch(err => {
        console.error('[R2-RESTORE] Fatal:', err);
        process.exit(1);
    });
}
