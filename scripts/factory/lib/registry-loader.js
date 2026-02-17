/**
 * Registry Loader Module V18.2.11
 * Handles sharded loading, field projection, and OOM-safe summary recovery.
 */
import fs from 'fs/promises';
import path from 'path';
import { loadWithFallback } from './cache-core.js';

const REGISTRY_DIR = 'registry';
const MONOLITH_FILE = 'global-registry.json.gz';

/**
 * Iterative Shard Loader for Partitioned Aggregation
 * Passes shards one by one to a consumer function to keep heap usage O(1).
 */
export async function loadRegistryShardsSequentially(consumer, options = {}) {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const { slim = false, startShard = 0, endShard = 999 } = options;

    let shardFiles = [];
    try {
        shardFiles = await fs.readdir(shardDirPath);
    } catch (err) {
        // Directory might not exist yet
    }

    let validShards = shardFiles
        .filter(f => f.startsWith('part-'))
        .filter(f => {
            const idx = parseInt(f.match(/part-(\d+)/)?.[1] || '-1');
            return idx >= startShard && idx <= endShard;
        })
        .sort();

    // V18.12.5.19: Selective R2 Probing
    // If we're in a satellite task or factory aggregate, R2 is typically redundant 
    // because the 'Core' task just wrote fresh local shards.
    const inhibitR2 = process.env.AGGREGATOR_MODE === 'true' && !process.env.AGGREGATOR_FORCE_R2;

    if (validShards.length === 0) {
        if (inhibitR2) {
            console.log(`[CACHE] ⚠️ No local shards found. R2 Probe INHIBITED in Aggregator mode.`);
            return;
        }
        console.log(`[CACHE] 🔍 No local shards found. Probing for R2 baseline...`);
        for (let i = startShard; i <= 300; i++) {
            const shardName = `part-${String(i).padStart(3, '0')}.json.gz`;
            const recovered = await loadWithFallback(`registry/${shardName}`, null, false);
            if (recovered && (recovered.entities || Array.isArray(recovered))) {
                const entities = (recovered.entities || recovered).map(e => projectEntity(e, slim));
                await consumer(entities, i);
            } else if (i > 10) {
                // Stop if we hit a gap after some shards found? 
                // Or just keep going. Usually we stop after a few misses.
                break;
            }
        }
    } else {
        console.log(`[CACHE] 📂 Processing ${validShards.length} shards sequentially...`);
        for (const s of validShards) {
            const recovered = await loadWithFallback(`registry/${s}`, null, false);
            if (recovered && (recovered.entities || Array.isArray(recovered))) {
                const entities = (recovered.entities || recovered).map(e => projectEntity(e, slim));
                await consumer(entities, parseInt(s.match(/part-(\d+)/)[1]));
            }
        }
    }
}

