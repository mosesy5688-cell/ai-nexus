/**
 * V16.5 Space Page Data Orchestrator
 * Standardized to match Model/Agent page architecture.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchMeshRelations, stripPrefix } from './knowledge-cache-reader.js';

export async function prepareSpacePageData(slug, slugStr, locals) {
    let summaryData = null;
    let similarEntities = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        console.warn("[SpacePageData] Summary data load failed:", e.message);
    }

    const result = await fetchEntityFromR2('space', slug, locals);
    let space = hydrateEntity(result, 'space', summaryData);

    // Benchmarks Augmentation
    try {
        const benchResult = await loadBenchmarks(locals);
        const benchEntry = benchResult.data?.data?.find(b =>
            b.umid === slugStr.replace(/\//g, '-') ||
            b.umid === slugStr.replace(/\//g, '--') ||
            b.name === (space?.id || slugStr)
        );

        if (benchEntry) {
            space = augmentEntity(space || {}, benchEntry);
        }
    } catch (benchError) {
        console.warn("[SpacePageData] Benchmark augmentation failed:", benchError.message);
    }

    if (space && space._hydrated) {
        const resolution = deriveEntityType(space);
        space.entityType = resolution.type;
        space.entityDefinition = ENTITY_DEFINITIONS[space.entityType];

        // Similar Entities (Related Models/Spaces)
        const rawSimilar = space.similar_entities || space.related_models || [];
        if (Array.isArray(rawSimilar) && rawSimilar.length > 0) {
            similarEntities = rawSimilar.map(item => {
                if (typeof item === 'string') return { id: item, name: item.split('/').pop() };
                return item;
            });
        }

        tagsArray = Array.isArray(space.tags) ? space.tags : [];

        // Mesh Relations Integration
        try {
            const meshRelations = await fetchMeshRelations(locals, space.id || slugStr);
            const sId = space.id || slugStr;
            const normRoot = stripPrefix(sId);

            if (meshRelations && meshRelations.length > 0) {
                space.models_used = space.models_used || [];
                space.knowledge_links = space.knowledge_links || [];

                meshRelations.forEach(rel => {
                    const isOut = rel.norm_source === normRoot;
                    const tid = isOut ? rel.target_id : rel.source_id;
                    if (!tid) return;

                    if (tid.startsWith('hf-model--')) {
                        const id = tid.replace('hf-model--', '');
                        if (!space.models_used.includes(id)) space.models_used.push(id);
                    } else if (tid.startsWith('concept--')) {
                        const knSlug = tid.replace('concept--', '');
                        if (!space.knowledge_links.find(l => l.slug === knSlug)) {
                            space.knowledge_links.push({
                                slug: knSlug,
                                title: knSlug.replace(/-/g, ' ').toUpperCase(),
                                icon: '📚'
                            });
                        }
                    }
                });
            }
        } catch (meshError) {
            console.warn("[SpacePageData] Mesh injection failed:", meshError.message);
        }

        return { space, isFallback: false, similarEntities, tagsArray, meshRelations: meshRelations || [] };
    } else {
        // Fallback Space
        const cleanSlug = slugStr.replace(/--/g, '/');
        const parts = cleanSlug.split('/');
        const repoName = parts.pop() || 'Unknown Space';
        const authorName = parts.join('/') || 'Community';

        let fallbackSpace = {
            id: `hf-space--${slugStr.replace(/\//g, '--')}`,
            name: repoName,
            author: authorName,
            source: 'huggingface',
            source_url: `https://huggingface.co/spaces/${cleanSlug}`,
            description: `Interactive AI demo: ${repoName} by ${authorName}.`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        fallbackSpace = hydrateEntity(fallbackSpace, 'space', summaryData);
        fallbackSpace.entityType = 'space';
        fallbackSpace.entityDefinition = ENTITY_DEFINITIONS['space'];
        tagsArray = Array.isArray(fallbackSpace.tags) ? fallbackSpace.tags : [];

        return { space: fallbackSpace, isFallback: true, repoName, similarEntities, tagsArray, meshRelations: [] };
    }
}
