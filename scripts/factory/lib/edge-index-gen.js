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
import { initRustBridge } from './rust-bridge.js';
import Database from 'better-sqlite3';
import { zstdCompress, createZstdCompressStream } from './zstd-helper.js';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output/data';

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
 * Generate the global edge index from already built meta-XX.db shards.
 * V25.8.4: Zero-Heap Strategy — Query DB directly to avoid JSON/Sorting OOM.
 */
export async function generateEdgeIndex() {
    console.log('[EDGE-INDEX] Generating meta.global.index (Zero-Heap DB Path)...');
    
    initRustBridge();
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await zstdCompress(Buffer.from('init')); // Warm up Zstd codec

    const bloomFilter = Buffer.alloc(BLOOM_SIZE_BYTES, 0);
    const indexPath = path.join(OUTPUT_DIR, 'meta.global.index');
    const writeStream = fsSync.createWriteStream(indexPath);
    const zst = createZstdCompressStream();
    zst.pipe(writeStream);

    let totalEntities = 0;
    const metaShards = fsSync.readdirSync(OUTPUT_DIR).filter(f => f.startsWith('meta-') && f.endsWith('.db'));
    metaShards.sort(); // Ensure slot-order for binary search stability

    // Initial Header
    const header = {
        version: '4.1',
        generated: new Date().toISOString(),
        entityCount: 0, // Will be patched if header-first, but we stream entries
        slotCount: 4096,
    };
    
    zst.write(JSON.stringify(header).slice(0, -1) + ',"entries":[');

    for (const shardFile of metaShards) {
        const slotId = parseInt(shardFile.match(/meta-(\d+)/)[1]);
        const dbPath = path.join(OUTPUT_DIR, shardFile);
        const db = new Database(dbPath, { readonly: true });

        // V25.1 Query: Extract routing essentials
        const rows = db.prepare('SELECT umid, id, type, bundle_key, bundle_offset, bundle_size FROM entities').all();
        
        for (const r of rows) {
            const entryArray = [r.umid, slotId, r.id, r.type, r.bundle_key, r.bundle_offset, r.bundle_size];
            const chunk = (totalEntities === 0 ? '' : ',') + JSON.stringify(entryArray);
            
            const ok = zst.write(chunk);
            if (!ok) await new Promise(resolve => zst.once('drain', resolve));

            // Populate Bloom Filter (UMID based)
            for (let h = 0; h < BLOOM_HASH_COUNT; h++) {
                const bit = bloomHash(r.umid, h * 0x9e3779b9);
                bloomFilter[bit >>> 3] |= (1 << (bit & 7));
            }
            totalEntities++;
        }
        db.close();
        console.log(`  [EDGE-INDEX] Processed ${shardFile} (${rows.length} entities)`);
    }

    zst.write(']}');
    zst.end();

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
    console.log(`  Index: ${indexPath} (${indexSizeMB} MB, ${totalEntities} entities)`);
    console.log(`  Bloom: ${bloomPath} (${bloomSizeMB} MB)`);

    return { entityCount: totalEntities, indexSizeMB, bloomSizeMB };
}

// CLI entry point
if (process.argv[1]?.endsWith('edge-index-gen.js')) {
    generateEdgeIndex().catch(err => {
        console.error('[EDGE-INDEX] Fatal:', err);
        process.exit(1);
    });
}
