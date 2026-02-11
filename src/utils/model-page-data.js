/**
 * V15.17 Model Page Data Orchestrator
 * Constitutional: Split from [...slug].astro to honor < 250 lines rule.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON.js';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions.js';
import { getModelFromCache } from './entity-cache-reader.js';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchMeshRelations, stripPrefix } from './knowledge-cache-reader.js';

export async function prepareModelPageData(slug, slugStr, locals) {
    let summaryData = null;
    let similarModels = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        // V18.2: Specs might be sharded/fused, non-critical if entity is found in fused/
        console.warn("[ModelPageData] Monolithic specs missing (expected in V18.2):", e.message);
    }

    const result = await fetchEntityFromR2('model', slug, locals);
    let model = result ? hydrateEntity(result, 'model', summaryData) : null;

    // V18.2 Fusion Check: If model already has benchmarks/specs fused, skip extra augmentation
    const hasFusedBenchmarks = model?.meta_json?.extended?.benchmarks || model?.benchmarks;
    const hasFusedSpecs = model?.meta_json?.params || model?.params_billions;

    // Benchmarks Augmentation (Legacy Fallback)
    if (!hasFusedBenchmarks) {
        try {
            const benchResult = await loadBenchmarks(locals);
            if (benchResult && benchResult.data && Array.isArray(benchResult.data.data)) {
                const searchId = slugStr.toLowerCase();
                const benchEntry = benchResult.data.data.find(b =>
                    (b.umid && b.umid.toLowerCase() === searchId) ||
                    (b.id && b.id.toLowerCase() === searchId) ||
                    (model?.id && b.umid === model.id)
                );

                if (benchEntry) {
                    model = augmentEntity(model || {}, benchEntry);
                }
            }
        } catch (benchError) {
            console.warn("[ModelPageData] Benchmark augmentation failed:", benchError.message);
        }
    }

    if (model && model._hydrated) {
        const resolution = deriveEntityType(model, 'model');
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

        // V16: Inject External Mesh Relations (Papers, Knowledge, etc.)
        let meshRelations = [];
        try {
            meshRelations = await fetchMeshRelations(locals, model.id || slugStr);
            const mId = model.id || slugStr;
            const normRoot = stripPrefix(mId);

            if (meshRelations && meshRelations.length > 0) {
                model.arxiv_refs = model.arxiv_refs || [];
                model.datasets_used = model.datasets_used || [];
                model.knowledge_links = model.knowledge_links || [];

                meshRelations.forEach(rel => {
                    const tid = rel.target_id;
                    if (!tid) return;

                    // SPEC-ID-V2.0 alignment: handle prefixes
                    if (tid.startsWith('arxiv--') || tid.startsWith('paper--')) {
                        const id = tid.replace(/^(arxiv|paper)--/, '');
                        if (!model.arxiv_refs.includes(id)) model.arxiv_refs.push(id);
                    } else if (tid.startsWith('hf-dataset--') || tid.startsWith('dataset--') || tid.startsWith('kaggle--')) {
                        const id = tid.replace(/^(hf-dataset|dataset|kaggle|hf)--/, '');
                        if (!model.datasets_used.includes(id)) model.datasets_used.push(id);
                    } else if (tid.startsWith('knowledge--') || tid.startsWith('concept--')) {
                        const slug = tid.replace(/^(knowledge|concept)--/, '');
                        if (!model.knowledge_links.find(l => l.slug === slug)) {
                            model.knowledge_links.push({
                                slug,
                                title: slug.replace(/-/g, ' ').toUpperCase(),
                                icon: '📚'
                            });
                        }
                    }
                });
            }
        } catch (meshError) {
            console.warn("[ModelPageData] Mesh injection failed:", meshError.message);
        }

        return { model, isFallback: false, similarModels, tagsArray, meshRelations: meshRelations || [] };
    } else {
        // V15.17: Aggressive Global Fallback
        const isV2 = slugStr.includes('--');
        const cleanSlug = isV2 ? slugStr : slugStr.replace(/\//g, '--');
        const parts = slugStr.split(/--|\//).filter(Boolean);
        const repoName = parts.pop() || 'Unknown Model';
        const authorName = parts.join('/') || 'huggingface';

        let fallbackModel = {
            id: isV2 ? slugStr : `hf-model--${cleanSlug}`,
            name: repoName,
            author: authorName,
            source: slugStr.startsWith('gh-') ? 'github' : 'huggingface',
            source_url: slugStr.startsWith('gh-') ? `https://github.com/${parts.join('/')}/${repoName}` : `https://huggingface.co/${parts.join('/')}/${repoName}`,
            description: `State-of-the-art AI model: ${repoName} by ${authorName}.`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        if (summaryData && Array.isArray(summaryData)) {
            const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            const searchId = norm(slugStr);
            const fallbackEntry = summaryData.find(s => {
                const sid = norm(s.id || s.umid || s.slug || '').replace(/^(hf-model|gh-model)--/, '');
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

        return { model: fallbackModel, isFallback: true, repoName, similarModels, tagsArray, meshRelations: [] };
    }
}
