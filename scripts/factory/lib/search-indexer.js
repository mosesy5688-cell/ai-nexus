/**
 * Search Indexer Module V16.4.3
 * Constitution Reference: Art 6.3 (Dual Search Index)
 */

import fs from 'fs/promises';
import path from 'path';

const SEARCH_CORE_SIZE = 5000; // Art 6.3: Top 5000 for core index

/**
 * Generate dual search indices (Art 6.3)
 */
export async function generateSearchIndices(entities, outputDir = './output') {
    console.log('[SEARCH] Generating search indices...');

    // V14.4 Fix: Output to cache/ to match frontend paths
    const searchDir = path.join(outputDir, 'cache');
    await fs.mkdir(searchDir, { recursive: true });

    // Core index: Top N by FNI (Art 6.3: <500KB)
    const coreEntities = entities.slice(0, SEARCH_CORE_SIZE).map(e => ({
        id: e.id,
        name: e.name || e.slug,
        type: e.type,
        description: (e.description || '').substring(0, 100),
        fni: e.fni_score || 0,
        source: e.source,
        has_image: Boolean(e.image_url),
    }));

    const coreIndex = {
        entities: coreEntities,
        _count: coreEntities.length,
        _generated: new Date().toISOString(),
    };

    const coreContent = JSON.stringify(coreIndex);
    const coreSizeKB = (coreContent.length / 1024).toFixed(0);
    console.log(`  [SEARCH] Core index: ${coreEntities.length} entities, ${coreSizeKB}KB`);

    await fs.writeFile(path.join(searchDir, 'search-core.json'), coreContent);

    // Full index: All entities (V14.5.3 Sharding)
    const fullEntities = entities.map(e => ({
        id: e.id,
        name: e.name || e.slug,
        type: e.type,
        fni: e.fni_score || 0,
        source: e.source,
        has_image: Boolean(e.image_url),
        // Shortened description to save shard space
        description: (e.description || '').substring(0, 150),
    }));

    const SHARD_SIZE = 5000; // ~1-2MB per shard
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
        await fs.writeFile(path.join(shardingDir, `shard-${s}.json`), JSON.stringify(shard));
    }

    // Manifest for client-side lazy loading
    const manifest = {
        totalEntities: fullEntities.length,
        totalShards,
        shardSize: SHARD_SIZE,
        _generated: new Date().toISOString(),
    };
    await fs.writeFile(path.join(searchDir, 'search-manifest.json'), JSON.stringify(manifest));

    // BACKWARD COMPATIBILITY: Keep a top-50k version for older clients
    const legacyFull = {
        entities: fullEntities.slice(0, 50000),
        _count: Math.min(fullEntities.length, 50000),
        _generated: new Date().toISOString(),
    };
    await fs.writeFile(path.join(searchDir, 'search-full.json'), JSON.stringify(legacyFull));
}