export async function loadGlobalRegistry(options = {}) {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const monolithPath = path.join(cacheDir, MONOLITH_FILE);
    const REGISTRY_FLOOR = parseInt(process.env.REGISTRY_FLOOR || '85000');
    const { slim = false } = options;
    const inhibitR2 = process.env.AGGREGATOR_MODE === 'true' && !process.env.AGGREGATOR_FORCE_R2;
    let allEntities = [];

    const zlib = await import('zlib');
    const tryLoad = async (filepath) => {
        const data = await fs.readFile(filepath);
        const isGzip = (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b);
        if (filepath.endsWith('.gz') || isGzip) {
            try {
                const decompressed = zlib.gunzipSync(data).toString('utf-8');
                const parsed = JSON.parse(decompressed);
                const entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
                return { entities, count: entities.length };
            } catch (e) {
                if (!isGzip) console.warn(`[CACHE] Fake .gz detected: ${filepath}`);
                throw e;
            }
        }
        const parsed = JSON.parse(data.toString('utf-8'));
        const entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
        return { entities, count: entities.length };
    };

    if (process.env.FORCE_R2_RESTORE !== 'true') {
        const shardFiles = await fs.readdir(shardDirPath).catch(() => []);
        const validShards = shardFiles.filter(f => f.startsWith('part-') && (f.endsWith('.json.gz') || f.endsWith('.json')));

        if (validShards.length > 0) {
            for (const s of validShards.sort()) {
                const recovered = await loadWithFallback(`registry/${s}`, null, false);
                if (recovered && (recovered.entities || Array.isArray(recovered))) {
                    const entities = recovered.entities || recovered;
                    for (let i = 0; i < entities.length; i++) {
                        allEntities.push(projectEntity(entities[i], slim));
                    }
                }
            }
            if (allEntities.length >= REGISTRY_FLOOR) return { entities: allEntities, count: allEntities.length, didLoadFromStorage: true };
        }

        try {
            const registry = await tryLoad(monolithPath);
            const entities = registry.entities || [];
            if (entities.length >= REGISTRY_FLOOR) {
                return { entities: entities.map(e => projectEntity(e, slim)), count: entities.length, lastUpdated: registry.lastUpdated, didLoadFromStorage: true };
            }
        } catch { }
    }

    if (process.env.ALLOW_R2_RECOVERY === 'true' || process.env.FORCE_R2_RESTORE === 'true') {
        try {
            let i = 0;
            while (i < 1000) {
                const shardName = `registry/part-${String(i).padStart(3, '0')}.json.gz`;
                const recovered = await loadWithFallback(shardName, null, false);
                if (recovered && (recovered.entities || Array.isArray(recovered))) {
                    const entities = recovered.entities || recovered;
                    for (let j = 0; j < entities.length; j++) {
                        allEntities.push(projectEntity(entities[j], slim));
                    }
                    i++;
                } else break;
            }
            if (allEntities.length >= REGISTRY_FLOOR) return { entities: allEntities, count: allEntities.length, didLoadFromStorage: true };
        } catch (e) {
            console.error(`[CACHE] R2 Restoration failed: ${e.message}`);
        }
    }

    return { entities: [], count: 0, didLoadFromStorage: false };
}

/**
 * Internal Projector (Dry / Fast)
 */
function projectEntity(e, slim) {
    if (!slim) return e;
    const rawSummary = e.description || e.summary || e.seo_summary?.description || '';
    let summary = rawSummary;

    if (!summary || summary.length < 5) {
        const source = e.readme || e.content || e.html_readme || '';
        if (source) {
            summary = source.slice(0, 300).replace(/<[^>]+>/g, ' ').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 250);
        }
    }

    return {
        id: e.id,
        umid: e.umid,
        slug: e.slug || '',
        name: e.name || e.title || e.displayName || '',
        type: e.type || e.entity_type || 'model',
        author: e.author || e.creator || e.organization || '',
        description: summary,
        tags: e.tags || [],
        metrics: e.metrics || {},
        stars: e.stars || e.github_stars || 0,
        forks: e.forks || e.github_forks || 0,
        downloads: e.downloads || 0,
        likes: e.likes || 0,
        citations: e.citations || 0,
        size: e.size || '',
        runtime: e.runtime || null,
        fni_score: e.fni_score ?? e.fni ?? 0,
        fni_percentile: e.fni_percentile || e.percentile || '',
        fni_trend_7d: e.fni_trend_7d || null,
        is_rising_star: e.is_rising_star || false,
        primary_category: e.primary_category || '',
        pipeline_tag: e.pipeline_tag || '',
        published_date: e.published_date || '',
        last_modified: e.last_modified || e.last_updated || e.lastModified || e._updated || '',
        last_updated: e.last_updated || e.last_modified || e.lastModified || e._updated || '',
        lastModified: e.lastModified || e.last_updated || e.last_modified || e._updated || '',
        _updated: e._updated || e.last_updated || e.last_modified || ''
    };
}
