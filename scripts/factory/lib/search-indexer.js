/**
 * Search Indexer Module V14.4
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

    const searchDir = path.join(outputDir, 'search');
    await fs.mkdir(searchDir, { recursive: true });

    // Core index: Top N by FNI (Art 6.3: <500KB)
    const coreEntities = entities.slice(0, SEARCH_CORE_SIZE).map(e => ({
        id: e.id,
        name: e.name || e.slug,
        type: e.type,
        description: (e.description || '').substring(0, 100),
        fni: e.fni,
        source: e.source,
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

    // Full index: All entities
    const fullEntities = entities.map(e => ({
        id: e.id,
        name: e.name || e.slug,
        type: e.type,
        description: e.description || '',
        tags: e.tags || [],
        fni: e.fni,
        source: e.source,
    }));

    const fullIndex = {
        entities: fullEntities,
        _count: fullEntities.length,
        _generated: new Date().toISOString(),
    };

    const fullContent = JSON.stringify(fullIndex);
    const fullSizeKB = (fullContent.length / 1024).toFixed(0);
    console.log(`  [SEARCH] Full index: ${fullEntities.length} entities, ${fullSizeKB}KB`);

    await fs.writeFile(path.join(searchDir, 'search-full.json'), fullContent);
}
