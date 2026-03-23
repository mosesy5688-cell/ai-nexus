/**
 * Registry Loader Module V25.8.2
 * Handles binary NXVF shards (primary) with transparent JSON.gz fallback.
 */
import fs from 'fs/promises';
import path from 'path';
import { loadWithFallback } from './cache-core.js';
import { readBinaryShard, isBinaryShard } from './registry-binary-reader.js';

const REGISTRY_DIR = 'registry';
const MONOLITH_FILE = 'global-registry.json.gz';

/**
 * Iterative Shard Loader — Binary + JSON.gz (O(1) heap per shard)
 */
export async function loadRegistryShardsSequentially(consumer, options = {}) {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const { slim = false, startShard = 0, endShard = 999 } = options;

    let shardFiles = [];
    try {
        shardFiles = await fs.readdir(shardDirPath);
    } catch {
        return;
    }

    // V25.8.3: Dedup shards — prefer .bin > .json.gz > .json per shard index
    const shardPriority = new Map(); // index -> { priority, filename }
    for (const f of shardFiles) {
        if (!f.startsWith('part-')) continue;
        const idx = parseInt(f.match(/part-(\d+)/)?.[1] || '-1');
        if (idx < startShard || idx > endShard) continue;
        const prio = f.endsWith('.bin') ? 0 : f.endsWith('.json.zst') ? 1 : f.endsWith('.json.gz') ? 2 : f.endsWith('.json') ? 3 : 99;
        if (prio > 3) continue;
        const existing = shardPriority.get(idx);
        if (!existing || prio < existing.priority) {
            shardPriority.set(idx, { priority: prio, filename: f });
        }
    }
    const validShards = Array.from(shardPriority.values()).map(v => v.filename).sort();

    const inhibitR2 = process.env.AGGREGATOR_MODE === 'true' && !process.env.AGGREGATOR_FORCE_R2;

    if (validShards.length === 0) {
        if (inhibitR2) {
            console.log(`[CACHE] No local shards found. R2 Probe INHIBITED in Aggregator mode.`);
            return;
        }
        console.log(`[CACHE] No local shards found. Probing for R2 baseline...`);
        for (let i = startShard; i <= 300; i++) {
            const shardName = `part-${String(i).padStart(3, '0')}.json.gz`;
            const recovered = await loadWithFallback(`registry/${shardName}`, null, false);
            if (recovered && (recovered.entities || Array.isArray(recovered))) {
                const entities = (recovered.entities || recovered).map(e => projectEntity(e, slim));
                await consumer(entities, i);
            } else if (i > 10) {
                break;
            }
        }
    } else {
        console.log(`[CACHE] Processing ${validShards.length} shards sequentially...`);
        for (const s of validShards) {
            const shardIdx = parseInt(s.match(/part-(\d+)/)[1]);
            const fullPath = path.join(shardDirPath, s);
            const entities = await loadShardAuto(fullPath, s, slim);
            if (entities && entities.length > 0) {
                await consumer(entities, shardIdx);
            }
        }
    }
}

/**
 * Auto-detect shard format and load entities
 */
async function loadShardAuto(fullPath, filename, slim) {
    // Binary NXVF shard (primary path)
    if (filename.endsWith('.bin') && isBinaryShard(fullPath)) {
        const result = await readBinaryShard(fullPath);
        if (result && result.entities) {
            return result.entities.map(e => projectEntity(e, slim));
        }
        return [];
    }
    // JSON.gz fallback (legacy compatibility)
    const recovered = await loadWithFallback(`registry/${filename}`, null, false);
    if (recovered && (recovered.entities || Array.isArray(recovered))) {
        return (recovered.entities || recovered).map(e => projectEntity(e, slim));
    }
    return [];
}

