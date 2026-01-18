/**
 * V15.17 Model Page Data Orchestrator
 * Constitutional: Split from [...slug].astro to honor < 250 lines rule.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions';
import { getModelFromCache } from './entity-cache-reader';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';

export async function prepareModelPageData(slug, slugStr, locals) {
    let summaryData = null;
    let similarModels = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        console.warn("[ModelPageData] Summary data load failed:", e.message);
    }

    const result = await fetchEntityFromR2('model', slug, locals);
    let model = hydrateEntity(result, 'model', summaryData);

    // Benchmarks Augmentation
    try {
        const benchResult = await loadBenchmarks(locals);
        const benchEntry = benchResult.data?.data?.find(b =>
            b.umid === slugStr.replace(/\//g, '-') ||
            b.umid === slugStr.replace(/\//g, '--') ||
            b.name === (model?.id || slugStr)
        );

        if (benchEntry) {
            model = augmentEntity(model || {}, benchEntry);
        }
    } catch (benchError) {
        console.warn("[ModelPageData] Benchmark augmentation failed:", benchError.message);
    }

    if (model && model._hydrated) {
        const resolution = deriveEntityType(model);
        model.entityType = resolution.type;
        model.entityDefinition = ENTITY_DEFINITIONS[model.entityType];

        // Similar models logical hydration
        if (model.similar_models && Array.isArray(model.similar_models)) {
            const rawSimilar = model.similar_models;
            const resolvedPromises = rawSimilar.map(async (item) => {
                if (typeof item === 'string') {
                    return await getModelFromCache(item, locals);
                }
                return item;
            });
            similarModels = (await Promise.all(resolvedPromises)).filter(Boolean);
        }

        tagsArray = Array.isArray(model.tags) ? model.tags : [];
        return { model, isFallback: false, similarModels, tagsArray };
    } else {
        // V15.17: Aggressive Global Fallback
        const cleanSlug = slugStr.replace(/--/g, '/');
        const parts = cleanSlug.split('/');
        const repoName = parts.pop() || 'Unknown Model';
        const authorName = parts.join('/') || 'huggingface';

        let fallbackModel = {
            id: `hf-model--${slugStr.replace(/\//g, '--')}`,
            name: repoName,
            author: authorName,
            source: 'huggingface',
            source_url: `https://huggingface.co/${cleanSlug}`,
            description: `State-of-the-art AI model: ${repoName} by ${authorName}.`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        if (summaryData && Array.isArray(summaryData)) {
            const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            const searchId = norm(slugStr);
            const fallbackEntry = summaryData.find(s => {
                const sid = norm(s.id || s.umid || s.slug || '').replace(/^hf-model-/, '');
                return sid === searchId || sid.endsWith('-' + searchId) || searchId.endsWith('-' + sid) || sid === norm(slugStr);
            });

            if (fallbackEntry) {
                fallbackModel = augmentEntity(fallbackModel, fallbackEntry);
            }
        }

        // V15.18: Apply unified hydration to fallback model for beautification/VRAM
        fallbackModel = hydrateEntity(fallbackModel, 'model', summaryData);

        fallbackModel.entityType = 'model';
        fallbackModel.entityDefinition = ENTITY_DEFINITIONS['model'];
        tagsArray = Array.isArray(fallbackModel.tags) ? fallbackModel.tags : [];

        return { model: fallbackModel, isFallback: true, repoName, similarModels, tagsArray };
    }
}
