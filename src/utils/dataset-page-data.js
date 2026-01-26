/**
 * V16.5 Dataset Page Data Orchestrator
 * Standardized to match Model/Agent page architecture.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchMeshRelations, stripPrefix } from './knowledge-cache-reader.js';

export async function prepareDatasetPageData(slug, slugStr, locals) {
    let summaryData = null;
    let similarEntities = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        console.warn("[DatasetPageData] Summary data load failed:", e.message);
    }

    const result = await fetchEntityFromR2('dataset', slug, locals);
    let dataset = hydrateEntity(result, 'dataset', summaryData);

    // Benchmarks Augmentation
    try {
        const benchResult = await loadBenchmarks(locals);
        const benchEntry = benchResult.data?.data?.find(b =>
            b.umid === slugStr.replace(/\//g, '-') ||
            b.umid === slugStr.replace(/\//g, '--') ||
            b.name === (dataset?.id || slugStr)
        );

        if (benchEntry) {
            dataset = augmentEntity(dataset || {}, benchEntry);
        }
    } catch (benchError) {
        console.warn("[DatasetPageData] Benchmark augmentation failed:", benchError.message);
    }

    if (dataset && dataset._hydrated) {
        const resolution = deriveEntityType(dataset);
        dataset.entityType = resolution.type;
        dataset.entityDefinition = ENTITY_DEFINITIONS[dataset.entityType];

        // Similar Entities (Hydrate recommended models)
        const rawSimilar = dataset.similar_entities || dataset.recommended_models || [];
        if (Array.isArray(rawSimilar) && rawSimilar.length > 0) {
            similarEntities = rawSimilar.map(item => {
                if (typeof item === 'string') return { id: item, name: item.split('/').pop() };
                return item;
            });
        }

        tagsArray = Array.isArray(dataset.tags) ? dataset.tags : [];

        // Mesh Relations Integration
        let meshRelations = [];
        try {
            meshRelations = await fetchMeshRelations(locals, dataset.id || slugStr);
            const dId = dataset.id || slugStr;
            const normRoot = stripPrefix(dId);

            if (meshRelations && meshRelations.length > 0) {
                dataset.arxiv_refs = dataset.arxiv_refs || [];
                dataset.models_citing = dataset.models_citing || [];
                dataset.knowledge_links = dataset.knowledge_links || [];

                meshRelations.forEach(rel => {
                    const isOut = rel.norm_source === normRoot;
                    const tid = isOut ? rel.target_id : rel.source_id;
                    if (!tid) return;

                    if (tid.startsWith('arxiv--')) {
                        const id = tid.replace('arxiv--', '');
                        if (!dataset.arxiv_refs.includes(id)) dataset.arxiv_refs.push(id);
                    } else if (tid.startsWith('hf-model--') || tid.startsWith('model--')) {
                        const id = tid.replace(/^(hf-model|model)--/, '');
                        if (!dataset.models_citing.includes(id)) dataset.models_citing.push(id);
                    } else if (tid.startsWith('dataset--') || tid.startsWith('kaggle--')) {
                        // V16.36: Recognition of non-HF datasets in Mesh
                        const id = tid.replace(/^(dataset|kaggle)--/, '');
                        // ... handle if we had a specific list
                    }
                    else if (tid.startsWith('concept--')) {
                        const slug = tid.replace('concept--', '');
                        if (!dataset.knowledge_links.find(l => l.slug === slug)) {
                            dataset.knowledge_links.push({
                                slug,
                                title: slug.replace(/-/g, ' ').toUpperCase(),
                                icon: '📚'
                            });
                        }
                    }
                });
            }
        } catch (meshError) {
            console.warn("[DatasetPageData] Mesh injection failed:", meshError.message);
        }

        return { dataset, isFallback: false, similarEntities, tagsArray, meshRelations: meshRelations || [] };
    } else {
        // Fallback Dataset Logic (V16.36: Multi-Platform Support)
        const cleanSlug = slugStr.replace(/--/g, '/');
        const isKaggle = slugStr.toLowerCase().includes('kaggle--');
        const parts = isKaggle ? cleanSlug.replace(/^kaggle\//i, '').split('/') : cleanSlug.split('/');

        const repoName = parts.pop() || 'Unknown Dataset';
        const authorName = parts.join('/') || (isKaggle ? 'Kaggle User' : 'Community');
        const sourceUrl = isKaggle
            ? `https://www.kaggle.com/datasets/${authorName}/${repoName}`
            : `https://huggingface.co/datasets/${cleanSlug}`;

        let fallbackDataset = {
            id: isKaggle ? `kaggle--${authorName}--${repoName}` : `hf-dataset--${slugStr.replace(/\//g, '--')}`,
            name: repoName,
            author: authorName,
            source: isKaggle ? 'kaggle' : 'huggingface',
            source_url: sourceUrl,
            description: `AI research dataset: ${repoName} by ${authorName} on ${isKaggle ? 'Kaggle' : 'HuggingFace'}.`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        fallbackDataset = hydrateEntity(fallbackDataset, 'dataset', summaryData);
        fallbackDataset.entityType = 'dataset';
        fallbackDataset.entityDefinition = ENTITY_DEFINITIONS['dataset'];
        tagsArray = Array.isArray(fallbackDataset.tags) ? fallbackDataset.tags : [];

        return { dataset: fallbackDataset, isFallback: true, repoName, similarEntities, tagsArray, meshRelations: [] };
    }
}
