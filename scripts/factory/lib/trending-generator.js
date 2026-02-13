/**
 * Trending Generator Module V16.7.1
 * Constitution Reference: Art 3.1 (Aggregator)
 * 
 * Generates trending.json for homepage display with V2.0 IDs
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { stripPrefix } from '../../../src/utils/mesh-routing-core.js';

const TRENDING_LIMIT = 1000; // Top 1000 by FNI

/**
 * Generate trending.json (CRITICAL for homepage)
 */
export async function generateTrending(entities, outputDir = './output') {
    console.log('[TRENDING] Generating trending.json...');

    const cacheDir = path.join(outputDir, 'cache');
    await fs.mkdir(cacheDir, { recursive: true });

    // Sort by FNI descending
    const sorted = [...entities].sort((a, b) => (b.fni_score || b.fni || 0) - (a.fni_score || a.fni || 0));

    // Take top N
    const topEntities = sorted.slice(0, TRENDING_LIMIT);

    const formatPruned = (e) => ({
        id: e.id,
        name: e.name || e.slug || 'Unknown',
        type: e.type || 'model',
        author: e.author || '',
        tags: Array.isArray(e.tags) ? (typeof e.tags[0] === 'string' ? e.tags.slice(0, 5) : []) : [],
        fni_score: Math.round(e.fni_score || 0),
        image_url: e.image_url || null,
        slug: e.slug || e.id?.split(/[:/]/).pop(),
        percentile: e.percentile || 0
    });

    const output = {
        models: topEntities.filter(e => e.type === 'model' || !e.type).map(formatPruned),
        papers: topEntities.filter(e => e.type === 'paper').map(formatPruned),
        agents: topEntities.filter(e => e.type === 'agent').map(formatPruned),
        spaces: topEntities.filter(e => e.type === 'space').map(formatPruned),
        datasets: topEntities.filter(e => e.type === 'dataset').map(formatPruned),
        tools: topEntities.filter(e => e.type === 'tool').map(formatPruned),
        count: topEntities.length,
        generated_at: new Date().toISOString(),
        version: 'V16.6'
    };

    // V16.6 Gzip fix: Use standard smart-writer for consistency and rotation
    await smartWriteWithVersioning('trending.json', output, cacheDir, { compress: true });

    console.log(`  [TRENDING] ✅ Done. Trending dashboard updated.`);
}
