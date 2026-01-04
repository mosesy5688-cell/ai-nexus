// src/utils/entity-cache-reader.js
/**
 * V14.4 Entity Cache Reader
 * Protocol: Zero-Entropy (R2 direct read)
 * 
 * Matches Factory Output Path:
 * /entities/{type}/{slug}.json
 * 
 * Legacy KV/D1 logic removed.
 */

/**
 * Resolve entity from R2
 * @param {string|string[]} slug - Entity slug
 * @param {object} locals - Astro locals
 * @param {string} forceType - Optional type override (model, dataset, space)
 */
export async function resolveEntityFromCache(slug, locals, forceType = null) {
    if (!slug || (Array.isArray(slug) && slug.length === 0)) {
        return { entity: null, source: 'invalid-slug' };
    }

    // Normalize slug to string
    const slugStr = Array.isArray(slug) ? slug.join('/') : slug;

    // Determine type
    let type = forceType || 'model';

    // Auto-detect if slug implies type (fallback)
    if (!forceType) {
        if (slugStr.startsWith('dataset/')) type = 'dataset';
        if (slugStr.startsWith('space/')) type = 'space';
        if (slugStr.startsWith('agent/')) type = 'agent';
    }

    // R2 Binding
    const r2 = locals?.runtime?.env?.R2_ASSETS;

    // Dev Shim
    if (!r2 && (import.meta.env.DEV || process.env.NODE_ENV === 'test')) {
        console.log('[EntityCache] Shim: Returning Mock for ' + slugStr);
        return {
            entity: {
                id: slugStr,
                name: 'Dev Mock Entity',
                type: type,
                description: 'Mock entity for local development.',
                fni_score: 90
            },
            source: 'shim-mock'
        };
    }

    if (!r2) {
        console.warn('[EntityCache] R2 not available');
        return { entity: null, source: 'no-r2' };
    }

    // Try multiple paths to find the entity
    // V14.4 Standard: entities/{type}/{slug}.json
    const pathsToTry = [
        `entities/${type}/${slugStr}.json`,
        // Retry with flattened slug just in case (legacy compat)
        `entities/${type}/${slugStr.replace(/\//g, '--')}.json`
    ];

    for (const path of pathsToTry) {
        try {
            const obj = await r2.get(path);
            if (obj) {
                const data = await obj.json();
                console.log(`[EntityCache] R2 HIT: ${path}`);

                // Data might be raw entity or wrapped { entity, computed }
                const entity = data.entity || data;

                return {
                    entity,
                    computed: data.computed || {},
                    source: 'r2'
                };
            }
        } catch (e) {
            // Ignore 404s
        }
    }

    console.log(`[EntityCache] MISS: ${slugStr} (type=${type})`);
    return { entity: null, source: 'miss' };
}

export async function getModelFromCache(slug, locals) {
    const res = await resolveEntityFromCache(slug, locals, 'model');
    return res.entity;
}

export async function entityExistsInCache(slug, locals) {
    const res = await resolveEntityFromCache(slug, locals, 'model'); // assumption
    return !!res.entity;
}

export async function getSpaceFromCache(slug, locals) {
    const res = await resolveEntityFromCache(slug, locals, 'space');
    return res.entity;
}
export async function getDatasetFromCache(slug, locals) {
    const res = await resolveEntityFromCache(slug, locals, 'dataset');
    return res.entity;
}
export async function getRelatedEntities(slug, locals) {
    const model = await getModelFromCache(slug, locals);
    return model?.relations || [];
}
