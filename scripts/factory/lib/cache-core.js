import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import crypto from 'crypto';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createR2Client } from './r2-helpers.js';

const getCacheDir = () => process.env.CACHE_DIR || './cache';
const getR2Prefix = () => process.env.R2_BACKUP_PREFIX || 'meta/backup/';
const getR2Bucket = () => process.env.R2_BUCKET || 'ai-nexus-assets';

/**
 * Load data with priority chain
 * V16.8.10: Zero-Trust Hardening (throws on critical failure)
 */
export async function loadWithFallback(filename, defaultValue = {}, isCritical = false) {
    const localPath = path.join(getCacheDir(), filename);

    try {
        if (process.env.FORCE_R2_RESTORE !== 'true') {
            const data = await fs.readFile(localPath, 'utf-8');
            console.log(`[CACHE] ✅ Loaded from local: ${filename}`);
            return JSON.parse(data);
        } else {
            console.log(`[CACHE] 🚀 Force R2 restore active. Skipping local: ${filename}`);
        }
    } catch {
        console.log(`[CACHE] Local cache miss: ${filename}`);
    }

    const r2Key = `${getR2Prefix()}${filename}`;
    const tempFile = path.join(os.tmpdir(), `r2-${filename.replace(/\//g, '-')}-${Date.now()}.json`);

    try {
        console.log(`[CACHE] R2 Restore: ${filename}...`);
        // Using wrangler for restore is fine as it's a GET (Class B)
        execSync(
            `npx wrangler r2 object get ${getR2Bucket()}/${r2Key} --file=${tempFile} --remote`,
            { stdio: 'pipe', timeout: 300000 }
        );
        const result = await fs.readFile(tempFile, 'utf-8');
        await fs.mkdir(getCacheDir(), { recursive: true });
        await fs.writeFile(localPath, result);
        await fs.unlink(tempFile).catch(() => { });
        return JSON.parse(result);
    } catch (err) {
        console.log(`[CACHE] ⚠️ R2 Restore Failed/Missing: ${filename}`);
        if (isCritical) {
            console.error(`[CRITICAL] Restoration failed for essential file: ${filename}`);
            console.error(`[CRITICAL] Error: ${err.stderr?.toString() || err.message}`);
            throw new Error(`Critical Restoration Failure: ${filename} - Pipeline Aborted to prevent data corruption.`);
        }
    }

    // 3. Fallback to default and PERSIST to disk to satisfy Path Validation (GitHub Cache Save)
    console.log(`[CACHE] ⚠️ Using default for: ${filename} (Initializing storage)`);
    await fs.mkdir(getCacheDir(), { recursive: true });
    await fs.writeFile(localPath, JSON.stringify(defaultValue, null, 2));

    return defaultValue;
}

/**
 * Save data to local cache and R2 backup
 * V16.8.6: Smart Sync (P0 Cost Fix)
 */
export async function saveWithBackup(filename, data) {
    const localPath = path.join(getCacheDir(), filename);
    const content = JSON.stringify(data);

    const dir = path.dirname(localPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(localPath, content);

    if (process.env.ENABLE_R2_BACKUP === 'true') {
        const s3 = createR2Client();
        if (!s3) {
            console.warn(`[CACHE] ⚠️ R2 backup skipped: Credentials missing`);
            return;
        }

        try {
            const r2Key = `${getR2Prefix()}${filename}`;
            const localMD5 = crypto.createHash('md5').update(content).digest('hex');

            // 1. Precise Check (Class B Operation: $0.36/1M)
            try {
                const head = await s3.send(new HeadObjectCommand({
                    Bucket: getR2Bucket(),
                    Key: r2Key
                }));
                const remoteHash = head.ETag?.replace(/"/g, '');

                if (localMD5 === remoteHash) {
                    console.log(`[CACHE] ⏭️ Skipped (Unchanged): ${r2Key}`);
                    return; // Saved $4.50 operation fee!
                }
            } catch (e) {
                if (e.name !== 'NotFound' && e.$metadata?.httpStatusCode !== 404) throw e;
            }

            // 2. Upload only if changed (Class A Operation: $4.50/1M)
            console.log(`[CACHE] ⬆️ Backing up (Changed): ${r2Key}`);
            await s3.send(new PutObjectCommand({
                Bucket: getR2Bucket(),
                Key: r2Key,
                Body: content,
                ContentType: 'application/json'
            }));
        } catch (err) {
            console.warn(`[CACHE] ⚠️ R2 backup failed: ${err.message}`);
        }
    }
}
