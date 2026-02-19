/**
 * V19.2 VFS Packing Utilities
 * Extracted to satisfy CES Monolith Ban (Art 5.1).
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

/**
 * Load Trending Context for entity prioritization
 */
export async function loadTrendingMap(cacheDir) {
    const trendingPath = path.join(cacheDir, 'trending.json.gz');
    const trendingMap = new Map();
    try {
        const trendingRaw = await fs.readFile(trendingPath);
        const trendingData = JSON.parse(zlib.gunzipSync(trendingRaw));
        const items = trendingData.items || trendingData.trending || [];
        items.forEach((item, index) => {
            trendingMap.set(item.id || item.slug, {
                rank: index + 1,
                is_trending: true
            });
        });
        console.log(`[VFS] Loaded ${trendingMap.size} trending context items.`);
    } catch (e) {
        console.warn(`[VFS] ⚠️ No trending.json.gz found. Proceeding without trending flags.`);
    }
    return trendingMap;
}

/**
 * Load 7d Trend Sparklines for DB embedding
 */
export async function loadTrendMap(cacheDir) {
    const trendPath = path.join(cacheDir, 'trend-data.json.gz');
    const trendMap = new Map();
    try {
        const trendRaw = await fs.readFile(trendPath);
        const trendData = JSON.parse(zlib.gunzipSync(trendRaw));
        for (const [id, values] of Object.entries(trendData)) {
            trendMap.set(id, values.join(','));
        }
        console.log(`[VFS] Loaded ${trendMap.size} trend sparklines.`);
    } catch (e) {
        console.warn(`[VFS] ⚠️ No trend-data.json.gz found. Proceeding without sparklines.`);
    }
    return trendMap;
}

/**
 * Collect all fused metadata and apply stable sorting
 */
export async function collectAndSortMetadata(cacheDir, trendingMap, trendMap) {
    const fusedDir = path.join(cacheDir, 'fused');
    const fusedFiles = (await fs.readdir(fusedDir).catch(() => []))
        .filter(f => f.endsWith('.json') || f.endsWith('.json.gz'));

    if (fusedFiles.length === 0) throw new Error(`No fused entities found at ${fusedDir}`);

    const metadataMap = new Map();
    for (const file of fusedFiles) {
        const fullPath = path.join(fusedDir, file);
        try {
            const raw = await fs.readFile(fullPath);
            const entity = file.endsWith('.gz') ? JSON.parse(zlib.gunzipSync(raw)) : JSON.parse(raw);
            const id = entity.id || entity.slug;

            // Deduplication: Prefer more recent or compressed if collision
            if (metadataMap.has(id) && file.endsWith('.json')) continue;

            const trendingInfo = trendingMap.get(id) || { rank: 999999, is_trending: false };

            metadataMap.set(id, {
                ...entity,
                _trending_rank: trendingInfo.rank,
                is_trending: trendingInfo.is_trending,
                _trend_7d: trendMap.get(id) || ''
            });

            if (metadataMap.size % 50000 === 0) console.log(`[VFS] Collected ${metadataMap.size} unique items...`);
        } catch (e) {
            console.error(`[VFS] Failed to read ${file}:`, e.message);
        }
    }

    const metadataBatch = Array.from(metadataMap.values());
    metadataMap.clear();

    // Stable Popularity Sorting
    console.log(`[VFS] Performing Stable Popularity Sorting for ${metadataBatch.length} entities...`);
    return metadataBatch.sort((a, b) => {
        const scoreA = a.fni_score ?? a.fni ?? 0;
        const scoreB = b.fni_score ?? b.fni ?? 0;
        if (scoreB !== scoreA) return scoreB - scoreA;
        if (a._trending_rank !== b._trending_rank) return a._trending_rank - b._trending_rank;
        return (a.id || '').localeCompare(b.id || '');
    });
}
