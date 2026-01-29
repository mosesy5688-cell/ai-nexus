#!/usr/bin/env node
/**
 * L5 Smart Upload Script
 * V14.2 Zero-Cost Constitution Compliant
 * 
 * Uses Smart Write Protocol:
 * - HEAD-before-PUT with hash comparison
 * - Cache-Control: public, max-age=3600
 * - Concurrent uploads with rate limiting
 * 
 * Usage: node scripts/l5/smart-upload.js [--concurrency=10]
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { exec } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const BUCKET = 'ai-nexus-assets';
const CACHE_CONTROL = 'public, max-age=3600';
const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 20;

// Parse CLI args
const args = process.argv.slice(2);
const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
const CONCURRENCY = Math.min(
    concurrencyArg ? parseInt(concurrencyArg.split('=')[1]) : DEFAULT_CONCURRENCY,
    MAX_CONCURRENCY
);

// Core files (always upload)
const CORE_MANIFEST = [
    { local: 'data/cache/trending.json', r2Key: 'cache/trending.json' },
    { local: 'data/cache/category_stats.json', r2Key: 'cache/category_stats.json' },
    { local: 'public/data/search-index-top.json', r2Key: 'public/data/search-index-top.json' },
];

/** Compute SHA256 hash */
function computeHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/** Get existing hash via HEAD (async) */
async function getExistingHash(r2Key) {
    try {
        const { stdout } = await execAsync(
            `npx wrangler r2 object head ${BUCKET} ${r2Key} --json --remote 2>/dev/null`
        );
        const metadata = JSON.parse(stdout);
        return metadata.customMetadata?.sha256 || null;
    } catch {
        return null;
    }
}

/** Smart Write with async execution */
async function smartWrite(localPath, r2Key) {
    if (!fs.existsSync(localPath)) {
        return { r2Key, skipped: true, reason: 'not_found' };
    }

    const newHash = computeHash(localPath);
    const existingHash = await getExistingHash(r2Key);

    if (existingHash === newHash) {
        return { r2Key, skipped: true, reason: 'hash_match', hash: newHash };
    }

    const ext = path.extname(localPath);
    const contentType = ext === '.json' ? 'application/json' :
        ext === '.gz' ? 'application/gzip' : 'application/octet-stream';

    await execAsync(
        `npx wrangler r2 object put "${BUCKET}" "${r2Key}" ` +
        `--file="${localPath}" ` +
        `--content-type="${contentType}" ` +
        `--cache-control="${CACHE_CONTROL}" ` +
        `--remote`
    );

    return { r2Key, written: true, hash: newHash };
}

/** Process items with concurrency control */
async function processWithConcurrency(items, fn, concurrency) {
    const results = [];
    const queue = [...items];
    const inFlight = new Set();

    while (queue.length > 0 || inFlight.size > 0) {
        while (inFlight.size < concurrency && queue.length > 0) {
            const item = queue.shift();
            const promise = fn(item)
                .then(result => {
                    results.push(result);
                    inFlight.delete(promise);
                })
                .catch(err => {
                    results.push({ ...item, error: err.message });
                    inFlight.delete(promise);
                });
            inFlight.add(promise);
        }
        if (inFlight.size > 0) {
            await Promise.race(inFlight);
        }
    }
    return results;
}

/** Collect files from directory */
function collectFiles(dir, prefix) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { recursive: true })
        .filter(f => f.endsWith('.json'))
        .map(f => ({ local: path.join(dir, f), r2Key: `${prefix}/${f}` }));
}

/** Main */
async function main() {
    console.log(`🚀 [V14.2] L5 Smart Upload (Concurrency: ${CONCURRENCY})`);
    console.log('='.repeat(50));
    const startTime = Date.now();

    // Collect all files
    const allItems = [
        ...CORE_MANIFEST,
        ...collectFiles(path.join(__dirname, '../../data/computed'), 'computed'),
        ...collectFiles(path.join(__dirname, '../../data/cache/rankings'), 'cache/rankings'),
    ];

    console.log(`📁 Total files: ${allItems.length}`);

    // Process with concurrency
    const results = await processWithConcurrency(
        allItems,
        item => smartWrite(item.local, item.r2Key),
        CONCURRENCY
    );

    // Summary
    const written = results.filter(r => r.written).length;
    const skipped = results.filter(r => r.skipped).length;
    const failed = results.filter(r => r.error).length;
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('='.repeat(50));
    console.log(`📊 Summary: ${written} written, ${skipped} skipped, ${failed} failed`);
    console.log(`⏱️ Duration: ${duration}s`);
    console.log(`💰 Saved ~${skipped} Class A operations via hash matching`);

    if (failed > 0) {
        console.log('\n❌ Failed files:');
        results.filter(r => r.error).forEach(r => console.log(`  - ${r.r2Key}: ${r.error}`));
        process.exit(1);
    }
}

main().catch(err => {
    console.error('❌ Fatal:', err);
    process.exit(1);
});
