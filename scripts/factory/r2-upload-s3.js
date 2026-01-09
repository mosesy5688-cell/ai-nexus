/**
 * R2 Upload with S3 API - V15.0 Optimized
 * 
 * Key Optimization: Uses ListObjectsV2 to batch-fetch ETags upfront
 * instead of per-file HeadObject calls (100K requests -> ~100 requests)
 * 
 * Constitutional: Art 13.4 (Non-Destructive), Art 5.1 (Modular)
 */
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { rotateEntityVersions } from './lib/entity-versioner.js';

// Configuration
const CONFIG = {
    ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
    ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    BUCKET: 'ai-nexus-assets',
    OUTPUT_DIR: './output',
    CONCURRENCY: 50,  // V15: Increased from 20
    CHECKPOINT_FILE: './upload-checkpoint.json'
};

function createR2Client() {
    if (!CONFIG.ACCOUNT_ID || !CONFIG.ACCESS_KEY_ID || !CONFIG.SECRET_ACCESS_KEY) {
        console.error('❌ Missing R2 credentials');
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

// V15: Batch fetch all R2 ETags upfront (100-200 API calls instead of 100K+)
async function fetchAllR2ETags(s3) {
    console.log('📥 Fetching R2 ETags (batch mode)...');
    const startTime = Date.now();
    const etagMap = new Map();
    let continuationToken = undefined;
    let pageCount = 0;

    do {
        const response = await s3.send(new ListObjectsV2Command({
            Bucket: CONFIG.BUCKET,
            MaxKeys: 1000,
            ContinuationToken: continuationToken
        }));

        for (const obj of response.Contents || []) {
            etagMap.set(obj.Key, obj.ETag?.replace(/"/g, ''));
        }

        pageCount++;
        continuationToken = response.NextContinuationToken;
        process.stdout.write(`\r   Pages: ${pageCount}, Objects: ${etagMap.size}`);
    } while (continuationToken);

    console.log(`\n   ✅ Loaded ${etagMap.size} ETags in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    return etagMap;
}

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

function toRemotePath(localPath) {
    let remotePath = localPath.replace(/\\/g, '/');
    remotePath = remotePath.replace(/^\.\//, '');
    remotePath = remotePath.replace(/^output\//, '');
    return remotePath;
}

// V15: Fast upload - ETag already fetched, no per-file HEAD call
async function uploadFile(s3, localPath, remotePath, remoteETag) {
    try {
        const content = await fs.readFile(localPath);
        const localMD5 = crypto.createHash('md5').update(content).digest('hex');

        // V15: Compare with pre-fetched ETag (no network call!)
        if (localMD5 === remoteETag) {
            return { success: true, path: remotePath, skipped: true };
        }

        const contentType = remotePath.endsWith('.json') ? 'application/json' :
            remotePath.endsWith('.xml') ? 'application/xml' :
                remotePath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream';

        // Entity versioning for hot data
        if (remotePath.includes('cache/') || remotePath.includes('entities/')) {
            await rotateEntityVersions(s3, CONFIG.BUCKET, remotePath).catch(() => { });
        }

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

async function processQueue(s3, files, uploadedSet, checkpoint, r2ETagMap) {
    let success = 0, fail = 0, unchanged = 0;

    const queue = files.filter(f => {
        const remotePath = toRemotePath(f.path);
        return !uploadedSet.has(remotePath);
    });

    console.log(`📊 To upload: ${queue.length} files`);
    if (queue.length === 0) {
        console.log('✅ All files already uploaded!');
        return { success: 0, fail: 0, skipped: files.length, unchanged: 0 };
    }

    const batchSize = CONFIG.CONCURRENCY;
    for (let i = 0; i < queue.length; i += batchSize) {
        const batch = queue.slice(i, i + batchSize);
        const progress = ((i + batch.length) / queue.length * 100).toFixed(1);
        process.stdout.write(`\r[${progress}%] Uploading batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(queue.length / batchSize)}...`);

        const results = await Promise.all(batch.map(file => {
            const remotePath = toRemotePath(file.path);
            const remoteETag = r2ETagMap.get(remotePath);
            return uploadFile(s3, file.path, remotePath, remoteETag);
        }));

        for (const result of results) {
            if (result.success) {
                checkpoint.uploaded.push(result.path);
                if (result.skipped) unchanged++;
                else success++;
            } else {
                fail++;
            }
        }

        if ((success + unchanged) % 1000 === 0 && (success + unchanged) > 0) {
            await saveCheckpoint(checkpoint);
        }
    }

    return { success, fail, skipped: files.length - queue.length, unchanged };
}

async function main() {
    console.log('📤 V15.0 Optimized R2 Upload (Batch ETag)');
    console.log('=========================================');

    const s3 = createR2Client();

    // V15: Fetch all ETags upfront (this is the key optimization)
    const r2ETagMap = await fetchAllR2ETags(s3);

    const checkpoint = await loadCheckpoint();
    const uploadedSet = new Set(checkpoint.uploaded);
    const allFiles = await getAllFiles(CONFIG.OUTPUT_DIR);

    console.log(`📊 Local files: ${allFiles.length}`);
    console.log(`📊 R2 objects: ${r2ETagMap.size}`);
    console.log(`📊 Checkpoint: ${uploadedSet.size}`);
    console.log(`⚡ Concurrency: ${CONFIG.CONCURRENCY}`);

    const startTime = Date.now();
    const { success, fail, skipped, unchanged } = await processQueue(s3, allFiles, uploadedSet, checkpoint, r2ETagMap);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    await saveCheckpoint(checkpoint);

    console.log('\n');
    console.log('=========================================');
    console.log(`✅ Upload Complete in ${duration}s!`);
    console.log(`   New uploads: ${success}`);
    console.log(`   Unchanged: ${unchanged}`);
    console.log(`   Skipped: ${skipped}`);
    console.log(`   Failed: ${fail}`);
    if (success > 0) {
        console.log(`   Rate: ${(success / parseFloat(duration)).toFixed(1)} files/sec`);
    }
    console.log('=========================================');

    if (fail > 0) {
        console.warn(`⚠️ ${fail} files failed. Re-run to retry.`);
        process.exit(1);
    }
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
