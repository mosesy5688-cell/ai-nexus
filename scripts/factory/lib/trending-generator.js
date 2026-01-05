/**
 * Trending Generator Module V14.4
 * Constitution Reference: Art 3.1 (Aggregator)
 * 
 * Generates trending.json for homepage display
 */

import fs from 'fs/promises';
import path from 'path';

const TRENDING_LIMIT = 1000; // Top 1000 by FNI

/**
 * Generate trending.json (CRITICAL for homepage)
 */
export async function generateTrending(entities, outputDir = './output') {
    console.log('[TRENDING] Generating trending.json...');

    const cacheDir = path.join(outputDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    // Sort by FNI descending
    const sorted = [...entities].sort((a, b) => (b.fni || 0) - (a.fni || 0));

    // Take top N
    const topEntities = sorted.slice(0, TRENDING_LIMIT);

    // Format for frontend compatibility
    const trending = {
        models: topEntities.filter(e => e.type === 'model' || !e.type).map(formatEntity),
        papers: topEntities.filter(e => e.type === 'paper').map(formatEntity),
        agents: topEntities.filter(e => e.type === 'agent').map(formatEntity),
        spaces: topEntities.filter(e => e.type === 'space').map(formatEntity),
        datasets: topEntities.filter(e => e.type === 'dataset').map(formatEntity),
        _count: topEntities.length,
        _generated: new Date().toISOString(),
    };

    const content = JSON.stringify(trending, null, 2);
    const filePath = path.join(cacheDir, 'trending.json');
    await fs.writeFile(filePath, content);

    console.log(`  [TRENDING] ${topEntities.length} entities, ${(content.length / 1024).toFixed(0)}KB`);
}

function formatEntity(e) {
    return {
        id: e.id,
        slug: e.slug || e.id?.replace(/:/g, '/'),
        name: e.name || e.slug,
        type: e.type || 'model',
        source: e.source || 'unknown',
        description: (e.description || '').substring(0, 200),
        fni_score: e.fni || e.fni_score || 0,
        downloads: e.downloads || 0,
        likes: e.likes || 0,
        author: e.author || 'unknown',
        lastModified: e.lastModified || e._updated,
    };
}
