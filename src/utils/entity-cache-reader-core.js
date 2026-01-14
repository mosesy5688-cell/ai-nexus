// V15.1 Unified Entity Cache Reader Core (Art.I-Extended: Frontend D1 = 0)

// Normalize entity slug for R2 storage path
export function normalizeEntitySlug(id, source = 'huggingface') {
    if (!id) return '';

    let slug = id;

    slug = slug.replace(/:/g, '--').replace(/\//g, '--');
    return slug;
}

// Generates prioritized R2 path candidates for an entity
export function getR2PathCandidates(type, normalizedSlug) {
    // Standardize type (handle singular/plural inconsistencies)
    const singular = type.endsWith('s') ? type.slice(0, -1) : type;
    const plural = type.endsWith('s') ? type : `${type}s`;

    const sourcePrefixes = ['replicate--', 'huggingface--', 'github--', 'civitai--', 'ollama--', ''];

    const lowerSlug = normalizedSlug.toLowerCase();
    const dotFreeSlug = lowerSlug.replace(/\./g, '-');

    const candidates = [];
    [singular, plural].forEach(t => {
        const prefix = `cache/entities/${t}`;

        sourcePrefixes.forEach(srcPrefix => {
            candidates.push(`${prefix}/${srcPrefix}${lowerSlug}.json`);
            candidates.push(`${prefix}/${srcPrefix}${normalizedSlug}.json`);
            candidates.push(`${prefix}/${srcPrefix}${dotFreeSlug}.json`);
        });
    });

    return [...new Set(candidates)];
}

// Universal hydration for entity objects
export function hydrateEntity(data, type) {
    if (!data) return null;

    const entity = data.entity || data;
    const computed = data.computed || {};
    const seo = data.seo || {};

    // V15.2: Derive name from ID if missing (common in entities.json)
    const derivedName = entity.name || entity.title || entity.pretty_name ||
        (entity.id ? entity.id.split('--').pop() : 'Unknown');

    // Standard mappings for all types
    const hydrated = {
        ...entity,
        // V15.2: Enhanced FNI fallback chain
        fni_score: computed.fni ?? entity.fni_score ?? entity.fni ?? 0,
        fni_percentile: computed.fni_percentile ?? entity.fni_percentile ?? entity.percentile,
        // V15.2: Ensure name is always populated
        name: derivedName,
        relations: computed.relations || entity.relations || {},
        _computed: computed,
        _seo: seo,
        _hydrated: true
    };

    // Type-specific hydration
    if (type === 'model') {
        const benchmarks = computed.benchmarks || [];
        const firstBench = benchmarks[0] || {};
        hydrated.mmlu = firstBench.mmlu || entity.mmlu;
        hydrated.hellaswag = firstBench.hellaswag || entity.hellaswag;
        hydrated.arc_challenge = firstBench.arc_challenge || entity.arc_challenge;
        hydrated.avg_score = firstBench.avg_score || entity.avg_score;
    } else if (type === 'paper') {
        // V15.2: Paper-specific hydration
        hydrated.title = derivedName;
        hydrated.abstract = entity.abstract || entity.description;
    } else if (type === 'space') {
        // V15.2: Space-specific hydration
        hydrated.title = derivedName;
    } else if (type === 'tool') {
        // V15.3: Tool-specific hydration - extract friendly name from ID
        // ID format: github--author--name or ollama--name
        if (entity.id && !entity.name) {
            const parts = entity.id.split('--');
            // Remove source prefix (github, ollama, etc.)
            const namePart = parts.length > 2 ? parts.slice(2).join('/') : parts[parts.length - 1];
            hydrated.name = entity.pretty_name || namePart || derivedName;
        }
        hydrated.author = entity.author || (entity.id ? entity.id.split('--')[1] : 'Unknown');
    } else if (type === 'dataset') {
        // V15.3: Dataset-specific hydration - extract friendly name from ID
        // ID format: hf-dataset--author--name
        if (entity.id && !entity.name) {
            const parts = entity.id.split('--');
            // Remove source prefix (hf-dataset)
            const namePart = parts.length > 2 ? parts.slice(2).join('/') : parts[parts.length - 1];
            hydrated.name = entity.pretty_name || namePart || derivedName;
        }
        hydrated.author = entity.author || (entity.id && entity.id.split('--').length > 1 ? entity.id.split('--')[1] : 'Unknown');
        hydrated.title = hydrated.name;
    }

    return hydrated;
}



/**
 * Base fetcher for R2 assets with local FS shim for development
 */
export async function fetchEntityFromR2(type, slug, locals) {
    const normalized = normalizeEntitySlug(slug, type);

    // 1. Try R2 Cache (Production/Preview)
    const r2 = locals?.runtime?.env?.R2_ASSETS;
    if (r2) {
        const paths = getR2PathCandidates(type, normalized);
        for (const path of paths) {
            try {
                const file = await r2.get(path);
                if (file) {
                    const data = await file.json();
                    console.log(`[R2Reader] HIT: ${path}`);
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

        // 1.5. V15.2: CDN Fallback - Search in entities.json
        console.log(`[R2Reader] MISS for ${normalized}, trying CDN fallback...`);
        try {

            const cdnUrl = 'https://cdn.free2aitools.com/entities.json';
            const response = await fetch(cdnUrl);
            if (response.ok) {
                const allEntities = await response.json();
                const searchSlug = normalized.toLowerCase();

                // Search with multiple matching strategies
                const found = allEntities.find(e => {
                    const eid = (e.id || '').toLowerCase().replace(/:/g, '--').replace(/\//g, '--');
                    const ename = ((e.author || '') + '--' + (e.name || '')).toLowerCase();

                    // Match by ID suffix (ignores source prefix)
                    if (eid.endsWith(searchSlug)) return true;
                    // Match by author--name
                    if (ename === searchSlug) return true;
                    // Match by partial ID
                    if (eid.includes(searchSlug)) return true;

                    return false;
                });

                if (found) {
                    console.log(`[CDN Fallback] HIT: ${found.id}`);
                    return {
                        entity: found,
                        computed: { fni: found.fni_score || 0 },
                        _cache_source: 'cdn-fallback'
                    };
                }
            }
        } catch (e) {
            console.warn(`[CDN Fallback] Error:`, e.message);
        }
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
