/**
 * Search Indexer Module V16.4.3
 * Constitution Reference: Art 6.3 (Dual Search Index)
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import zlib from 'zlib';

const SEARCH_CORE_SIZE = 5000; // Art 6.3: Top 5000 for core index

/**
 * Generate dual search indices (Art 6.3)
 */
export async function generateSearchIndices(entities, outputDir = './output') {
    console.log('[SEARCH] Generating search indices...');

    // V14.4 Fix: Output to cache/ to match frontend paths
    const searchDir = path.join(outputDir, 'cache');
    await fs.mkdir(searchDir, { recursive: true });

    // Core index: Top N by FNI (Art 6.3: < 500KB)
    const coreEntities = entities.slice(0, SEARCH_CORE_SIZE).map(e => ({
        id: e.id,
        name: e.name || e.slug || 'Unknown',
        type: e.type || 'model',
        author: e.author || '',
        description: (e.description || e.summary || '').substring(0, 150), // Truncated for size
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 5) : (typeof e.tags === 'string' ? JSON.parse(e.tags || '[]').slice(0, 5) : []),
        fni_score: Math.round(e.fni_score || 0),
        image_url: e.image_url || null,
        slug: e.slug || e.id?.split(/[:/]/).pop()
    }));


    const coreIndex = {
        entities: coreEntities,
        _count: coreEntities.length,
        _generated: new Date().toISOString(),
    };

    // Write indices (V16.6: Use fixed SmartWriter for Core)
    const targetCoreKey = 'search-core.json';
    await smartWriteWithVersioning(targetCoreKey, coreEntities, searchDir, { compress: true });

    console.log(`  [SEARCH] Core index generated: ${coreEntities.length} entities`);

    // Full index: All entities (V14.5.3 Sharding)
    const fullEntities = entities.map(e => ({
        id: e.id,
        name: e.name || e.slug || 'Unknown',
        type: e.type || 'model',
        author: e.author || '',
        tags: Array.isArray(e.tags) ? e.tags.slice(0, 5) : (typeof e.tags === 'string' ? JSON.parse(e.tags || '[]').slice(0, 5) : []),
        fni_score: Math.round(e.fni_score || 0),
        image_url: e.image_url || null,
        slug: e.slug || e.id?.split(/[:/]/).pop()
    }));
    const SHARD_SIZE = 5000;
    const totalShards = Math.ceil(fullEntities.length / SHARD_SIZE);

    console.log(`  [SEARCH] Full index sharding: ${fullEntities.length} entities into ${totalShards} shards`);

    const shardingDir = path.join(searchDir, 'search');
    await fs.mkdir(shardingDir, { recursive: true });

    for (let s = 0; s < totalShards; s++) {
        const shardEntities = fullEntities.slice(s * SHARD_SIZE, (s + 1) * SHARD_SIZE);
        const shard = {
            shard: s,
            totalShards,
            entities: shardEntities,
            _count: shardEntities.length,
            _generated: new Date().toISOString(),
        };
        const compressedShard = zlib.gzipSync(JSON.stringify(shard));
        // SPEC-ID-V2.0: Always use .gz for shards
        await fs.writeFile(path.join(shardingDir, `shard-${s}.json.gz`), compressedShard);
    }

    // Manifest for client-side lazy loading (Keep uncompressed for small size and easy fetch)
    const manifest = {
        totalEntities: fullEntities.length,
        totalShards,
        shardSize: SHARD_SIZE,
        extension: '.gz', // Explicitly tell client to use .gz
        _generated: new Date().toISOString(),
    };
    await fs.writeFile(path.join(searchDir, 'search-manifest.json'), JSON.stringify(manifest));

    // V18.2: Legacy search-full removed per Art 6.2 (Strict Compression)
    // and explicitly requested by user to optimize browser memory.
    console.log(`  [SEARCH] ✅ Done. Manifest and ${totalShards} shards generated.`);
}