export async function loadGlobalRegistry(options = {}) {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const monolithPath = path.join(cacheDir, MONOLITH_FILE);
    const REGISTRY_FLOOR = parseInt(process.env.REGISTRY_FLOOR || '85000');
    const { slim = false } = options;
    let allEntities = [];

    if (process.env.FORCE_R2_RESTORE !== 'true') {
        const shardFiles = await fs.readdir(shardDirPath).catch(() => []);
        // V25.8.2: Accept .bin (binary) + .json.gz/.json (legacy)
        const validShards = shardFiles.filter(f =>
            f.startsWith('part-') && (f.endsWith('.bin') || f.endsWith('.json.gz') || f.endsWith('.json'))
        );

        if (validShards.length > 0) {
            for (const s of validShards.sort()) {
                const fullPath = path.join(shardDirPath, s);
                const entities = await loadShardAuto(fullPath, s, slim);
                for (const e of entities) allEntities.push(e);
            }
            if (allEntities.length >= REGISTRY_FLOOR) {
                return { entities: allEntities, count: allEntities.length, didLoadFromStorage: true };
            }
        }

        // Monolith fallback (always JSON.gz)
        try {
            const registry = await tryLoadJsonGz(monolithPath);
            const entities = registry.entities || [];
            if (entities.length >= REGISTRY_FLOOR) {
                return {
                    entities: entities.map(e => projectEntity(e, slim)),
                    count: entities.length,
                    lastUpdated: registry.lastUpdated,
                    didLoadFromStorage: true
                };
            }
        } catch { }
    }

    // R2 Recovery (V25.8: Binary .bin + legacy .json.gz)
    if (process.env.ALLOW_R2_RECOVERY === 'true' || process.env.FORCE_R2_RESTORE === 'true') {
        try {
            const { restoreRegistryFromR2 } = await import('./r2-registry-restore.js');
            const result = await restoreRegistryFromR2();
            if (result.success) {
                // Re-scan local shards after R2 restore
                const restoredFiles = await fs.readdir(shardDirPath).catch(() => []);
                const restoredShards = restoredFiles.filter(f =>
                    f.startsWith('part-') && (f.endsWith('.bin') || f.endsWith('.json.gz') || f.endsWith('.json'))
                );
                for (const s of restoredShards.sort()) {
                    const fullPath = path.join(shardDirPath, s);
                    const entities = await loadShardAuto(fullPath, s, slim);
                    for (const e of entities) allEntities.push(e);
                }
                if (allEntities.length >= REGISTRY_FLOOR) {
                    return { entities: allEntities, count: allEntities.length, didLoadFromStorage: true };
                }
            }
        } catch (e) {
            console.error(`[CACHE] R2 Restoration failed: ${e.message}`);
        }
    }

    return { entities: [], count: 0, didLoadFromStorage: false };
}

async function tryLoadJsonGz(filepath) {
    const { autoDecompress } = await import('./zstd-helper.js');
    const data = await fs.readFile(filepath);
    const decompressed = await autoDecompress(data);
    const parsed = JSON.parse(decompressed.toString('utf-8'));
    const entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
    return { entities, count: entities.length, lastUpdated: parsed.lastUpdated };
}

/**
 * Internal Projector (Dry / Fast)
 */
export function projectEntity(e, slim) {
    if (!slim) return e;

    const rawSummary = e.description || e.summary || e.seo_summary?.description || '';
    let summary = rawSummary;
    if (!summary || summary.length < 5) {
        const source = e.readme || e.content || e.html_readme || e.body_content || '';
        if (source) {
            summary = source.slice(0, 300).replace(/<[^>]+>/g, ' ').replace(/[#*`]/g, '').replace(/\s+/g, ' ').trim().slice(0, 250);
        }
    }

    return {
        id: e.id, umid: e.umid, slug: e.slug || '',
        name: e.name || e.title || e.displayName || '',
        type: e.type || e.entity_type || 'model',
        author: e.author || e.creator || e.organization || '',
        description: summary,
        tags: e.tags || [],
        metrics: e.metrics || {},
        stars: e.stars || e.github_stars || 0,
        downloads: e.downloads || 0,
        likes: e.likes || 0,
        citations: e.citations || 0,
        fni_score: e.fni_score ?? e.fni ?? 0,
        fni_percentile: e.fni_percentile || e.percentile || '',
        fni_p: e.fni_p ?? e.fni_metrics?.p ?? 0,
        fni_v: e.fni_v ?? e.fni_metrics?.f ?? e.fni_metrics?.v ?? 0,
        fni_c: e.fni_c ?? e.fni_metrics?.c ?? 0,
        fni_u: e.fni_u ?? e.fni_metrics?.u ?? 0,
        primary_category: e.primary_category || '',
        pipeline_tag: e.pipeline_tag || '',
        last_modified: e.last_modified || e.last_updated || e.lastModified || e._updated || '',
        license: e.license || e.license_spdx || '',
        source: e.source || ''
    };
}
