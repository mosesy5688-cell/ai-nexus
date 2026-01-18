/**
 * V15.17 Model Page Data Orchestrator
 * Constitutional: Split from [...slug].astro to honor < 250 lines rule.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions';
import { getModelFromCache } from './entity-cache-reader';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';

export async function prepareEntityPageData(type, slug, slugStr, locals) {
    let summaryData = null;
    let similarModels = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        console.warn(`[${type}PageData] Summary data load failed:`, e.message);
    }

    const result = await fetchEntityFromR2(type, slug, locals);
    let entity = hydrateEntity(result, type, summaryData);

    // Benchmarks Augmentation (Primarily for models/papers)
    if (type === 'model' || type === 'paper') {
        try {
            const benchResult = await loadBenchmarks(locals);
            const benchEntry = benchResult.data?.data?.find(b =>
                b.umid === slugStr.replace(/\//g, '-') ||
                b.umid === slugStr.replace(/\//g, '--') ||
                b.name === (entity?.id || slugStr)
            );

            if (benchEntry) {
                entity = augmentEntity(entity || {}, benchEntry);
            }
        } catch (benchError) {
            console.warn(`[${type}PageData] Benchmark augmentation failed:`, benchError.message);
        }
    }

    if (entity && (entity._hydrated || entity._cache_source)) {
        const resolution = deriveEntityType(entity);
        entity.entityType = resolution.type || type;
        entity.entityDefinition = ENTITY_DEFINITIONS[entity.entityType];

        // Similar entities logical hydration
        const rawSimilar = entity.similar_models || entity.similar_entities || [];
        if (Array.isArray(rawSimilar)) {
            const resolvedPromises = rawSimilar.map(async (item) => {
                if (typeof item === 'string') {
                    return await getModelFromCache(item, locals);
                }
                return item;
            });
            similarModels = (await Promise.all(resolvedPromises)).filter(Boolean);
        }

        tagsArray = Array.isArray(entity.tags) ? entity.tags : [];
        return { model: entity, isFallback: false, similarModels, tagsArray };
    } else {
        // Universal Global Fallback
        const cleanSlug = slugStr.replace(/--/g, '/');
        const parts = cleanSlug.split('/');
        const entityName = parts.pop() || 'Unknown Entity';
        const authorName = parts.join('/') || 'github';

        let fallback = {
            id: `${type}--${slugStr.replace(/\//g, '--')}`,
            name: entityName,
            author: authorName,
            source: type === 'model' ? 'huggingface' : 'github',
            source_url: type === 'model' ? `https://huggingface.co/${cleanSlug}` : `https://github.com/${cleanSlug}`,
            description: `Autonomous ${type}: ${entityName} by ${authorName}.`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        if (summaryData && Array.isArray(summaryData)) {
            const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            const searchId = norm(slugStr);
            const fallbackEntry = summaryData.find(s => {
                const sid = norm(s.id || s.umid || s.slug || '').replace(/^(hf-model|replicate|github)-/, '');
                return sid === searchId || sid.endsWith('-' + searchId) || searchId.endsWith('-' + sid) || sid === norm(slugStr);
            });

            if (fallbackEntry) {
                fallback = augmentEntity(fallback, fallbackEntry);
            }
        }

        // Apply unified hydration (beautification/VRAM/tags recovery)
        fallback = hydrateEntity(fallback, type, summaryData);
        fallback.entityType = type;
        fallback.entityDefinition = ENTITY_DEFINITIONS[type];
        tagsArray = Array.isArray(fallback.tags) ? fallback.tags : [];

        return { model: fallback, isFallback: true, repoName: entityName, similarModels, tagsArray };
    }
}

// Keep the old name for backward compatibility until refactored
export async function prepareModelPageData(slug, slugStr, locals) {
    return prepareEntityPageData('model', slug, slugStr, locals);
}
