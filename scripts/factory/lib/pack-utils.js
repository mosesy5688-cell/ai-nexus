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
    // V19.2 Path Fallback: Check both output/cache and output/ (Artifact download target)
    const paths = [
        path.join(cacheDir, 'trending.json.gz'),
        path.join(path.dirname(cacheDir), 'trending.json.gz'),
    ];

    const trendingMap = new Map();
    let loaded = false;

    for (const trendingPath of paths) {
        try {
            const trendingRaw = await fs.readFile(trendingPath);
            const trendingData = JSON.parse(zlib.gunzipSync(trendingRaw));

            // V18.2.1: Unified Tiered Structure (models, papers, etc.)
            const items = [
                ...(trendingData.items || []),
                ...(trendingData.trending || []),
                ...(trendingData.models || []),
                ...(trendingData.papers || []),
                ...(trendingData.agents || []),
                ...(trendingData.spaces || []),
                ...(trendingData.datasets || []),
                ...(trendingData.tools || [])
            ];

            items.forEach((item, index) => {
                if (!item.id && !item.slug) return;
                trendingMap.set(item.id || item.slug, {
                    rank: index + 1,
                    is_trending: true
                });
            });
            console.log(`[VFS] Loaded ${trendingMap.size} trending context items from ${path.basename(trendingPath)}.`);
            loaded = true;
            break;
        } catch (e) {
            continue;
        }
    }

    if (!loaded) {
        console.warn(`[VFS] ⚠️ No trending.json.gz found in ${cacheDir} or parent. Proceeding without trending flags.`);
    }
    return trendingMap;
}

/**
 * Load 7d Trend Sparklines for DB embedding
 */
export async function loadTrendMap(cacheDir) {
    // V19.2 Path Fallback
    const paths = [
        path.join(cacheDir, 'trend-data.json.gz'),
        path.join(path.dirname(cacheDir), 'trend-data.json.gz'),
    ];

    const trendMap = new Map();
    let loaded = false;

    for (const trendPath of paths) {
        try {
            const trendRaw = await fs.readFile(trendPath);
            const trendData = JSON.parse(zlib.gunzipSync(trendRaw));

            // V18.2.3: Handle object-based structure (id -> { scores: [], ... })
            for (const [id, value] of Object.entries(trendData)) {
                if (Array.isArray(value)) {
                    trendMap.set(id, value.join(','));
                } else if (value && value.scores) {
                    trendMap.set(id, value.scores.join(','));
                }
            }
            console.log(`[VFS] Loaded ${trendMap.size} trend sparklines from ${path.basename(trendPath)}.`);
            loaded = true;
            break;
        } catch (e) {
            continue;
        }
    }

    if (!loaded) {
        console.warn(`[VFS] ⚠️ No trend-data.json.gz found in ${cacheDir} or parent. Proceeding without sparklines.`);
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
            const parsed = file.endsWith('.gz') ? JSON.parse(zlib.gunzipSync(raw)) : JSON.parse(raw);

            // V22.8: Fused shards contain { shardId, entities: [...], _ts }
            const entities = parsed.entities || (parsed.id ? [parsed] : [parsed]);

            for (const entity of entities) {
                const id = entity.id || entity.slug;
                if (!id) continue;

                // Deduplication: Prefer more recent or compressed if collision
                if (metadataMap.has(id) && file.endsWith('.json')) continue;

                const trendingInfo = trendingMap.get(id) || { rank: 999999, is_trending: false };

                metadataMap.set(id, {
                    ...entity,
                    _trending_rank: trendingInfo.rank,
                    is_trending: trendingInfo.is_trending,
                    _trend_7d: trendMap.get(id) || ''
                });
            }

            if (metadataMap.size % 50000 === 0 && metadataMap.size > 0) console.log(`[VFS] Collected ${metadataMap.size} unique items...`);
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

/**
 * V22.8: Build complete bundle JSON for VFS shard packing
 */
export function buildBundleJson(e, fniMetrics, pBillions, ctxLen, arch) {
    return Buffer.from(JSON.stringify({
        readme: e.readme || e.html_readme || e.body_content || '',
        changelog: e.changelog || '',
        benchmarks: e.benchmarks || [],
        paper_abstract: e.paper_abstract || '',
        mesh_profile: e.mesh_profile || { relations: [] },
        fni_metrics: fniMetrics,
        params_billions: pBillions, context_length: ctxLen, architecture: arch,
        license: e.license || e.license_spdx || '',
        source_url: e.source_url || '',
        source: e.source || e.source_platform || '',
        pipeline_tag: e.pipeline_tag || '',
        image_url: e.raw_image_url || e.image_url || '',
        vram_estimate_gb: e.vram_estimate_gb || null,
        quick_insights: e.quick_insights || [],
        use_cases: e.use_cases || [],
        quantization: e.quantization || '',
        html_readme: e.html_readme || '',
        relations: e.relations || [],
        created_at: e.created_at || '',
        display_description: e.display_description || ''
    }), 'utf8');
}

/**
 * V22.8: Build 33-column entity row for meta.db/search.db
 * All values must be SQLite-safe: number, string, bigint, buffer, or null.
 */
export function buildEntityRow(e, fniMetrics, pBillions, arch, ctxLen, category, tags, summary, bundleKey, offset, size) {
    // V22.8: Coerce non-primitive values to strings (papers may have array authors, etc.)
    const s = (v, fallback = '') => {
        if (v == null) return fallback;
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'bigint') return v;
        if (Array.isArray(v)) return v.join(', ');
        if (typeof v === 'object') return JSON.stringify(v);
        return String(v);
    };
    const n = (v, fallback = 0) => {
        if (typeof v === 'number' && !isNaN(v)) return v;
        const parsed = Number(v);
        return isNaN(parsed) ? fallback : parsed;
    };

    return [
        s(e.id), s(e.umid || e.id), s(e.slug), s(e.name || e.displayName), s(e.type, 'model'),
        s(e.author), s(summary), s(category), s(tags), n(e.fni_score), s(e.fni_percentile),
        n(e.fni_p ?? fniMetrics.p), n(e.fni_v ?? fniMetrics.v),
        n(e.fni_c ?? fniMetrics.c), n(e.fni_u ?? fniMetrics.u),
        n(pBillions), s(arch), n(ctxLen), e.is_trending ? 1 : 0,
        n(e.stars || e.likes), n(e.downloads), s(e.last_modified), bundleKey, n(offset), n(size),
        '', s(e._trend_7d),
        s(e.license || e.license_spdx), s(e.source_url), s(e.pipeline_tag),
        s(e.raw_image_url || e.image_url), n(e.vram_estimate_gb), s(e.source || e.source_platform)
    ];
}
