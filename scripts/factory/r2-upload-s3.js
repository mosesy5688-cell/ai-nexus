/**
 * R2 Upload with S3 API - V14.5 Phase 6
 * 
 * Uses @aws-sdk/client-s3 for batch uploads instead of wrangler CLI
 * - 10x faster than wrangler CLI (parallel uploads)
 * - More stable (connection pooling)
 * - Same cost (R2 Class A operations)
 * - V14.5: Smart Write - skip unchanged files via ETag comparison
 * 
 * Constitutional: Art 13.4 (Non-Destructive), Art 2.2 (No Raw Data)
 */
import { S3Client, PutObjectCommand, HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

// Configuration
const CONFIG = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: 'ai-nexus-assets',
    OUTPUT_DIR: './output',
    CONCURRENCY: 20,
    CHECKPOINT_FILE: './upload-checkpoint.json'
};

// Initialize S3 Client for R2
function createR2Client() {
    if (!CONFIG.ACCOUNT_ID || !CONFIG.ACCESS_KEY_ID || !CONFIG.SECRET_ACCESS_KEY) {
        console.error('❌ Missing R2 credentials:');
        console.error('   Required: CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
        process.exit(1);
    }

    return new S3Client({
        region: 'auto',
        endpoint: `https://${CONFIG.ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: CONFIG.ACCESS_KEY_ID,
            secretAccessKey: CONFIG.SECRET_ACCESS_KEY
        }
    });
}

// Load checkpoint
async function loadCheckpoint() {
    try {
        return JSON.parse(await fs.readFile(CONFIG.CHECKPOINT_FILE, 'utf-8'));
    } catch {
        return { uploaded: [], timestamp: Date.now() };
    }
}

// Save checkpoint
async function saveCheckpoint(checkpoint) {
    checkpoint.timestamp = Date.now();
    await fs.writeFile(CONFIG.CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

// Get all files recursively
async function getAllFiles(dir, files = []) {
    try {
        const items = await fs.readdir(dir);
        for (const item of items) {
            const fullPath = path.join(dir, item);
            const stat = await fs.stat(fullPath);
            if (stat.isDirectory()) {
                await getAllFiles(fullPath, files);
            } else {
                files.push({ path: fullPath, size: stat.size });
            }
        }
    } catch (e) {
        console.error(`❌ Directory not found: ${dir}`);
    }
    return files;
}

// Normalize file path to R2 key (remove output/ prefix, convert backslash)
function toRemotePath(localPath) {
    let remotePath = localPath.replace(/\\/g, '/');
    // Remove leading ./, output/, or ./output/
    remotePath = remotePath.replace(/^\.\//, '');
    remotePath = remotePath.replace(/^output\//, '');
    return remotePath;
}

// Upload single file using S3 API with Smart Write (V14.5)
// Uses smart-writer.js pattern: SHA-256 hash + .meta.json comparison
async function uploadFile(s3, localPath, remotePath) {
    try {
        const content = await fs.readFile(localPath);
        const contentType = remotePath.endsWith('.json') ? 'application/json' :
            remotePath.endsWith('.xml') ? 'application/xml' :
                remotePath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream';

        // V14.5 Smart Write: Compute local SHA-256 hash (consistent with smart-writer.js)
        const localHash = crypto.createHash('sha256').update(content).digest('hex');

        // Step 1: Check local .meta.json (fast path - no network call)
        try {
            const metaPath = `${localPath}.meta.json`;
            const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8'));
            if (meta.checksum === localHash) {
                return { success: true, path: remotePath, skipped: true };
            }
        } catch {
            // No .meta.json, proceed to R2 check
        }

        // Step 2: Check R2 ETag (MD5) via HeadObject as backup
        try {
            const headResult = await s3.send(new HeadObjectCommand({
                Bucket: CONFIG.BUCKET,
                Key: remotePath
            }));
            // R2 ETag is MD5, compute for comparison
            const localMD5 = crypto.createHash('md5').update(content).digest('hex');
            const remoteMD5 = headResult.ETag?.replace(/"/g, '');
            if (localMD5 === remoteMD5) {
                return { success: true, path: remotePath, skipped: true };
            }
        } catch (headErr) {
            // 404 means file doesn't exist - proceed with upload
            if (headErr.name !== 'NotFound' && headErr.$metadata?.httpStatusCode !== 404) {
                // Log but continue with upload
            }
        }

        // SPEC-BACKUP-V14.5 Section 3.1: Entity Versioning
        // Only version entity files (cache/entities/*.json)
        if (remotePath.startsWith('cache/entities/') && remotePath.endsWith('.json') && !remotePath.includes('.v-')) {
            try {
                // Step 1: Delete .v-2 if exists
                const v2Key = remotePath.replace('.json', '.v-2.json');
                await s3.send(new DeleteObjectCommand({ Bucket: CONFIG.BUCKET, Key: v2Key })).catch(() => { });

                // Step 2: Rename .v-1 to .v-2 (via copy + delete)
                const v1Key = remotePath.replace('.json', '.v-1.json');
                try {
                    await s3.send(new CopyObjectCommand({
                        Bucket: CONFIG.BUCKET,
                        CopySource: `${CONFIG.BUCKET}/${v1Key}`,
                        Key: v2Key
                    }));
                    await s3.send(new DeleteObjectCommand({ Bucket: CONFIG.BUCKET, Key: v1Key }));
                } catch (v1Err) {
                    // .v-1 doesn't exist, that's fine
                }

                // Step 3: Rename current to .v-1 (via copy + delete)
                try {
                    await s3.send(new CopyObjectCommand({
                        Bucket: CONFIG.BUCKET,
                        CopySource: `${CONFIG.BUCKET}/${remotePath}`,
                        Key: v1Key
                    }));
                } catch (renameErr) {
                    // Current doesn't exist, first upload
                }
            } catch (versionErr) {
                // Versioning failed, continue with upload anyway
                console.warn(`\n⚠️ Versioning failed for ${remotePath}: ${versionErr.message}`);
            }
        }

        // Upload new version
        await s3.send(new PutObjectCommand({
            Bucket: CONFIG.BUCKET,
            Key: remotePath,
            Body: content,
            ContentType: contentType
        }));
        return { success: true, path: remotePath, skipped: false };
    } catch (e) {
        console.error(`\n❌ Failed: ${remotePath} - ${e.message}`);
        return { success: false, path: remotePath, error: e.message };
    }
}

// Process queue with concurrency limit
async function processQueue(s3, files, uploadedSet, checkpoint) {
    let success = 0;
    let fail = 0;
    let unchanged = 0;  // V14.5: Smart Write skipped (content unchanged)

    // Filter out already uploaded files (from checkpoint)
    const queue = files.filter(f => {
        const remotePath = toRemotePath(f.path);
        return !uploadedSet.has(remotePath);
    });

    console.log(`📊 To upload: ${queue.length} files`);

    if (queue.length === 0) {
        console.log('✅ All files already uploaded!');
        return { success: 0, fail: 0, skipped: files.length, unchanged: 0 };
    }

    // Process in batches
    const batchSize = CONFIG.CONCURRENCY;
    for (let i = 0; i < queue.length; i += batchSize) {
        const batch = queue.slice(i, i + batchSize);
        const progress = ((i + batch.length) / queue.length * 100).toFixed(1);

        process.stdout.write(`\r[${progress}%] Uploading batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(queue.length / batchSize)}...`);

        const results = await Promise.all(batch.map(file => {
            const remotePath = toRemotePath(file.path);
            return uploadFile(s3, file.path, remotePath);
        }));

        for (const result of results) {
            if (result.success) {
                checkpoint.uploaded.push(result.path);
                if (result.skipped) {
                    unchanged++;  // V14.5: Content unchanged, skipped upload
                } else {
                    success++;
                }
            } else {
                fail++;
            }
        }

        // Save checkpoint every 500 files
        if ((success + unchanged) % 500 === 0 && (success + unchanged) > 0) {
            await saveCheckpoint(checkpoint);
            console.log(`\n💾 Checkpoint: ${success} uploaded, ${unchanged} unchanged`);
        }
    }

    return { success, fail, skipped: files.length - queue.length, unchanged };
}

async function main() {
    console.log('📤 V14.5 Smart Write R2 Upload');
    console.log('=====================================');

    const s3 = createR2Client();
    const checkpoint = await loadCheckpoint();
    const uploadedSet = new Set(checkpoint.uploaded);
    const allFiles = await getAllFiles(CONFIG.OUTPUT_DIR);

    console.log(`📊 Total files: ${allFiles.length}`);
    console.log(`📊 Already uploaded: ${uploadedSet.size}`);

    const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
    console.log(`📊 Total size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`⚡ Concurrency: ${CONFIG.CONCURRENCY}`);
    console.log(`🧠 Smart Write: Enabled (ETag comparison)`);

    const startTime = Date.now();
    const { success, fail, skipped, unchanged } = await processQueue(s3, allFiles, uploadedSet, checkpoint);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Final checkpoint
    await saveCheckpoint(checkpoint);

    console.log('\n');
    console.log('=====================================');
    console.log(`✅ Upload Complete in ${duration}s!`);
    console.log(`   New uploads: ${success}`);
    console.log(`   Unchanged (skipped): ${unchanged}`);
    console.log(`   Checkpoint skipped: ${skipped}`);
    console.log(`   Failed: ${fail}`);
    if (success > 0) {
        console.log(`   Rate: ${(success / parseFloat(duration)).toFixed(1)} files/sec`);
    }
    console.log('=====================================');

    if (fail > 0) {
        console.warn(`⚠️ ${fail} files failed. Re-run to retry.`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
