/**
 * R2 Upload with S3 API - V16.8.3 Optimized
 * Modularized for CES Compliance (Art 5.1)
 */
import { S3Client } from '@aws-sdk/client-s3';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import { fetchAllR2ETags, uploadFile, createR2Client, purgeEntropy } from './lib/r2-helpers.js';

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

function toRemotePath(localPath) {
    return localPath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^output\//, '');
}

async function processQueue(s3, files, uploadedSet, checkpoint, r2ETagMap) {
    let success = 0, fail = 0, unchanged = 0;
    const queue = files.filter(f => {
        const remotePath = toRemotePath(f.path);
        if (CONFIG.PREFIX_FILTER.length > 0 && !CONFIG.PREFIX_FILTER.some(p => remotePath.startsWith(p))) return false;
        return !uploadedSet.has(remotePath);
    });

    console.log(`📊 To upload: ${queue.length} files`);
    if (queue.length === 0) return { success: 0, fail: 0, skipped: files.length, unchanged: 0 };

    for (let i = 0; i < queue.length; i += CONFIG.CONCURRENCY) {
        const batch = queue.slice(i, i + CONFIG.CONCURRENCY);
        const results = await Promise.all(batch.map(file => {
            const remotePath = toRemotePath(file.path);
            return uploadFile(s3, CONFIG.BUCKET, file.path, remotePath, r2ETagMap.get(remotePath));
        }));

        for (const result of results) {
            if (result.success) {
                checkpoint.uploaded.push(result.path);
                if (result.skipped) unchanged++; else success++;
            } else fail++;
        }
        if ((success + unchanged) % 1000 === 0) await saveCheckpoint(checkpoint);
    }
    return { success, fail, skipped: files.length - queue.length, unchanged };
}

async function main() {
    const s3 = createR2Client();
    const r2ETagMap = await fetchAllR2ETags(s3, CONFIG.BUCKET, CONFIG.PREFIX_FILTER);
    const checkpoint = await loadCheckpoint();
    const allFiles = await getAllFiles(CONFIG.OUTPUT_DIR);

    const { success, fail, skipped, unchanged } = await processQueue(s3, allFiles, new Set(checkpoint.uploaded), checkpoint, r2ETagMap);
    await saveCheckpoint(checkpoint);

    // V18.2.1: Final Purge of Entropy
    await purgeEntropy(s3, CONFIG.BUCKET, r2ETagMap);

    console.log(`\n✅ Upload Complete! New: ${success}, Unchanged: ${unchanged}, Fail: ${fail}`);
    if (fail > 0) process.exit(1);
}

main().catch(err => { console.error('❌ Fatal error:', err); process.exit(1); });
