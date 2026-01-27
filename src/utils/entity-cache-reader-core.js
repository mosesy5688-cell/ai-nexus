// V15.1 Unified Entity Cache Reader Core (Art.I-Extended: Frontend D1 = 0)
import { R2_CACHE_URL } from '../config/constants.ts';

// Normalize entity slug for R2 storage path
export function normalizeEntitySlug(id, source = 'huggingface') {
    if (!id) return '';

    // V15.12: Handle array inputs from Astro [...slug] routes
    let slug = Array.isArray(id) ? id.join('/') : id;

    // Standardize separators for R2 storage artifact
    slug = slug.replace(/:/g, '--').replace(/\//g, '--');
    return slug;
}

// V16.2 Knowledge Mesh Alignment (SPEC-KNOWLEDGE-MESH-V16.2 Section 2.1)
export function getR2PathCandidates(type, normalizedSlug) {
    // Standardize to singular: dataset, model, agent, space, tool, paper
    const typeMap = {
        'datasets': 'dataset',
        'models': 'model',
        'agents': 'agent',
        'spaces': 'space',
        'tools': 'tool',
        'papers': 'paper'
    };
    const singular = typeMap[type] || (type.endsWith('s') ? type.slice(0, -1) : type);

    // SPEC-KNOWLEDGE-MESH-V16.2 Section 5.1: Path is cache/entities/{type}/{slug}.json
    const prefix = `cache/entities/${singular}`;
    const lowerSlug = normalizedSlug.toLowerCase();

    // 1. Direct match
    const candidates = [`${prefix}/${normalizedSlug}.json`];

    // 2. Canonical Prefix Injection (Handling mapping from 'pretty' IDs to R2 Storage keys)
    // V16.4 Forensics: Resolved prefixes from live production R2 bucket
    const prefixMap = {
        'model': ['hf-model--', 'gh-model--', 'civitai-model--', 'ollama-model--', 'civitai--', 'ollama--'],
        'dataset': ['hf-dataset--', 'kaggle-dataset--', 'dataset--'],
        'paper': ['arxiv-paper--', 'arxiv--'],
        'space': ['hf-space--'],
        'agent': ['gh-agent--', 'github-agent--', 'hf-agent--'],
        'tool': ['gh-tool--', 'github-tool--', 'github--', 'tool--']
    };

    const prefixesCheck = prefixMap[singular] || [];
    prefixesCheck.forEach(mandatoryPrefix => {
        if (!lowerSlug.startsWith(mandatoryPrefix)) {
            candidates.push(`${prefix}/${mandatoryPrefix}${lowerSlug}.json`);
        }
    });

    // 3. V16.4: R2 Replica Support (.v-1, .v-2) for resilience
    const replicas = [];
    candidates.forEach(path => {
        replicas.push(path.replace('.json', '.v-1.json'));
        replicas.push(path.replace('.json', '.v-2.json'));
    });

    return [...new Set([...candidates, ...replicas])];
}


import { hydrateEntity, augmentEntity } from './entity-hydrator.js';
export { hydrateEntity, augmentEntity };




/**
 * Base fetcher for R2 assets with local FS shim for development
 */
export async function fetchEntityFromR2(type, slug, locals) {
    const normalized = normalizeEntitySlug(slug, type);

    // 1. Try R2 Cache (Production/Preview SSR)
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (r2) {
        const paths = getR2PathCandidates(type, normalized);
        console.log(`[R2Reader] Checking ${paths.length} paths for ${type}/${normalized}`);
        for (const path of paths) {
            try {
                const file = await r2.get(path);
                if (file) {
                    const data = await file.json();
                    return {
                        entity: data.entity || data,
                        computed: data.computed || {},
                        seo: data.seo || {},
                        _cache_path: path,
                        _cache_source: 'r2-cache'
                    };
                }
            } catch (e) {
                console.warn(`[R2Reader] Error reading ${path}:`, e.message);
            }
        }
    }

    // 2. Browser/Static CDN Fetch (No R2 runtime)
    if (!r2 || typeof window !== 'undefined') {
        const paths = getR2PathCandidates(type, normalized);
        for (const path of paths) {
            try {
                const cdnUrl = `${R2_CACHE_URL}/${path}`;
                const res = await fetch(cdnUrl);
                if (res.ok) {
                    const data = await res.json();
                    return {
                        entity: data.entity || data,
                        computed: data.computed || {},
                        seo: data.seo || {},
                        _cache_path: path,
                        _cache_source: 'cdn-static'
                    };
                }
            } catch (e) {
                // Ignore and try next path
            }
        }
    }

    // 1.5. V15.2: Global CDN Fallback (entities.json)
    try {
        const cdnUrl = `${R2_CACHE_URL}/entities.json`;
        const response = await fetch(cdnUrl);
        if (response.ok) {
            const allEntities = await response.json();
            const searchSlug = normalized.toLowerCase();
            const found = allEntities.find(e => {
                const eid = (e.id || '').toLowerCase().replace(/:/g, '--').replace(/\//g, '--');
                const ename = ((e.author || '') + '--' + (e.name || '')).toLowerCase();
                return eid.endsWith(searchSlug) || ename === searchSlug || eid.includes(searchSlug);
            });

            if (found) {
                return {
                    entity: found,
                    computed: { fni: found.fni_score || 0 },
                    _cache_source: 'cdn-global'
                };
            }
        }
    } catch (e) {
        console.warn(`[Reader] Global Fallback failed:`, e.message);
    }

    // 2. Dev Shim: Local Filesystem (Art 2.4 / B14 Compatibility)
    if (import.meta.env.DEV || process.env.NODE_ENV === 'test') {

        try {
            const fs = await import('node:fs');
            // Try specific type path first, then merged, then type-merged
            const pluralType = type.endsWith('s') ? type : `${type}s`;
            const paths = [
                `g:/ai-nexus/data/cache/entities/${type}/${normalized}.json`,
                `g:/ai-nexus/data/cache/entities/${pluralType}/${normalized}.json`,
                `g:/ai-nexus/data/merged.json`,
                `g:/ai-nexus/data/${pluralType}.json`
            ];

            for (const localPath of paths) {
                if (fs.existsSync(localPath)) {
                    const raw = fs.readFileSync(localPath, 'utf-8');
                    const data = JSON.parse(raw);

                    if (localPath.endsWith('merged.json') || localPath.match(/data\/[a-z]+s\.json$/)) {
                        // Scan list for the entity
                        const list = Array.isArray(data) ? data : (data.entities || []);
                        const found = list.find(m => {
                            const mSlug = m.id || m.slug || '';
                            return normalizeEntitySlug(mSlug, type) === normalized;
                        });

                        if (found) {
                            return {
                                entity: found,
                                computed: { fni: found.fni_score || found.fni || 0 },
                                _cache_source: 'local-fs-shim'
                            };
                        }
                    } else {
                        return {
                            ...data,
                            entity: data.entity || data,
                            _cache_source: 'local-fs-shim'
                        };
                    }
                }
            }
        } catch (e) {
            console.warn(`[Reader Shim] Error:`, e.message);
        }
    }

    return null;
}


