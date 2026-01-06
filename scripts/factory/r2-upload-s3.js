/**
 * R2 Upload with S3 API - V14.5 Phase 6
 * 
 * Uses @aws-sdk/client-s3 for batch uploads instead of wrangler CLI
 * - 10x faster than wrangler CLI (parallel uploads)
 * - More stable (connection pooling)
 * - Same cost (R2 Class A operations)
 * 
 * Constitutional: Art 13.4 (Non-Destructive)
 */
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';

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

// Upload single file using S3 API
async function uploadFile(s3, localPath, remotePath) {
    try {
        const content = await fs.readFile(localPath);
        const contentType = remotePath.endsWith('.json') ? 'application/json' :
            remotePath.endsWith('.xml') ? 'application/xml' :
                remotePath.endsWith('.gz') ? 'application/gzip' : 'application/octet-stream';

        await s3.send(new PutObjectCommand({
            Bucket: CONFIG.BUCKET,
            Key: remotePath,
            Body: content,
            ContentType: contentType
        }));
        return { success: true, path: remotePath };
    } catch (e) {
        console.error(`\n❌ Failed: ${remotePath} - ${e.message}`);
        return { success: false, path: remotePath, error: e.message };
    }
}

// Process queue with concurrency limit
async function processQueue(s3, files, uploadedSet, checkpoint) {
    let success = 0;
    let fail = 0;

    // Filter out already uploaded files
    const queue = files.filter(f => {
        const remotePath = toRemotePath(f.path);
        return !uploadedSet.has(remotePath);
    });

    console.log(`📊 To upload: ${queue.length} files`);

    if (queue.length === 0) {
        console.log('✅ All files already uploaded!');
        return { success: 0, fail: 0, skipped: files.length };
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
                success++;
            } else {
                fail++;
            }
        }

        // Save checkpoint every 500 files
        if (success % 500 === 0 && success > 0) {
            await saveCheckpoint(checkpoint);
            console.log(`\n💾 Checkpoint: ${success} files uploaded`);
        }
    }

    return { success, fail, skipped: files.length - queue.length };
}

async function main() {
    console.log('📤 V14.5 Phase 6 - S3 API R2 Upload');
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

    const startTime = Date.now();
    const { success, fail, skipped } = await processQueue(s3, allFiles, uploadedSet, checkpoint);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    // Final checkpoint
    await saveCheckpoint(checkpoint);

    console.log('\n');
    console.log('=====================================');
    console.log(`✅ Upload Complete in ${duration}s!`);
    console.log(`   Success: ${success}`);
    console.log(`   Failed: ${fail}`);
    console.log(`   Skipped: ${skipped}`);
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
