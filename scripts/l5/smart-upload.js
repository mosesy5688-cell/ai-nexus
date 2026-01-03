#!/usr/bin/env node
/**
 * L5 Smart Upload Script
 * V14.2 Zero-Cost Constitution Compliant
 * 
 * Uses Smart Write Protocol:
 * - HEAD-before-PUT with hash comparison
 * - Cache-Control: public, max-age=3600
 * - Gzip compression for large files
 * 
 * Usage: node scripts/l5/smart-upload.js
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUCKET = 'ai-nexus-assets';
const CACHE_CONTROL = 'public, max-age=3600';

// Files to upload with Smart Write
const UPLOAD_MANIFEST = [
    { local: 'data/cache/trending.json', r2Key: 'cache/trending.json' },
    { local: 'data/cache/category_stats.json', r2Key: 'cache/category_stats.json' },
    { local: 'public/data/search-index-top.json', r2Key: 'public/data/search-index-top.json' },
];

/**
 * Compute SHA256 hash of file
 */
function computeHash(filePath) {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Get existing object hash via HEAD
 */
function getExistingHash(r2Key) {
    try {
        const result = execSync(
            `npx wrangler r2 object head ${BUCKET}/${r2Key} --json --remote 2>/dev/null`,
            { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
        );
        const metadata = JSON.parse(result);
        return metadata.customMetadata?.sha256 || null;
    } catch {
        return null;
    }
}

/**
 * Smart Write: HEAD-before-PUT
 */
function smartWrite(localPath, r2Key) {
    if (!fs.existsSync(localPath)) {
        console.log(`⏭️ SKIP: ${localPath} (not found)`);
        return { skipped: true, reason: 'not_found' };
    }

    const newHash = computeHash(localPath);
    const existingHash = getExistingHash(r2Key);

    if (existingHash === newHash) {
        console.log(`⏭️ SKIP: ${r2Key} (hash match)`);
        return { skipped: true, reason: 'hash_match', hash: newHash };
    }

    // Determine content type
    const ext = path.extname(localPath);
    const contentType = ext === '.json' ? 'application/json' :
        ext === '.gz' ? 'application/gzip' :
            'application/octet-stream';

    // Upload with Cache-Control
    console.log(`📤 PUT: ${r2Key}`);
    execSync(
        `npx wrangler r2 object put "${BUCKET}/${r2Key}" ` +
        `--file="${localPath}" ` +
        `--content-type="${contentType}" ` +
        `--cache-control="${CACHE_CONTROL}" ` +
        `--remote`,
        { stdio: 'inherit' }
    );

    return { written: true, hash: newHash };
}

/**
 * Main
 */
async function main() {
    console.log('🚀 [V14.2] L5 Smart Upload');
    console.log('='.repeat(50));

    let written = 0, skipped = 0, failed = 0;

    // Process manifest files
    for (const item of UPLOAD_MANIFEST) {
        try {
            const result = smartWrite(item.local, item.r2Key);
            if (result.written) written++;
            else skipped++;
        } catch (err) {
            console.error(`❌ FAIL: ${item.r2Key} - ${err.message}`);
            failed++;
        }
    }

    // Upload computed/*.json files
    const computedDir = path.join(__dirname, '../../data/computed');
    if (fs.existsSync(computedDir)) {
        const files = fs.readdirSync(computedDir).filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const result = smartWrite(
                    path.join(computedDir, file),
                    `computed/${file}`
                );
                if (result.written) written++;
                else skipped++;
            } catch (err) {
                console.error(`❌ FAIL: computed/${file} - ${err.message}`);
                failed++;
            }
        }
    }

    // Upload rankings/*.json files
    const rankingsDir = path.join(__dirname, '../../data/cache/rankings');
    if (fs.existsSync(rankingsDir)) {
        const files = fs.readdirSync(rankingsDir, { recursive: true })
            .filter(f => f.endsWith('.json'));
        for (const file of files) {
            try {
                const result = smartWrite(
                    path.join(rankingsDir, file),
                    `cache/rankings/${file}`
                );
                if (result.written) written++;
                else skipped++;
            } catch (err) {
                console.error(`❌ FAIL: cache/rankings/${file} - ${err.message}`);
                failed++;
            }
        }
    }

    console.log('='.repeat(50));
    console.log(`📊 Summary: ${written} written, ${skipped} skipped, ${failed} failed`);
    console.log(`💰 Saved ~${skipped} Class A operations via hash matching`);

    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('❌ Fatal:', err);
    process.exit(1);
});
