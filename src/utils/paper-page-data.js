/**
 * V16.5 Paper Page Data Orchestrator
 * Standardized to match Model/Agent page architecture.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON.js';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions.js';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchMeshRelations, stripPrefix } from './knowledge-cache-reader.js';

export async function preparePaperPageData(slug, slugStr, locals) {
    let summaryData = null;
    let similarEntities = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        console.warn("[PaperPageData] Summary data load failed:", e.message);
    }

    const result = await fetchEntityFromR2('paper', slug, locals);
    let paper = hydrateEntity(result, 'paper', summaryData);

    // Benchmarks Augmentation
    try {
        const benchResult = await loadBenchmarks(locals);
        const benchEntry = benchResult.data?.data?.find(b =>
            b.umid === slugStr.replace(/\//g, '-') ||
            b.umid === slugStr.replace(/\//g, '--') ||
            b.name === (paper?.id || slugStr)
        );

        if (benchEntry) {
            paper = augmentEntity(paper || {}, benchEntry);
        }
    } catch (benchError) {
        console.warn("[PaperPageData] Benchmark augmentation failed:", benchError.message);
    }

    if (paper && paper._hydrated) {
        const resolution = deriveEntityType(paper);
        paper.entityType = resolution.type;
        paper.entityDefinition = ENTITY_DEFINITIONS[paper.entityType];

        // Similar Entities (Related Models/Papers)
        const rawSimilar = paper.similar_entities || paper.related_models || [];
        if (Array.isArray(rawSimilar) && rawSimilar.length > 0) {
            similarEntities = rawSimilar.map(item => {
                if (typeof item === 'string') return { id: item, title: item.split('/').pop() };
                return item;
            });
        }

        tagsArray = Array.isArray(paper.tags) ? paper.tags : [];

        // V19.0: Read pre-fused mesh data first, fallback to global fetch
        let meshRelations = [];
        try {
            const fusedMesh = paper?.mesh_profile?.relations || paper?.meta_json?.mesh_profile?.relations;
            if (fusedMesh && Array.isArray(fusedMesh) && fusedMesh.length > 0) {
                meshRelations = fusedMesh;
            } else {
                meshRelations = await fetchMeshRelations(locals, paper.id || slugStr);
            }
            const pId = paper.id || slugStr;
            const normRoot = stripPrefix(pId);

            if (meshRelations && meshRelations.length > 0) {
                paper.models_citing = paper.models_citing || [];
                paper.datasets_used = paper.datasets_used || [];
                paper.knowledge_links = paper.knowledge_links || [];

                meshRelations.forEach(rel => {
                    const isOut = rel.norm_source === normRoot;
                    const tid = isOut ? rel.target_id : rel.source_id;
                    if (!tid) return;

                    if (tid.startsWith('hf-model--') || tid.startsWith('model--')) {
                        const id = tid.replace(/^(hf-model|model)--/, '');
                        if (!paper.models_citing.includes(id)) paper.models_citing.push(id);
                    } else if (tid.startsWith('hf-dataset--') || tid.startsWith('dataset--')) {
                        const id = tid.replace(/^(hf-dataset|dataset)--/, '');
                        if (!paper.datasets_used.includes(id)) paper.datasets_used.push(id);
                    } else if (tid.startsWith('concept--')) {
                        const knSlug = tid.replace('concept--', '');
                        if (!paper.knowledge_links.find(l => l.slug === knSlug)) {
                            paper.knowledge_links.push({
                                slug: knSlug,
                                title: knSlug.replace(/-/g, ' ').toUpperCase(),
                                icon: '📚'
                            });
                        }
                    }
                });
            }
        } catch (meshError) {
            console.warn("[PaperPageData] Mesh injection failed:", meshError.message);
        }

        return { paper, isFallback: false, similarEntities, tagsArray, meshRelations: meshRelations || [] };
    } else {
        // Fallback Paper
        const paperSlugStr = Array.isArray(slug) ? slug.join('/') : (slug || '');
        // Improved ArXiv ID extraction (handles v1, v2 suffixes)
        const arxivMatch = paperSlugStr.match(/(\d{4}\.\d{4,5}(v\d+)?)/);
        const arxivId = arxivMatch ? arxivMatch[1] : paperSlugStr.split('/').pop();

        let fallbackPaper = {
            id: `arxiv--${arxivId.replace(/\//g, '--')}`,
            title: arxivMatch ? `Research Paper: ${arxivId}` : (paperSlugStr.split('/').pop() || 'Unknown Paper'),
            arxiv_id: arxivId,
            author: 'Research Community',
            source: 'arxiv',
            source_url: `https://arxiv.org/abs/${arxivId}`,
            abstract: `Open-access research publication: ${paperSlugStr}`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        fallbackPaper = hydrateEntity(fallbackPaper, 'paper', summaryData);
        fallbackPaper.entityType = 'paper';
        fallbackPaper.entityDefinition = ENTITY_DEFINITIONS['paper'];
        tagsArray = Array.isArray(fallbackPaper.tags) ? fallbackPaper.tags : [];

        return { paper: fallbackPaper, isFallback: true, similarEntities, tagsArray, meshRelations: [] };
    }
}
