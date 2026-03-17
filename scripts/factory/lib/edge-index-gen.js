/**
 * V25.8 Edge Index Generator
 *
 * Generates `meta.global.index` — a lightweight edge manifest
 * that resolves UMID -> ShardID -> ByteOffset for near-zero cold starts.
 *
 * Also generates a 16MB Bloom Filter for 10M-entity collision safety.
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import zlib from 'zlib';
import crypto from 'crypto';
import { generateUMID } from './umid-generator.js';
import { initRustBridge, computeShardSlotFFI } from './rust-bridge.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output/data';
const CACHE_DIR = process.env.CACHE_DIR || './output/cache';

// Bloom Filter constants for 10M entities, ~0.1% false positive rate
const BLOOM_SIZE_BYTES = 16 * 1024 * 1024; // 16MB
const BLOOM_HASH_COUNT = 7;

/**
 * MurmurHash3-like hash for Bloom Filter
 */
function bloomHash(key, seed) {
    let h = seed ^ key.length;
    for (let i = 0; i < key.length; i++) {
        h = Math.imul(h ^ key.charCodeAt(i), 0x5bd1e995);
        h ^= h >>> 13;
    }
    return (h >>> 0) % (BLOOM_SIZE_BYTES * 8);
}

/**
 * Generate the global edge index from fused entities.
 */
export async function generateEdgeIndex() {
    console.log('[EDGE-INDEX] Generating meta.global.index...');
    
    // Ensure Rust bridge is initialized for FFI acceleration
    initRustBridge();
    
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const fusedDir = path.join(CACHE_DIR, 'fused');
    const indexEntries = [];
    const bloomFilter = Buffer.alloc(BLOOM_SIZE_BYTES, 0);

    let entityCount = 0;
    const fusedFiles = await fs.readdir(fusedDir).catch(() => []);

    for (const file of fusedFiles.filter(f => f.endsWith('.json.gz') || f.endsWith('.json'))) {
        try {
            const raw = await fs.readFile(path.join(fusedDir, file));
            const parsed = file.endsWith('.gz')
                ? JSON.parse(zlib.gunzipSync(raw))
                : JSON.parse(raw);
            const entities = parsed.entities || (parsed.id ? [parsed] : []);

            for (const entity of entities) {
                const id = entity.id || entity.slug;
                if (!id) continue;

                const umid = entity.umid || generateUMID(id);
                // V25.8: Use Rust FFI for shard slot routing
                const slotId = computeShardSlotFFI(umid);

                indexEntries.push({
                    umid,
                    id,
                    slot: slotId,
                    type: entity.type || 'model',
                    bundleKey: entity.bundle_key || '',
                    bundleOffset: entity.bundle_offset || 0,
                    bundleSize: entity.bundle_size || 0
                });

                // Add to Bloom Filter
                for (let h = 0; h < BLOOM_HASH_COUNT; h++) {
                    const bit = bloomHash(umid, h * 0x9e3779b9);
                    bloomFilter[bit >>> 3] |= (1 << (bit & 7));
                }

                entityCount++;
            }
        } catch (e) {
            console.warn(`  [WARN] Failed to read ${file}: ${e.message}`);
        }
    }

    // Sort by slot for binary search efficiency
    indexEntries.sort((a, b) => a.slot - b.slot || a.umid.localeCompare(b.umid));

    // V25.8: STREAMING WRITE to avoid OOM by stringifying 410k entities at once
    const indexPath = path.join(OUTPUT_DIR, 'meta.global.index');
    const writeStream = fsSync.createWriteStream(indexPath);
    
    // Create Gzip stream for the index
    const gzip = zlib.createGzip();
    gzip.pipe(writeStream);

    // Initial Header
    const header = {
        version: '4.0',
        generated: new Date().toISOString(),
        entityCount,
        slotCount: 4096,
    };
    
    gzip.write(JSON.stringify(header).slice(0, -1) + ',"entries":[');

    for (let i = 0; i < indexEntries.length; i++) {
        const e = indexEntries[i];
        const entryArray = [e.umid, e.slot, e.id, e.type, e.bundleKey, e.bundleOffset, e.bundleSize];
        const chunk = (i === 0 ? '' : ',') + JSON.stringify(entryArray);
        
        const ok = gzip.write(chunk);
        if (!ok) {
            await new Promise(resolve => gzip.once('drain', resolve));
        }
    }

    gzip.write(']}');
    gzip.end();

    await new Promise((resolve, reject) => {
        writeStream.on('finish', resolve);
        writeStream.on('error', reject);
    });

    // Write Bloom Filter
    const bloomPath = path.join(OUTPUT_DIR, 'bloom-filter.bin');
    await fs.writeFile(bloomPath, bloomFilter);

    const indexSizeMB = (fsSync.statSync(indexPath).size / 1024 / 1024).toFixed(2);
    const bloomSizeMB = (BLOOM_SIZE_BYTES / 1024 / 1024).toFixed(0);

    console.log(`[EDGE-INDEX] Complete.`);
    console.log(`  Index: ${indexPath} (${indexSizeMB} MB, ${entityCount} entities)`);
    console.log(`  Bloom: ${bloomPath} (${bloomSizeMB} MB, ${BLOOM_HASH_COUNT} hashes)`);

    return { entityCount, indexSizeMB, bloomSizeMB };
}

// CLI entry point
if (process.argv[1]?.endsWith('edge-index-gen.js')) {
    generateEdgeIndex().catch(err => {
        console.error('[EDGE-INDEX] Fatal:', err);
        process.exit(1);
    });
}
