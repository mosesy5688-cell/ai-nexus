// V15.1 Unified Entity Cache Reader Core (Art.I-Extended: Frontend D1 = 0)

// Normalize entity slug for R2 storage path
export function normalizeEntitySlug(id, source = 'huggingface') {
    if (!id) return '';

    // V15.12: Handle array inputs from Astro [...slug] routes
    let slug = Array.isArray(id) ? id.join('/') : id;

    // Standardize separators for R2 storage artifact
    slug = slug.replace(/:/g, '--').replace(/\//g, '--');
    return slug;
}

// Generates prioritized R2 path candidates for an entity
export function getR2PathCandidates(type, normalizedSlug) {
    const singular = type.endsWith('s') ? type.slice(0, -1) : type;
    const plural = type.endsWith('s') ? type : `${type}s`;

    // V15.10: Check if slug already has arxiv-- prefix to avoid double prefixing
    const hasArxivPrefix = normalizedSlug.toLowerCase().startsWith('arxiv--');
    const sourcePrefixes = singular === 'paper'
        ? (hasArxivPrefix ? [''] : ['arxiv--', ''])  // Skip adding prefix if already present
        : ['replicate--', 'huggingface--', 'github--', 'civitai--', 'ollama--', 'hf-agent--', ''];
    const lowerSlug = normalizedSlug.toLowerCase();
    const dotFreeSlug = lowerSlug.replace(/\./g, '-');

    // V15.4: ArXiv version suffixes (v1-v9) for paper matching
    const arxivVersions = (singular === 'paper') ? ['', 'v1', 'v2', 'v3', 'v4', 'v5'] : [''];



    const candidates = [];
    [singular, plural].forEach(t => {
        const prefix = `cache/entities/${t}`;
        sourcePrefixes.forEach(srcPrefix => {
            arxivVersions.forEach(ver => {
                const suffix = ver ? ver : '';
                candidates.push(`${prefix}/${srcPrefix}${lowerSlug}${suffix}.json`);
                candidates.push(`${prefix}/${srcPrefix}${normalizedSlug}${suffix}.json`);
                candidates.push(`${prefix}/${srcPrefix}${dotFreeSlug}${suffix}.json`);
            });
        });
    });
    return [...new Set(candidates)];
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
                const cdnUrl = `https://cdn.free2aitools.com/${path}`;
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
        const cdnUrl = 'https://cdn.free2aitools.com/entities.json';
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


