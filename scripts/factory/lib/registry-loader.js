/**
 * Registry Loader Module V18.2.11
 * Handles sharded loading, field projection, and OOM-safe summary recovery.
 */
import fs from 'fs/promises';
import path from 'path';
import { loadWithFallback } from './cache-core.js';

const REGISTRY_DIR = 'registry';
const MONOLITH_FILE = 'global-registry.json.gz';

export async function loadGlobalRegistry(options = {}) {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const shardDirPath = path.join(cacheDir, REGISTRY_DIR);
    const monolithPath = path.join(cacheDir, MONOLITH_FILE);
    const REGISTRY_FLOOR = parseInt(process.env.REGISTRY_FLOOR || '85000');
    const { slim = false } = options;
    let allEntities = [];

    const zlib = await import('zlib');
    const tryLoad = async (filepath) => {
        const stats = await fs.stat(filepath);
        // V18.12.5.5: Use streaming for massive monoliths to bypass 4GB Buffer limit
        if (stats.size > 20 * 1024 * 1024) {
            console.log(`   💿 [Loader] Large file detected (${(stats.size / 1024 / 1024).toFixed(1)}MB), using streaming...`);
            const entities = [];
            const fileStream = (await import('fs')).createReadStream(filepath);
            const gunzip = zlib.createGunzip();
            const rl = (await import('readline')).createInterface({
                input: fileStream.pipe(gunzip),
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (!line.trim()) continue;
                try {
                    // Detect if it's a legacy array start/end or NDJSON
                    const trimmed = line.trim();
                    if (trimmed === '[' || trimmed === ']' || trimmed === '},') {
                        continue;
                    }
                    const cleanLine = trimmed.endsWith(',') ? trimmed.slice(0, -1) : trimmed;
                    const entity = JSON.parse(cleanLine);
                    entities.push(projectEntity(entity));
                } catch (e) { /* skip non-object lines */ }
            }
            return { entities, count: entities.length };
        }

        const data = await fs.readFile(filepath);
        const isGzip = (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b);
        let content;
        if (filepath.endsWith('.gz') || isGzip) {
            content = zlib.gunzipSync(data).toString('utf-8');
        } else {
            content = data.toString('utf-8');
        }

        try {
            const parsed = JSON.parse(content);
            const entities = Array.isArray(parsed) ? parsed : (parsed.entities || []);
            return { entities: entities.map(projectEntity), count: entities.length };
        } catch (e) {
            // NDJSON Fallback for smaller files
            const entities = content.split('\n')
                .filter(l => l.trim())
                .map(l => {
                    try { return projectEntity(JSON.parse(l)); } catch { return null; }
                })
                .filter(e => e !== null);
            return { entities, count: entities.length };
        }
    };

    const projectEntity = (e) => {
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
                        allEntities.push(projectEntity(entities[i]));
                    }
                }
            }
            if (allEntities.length >= REGISTRY_FLOOR) return { entities: allEntities, count: allEntities.length, didLoadFromStorage: true };
        }

        try {
            const registry = await tryLoad(monolithPath);
            const entities = registry.entities || [];
            if (entities.length >= REGISTRY_FLOOR) {
                return { entities: entities.map(projectEntity), count: entities.length, lastUpdated: registry.lastUpdated, didLoadFromStorage: true };
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
                        allEntities.push(projectEntity(entities[j]));
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
