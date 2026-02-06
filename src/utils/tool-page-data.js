/**
 * V16.5 Tool Page Data Orchestrator
 * Standardized to match Model/Agent page architecture.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchMeshRelations, stripPrefix } from './knowledge-cache-reader.js';

export async function prepareToolPageData(slug, slugStr, locals) {
    let summaryData = null;
    let similarEntities = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        console.warn("[ToolPageData] Summary data load failed:", e.message);
    }

    const result = await fetchEntityFromR2('tool', slug, locals);
    let tool = hydrateEntity(result, 'tool', summaryData);

    // Benchmarks Augmentation
    try {
        const benchResult = await loadBenchmarks(locals);
        const benchEntry = benchResult.data?.data?.find(b =>
            b.umid === slugStr.replace(/\//g, '-') ||
            b.umid === slugStr.replace(/\//g, '--') ||
            b.name === (tool?.id || slugStr)
        );

        if (benchEntry) {
            tool = augmentEntity(tool || {}, benchEntry);
        }
    } catch (benchError) {
        console.warn("[ToolPageData] Benchmark augmentation failed:", benchError.message);
    }

    if (tool && tool._hydrated) {
        const resolution = deriveEntityType(tool);
        tool.entityType = resolution.type;
        tool.entityDefinition = ENTITY_DEFINITIONS[tool.entityType];

        // Similar Entities (Related Tools/Frameworks)
        const rawSimilar = tool.similar_entities || tool.related_tools || [];
        if (Array.isArray(rawSimilar) && rawSimilar.length > 0) {
            similarEntities = rawSimilar.map(item => {
                if (typeof item === 'string') return { id: item, name: item.split('/').pop() };
                return item;
            });
        }

        tagsArray = Array.isArray(tool.tags) ? tool.tags : [];

        // Mesh Relations Integration
        let meshRelations = [];
        try {
            meshRelations = await fetchMeshRelations(locals, tool.id || slugStr);
            const tId = tool.id || slugStr;
            const normRoot = stripPrefix(tId);

            if (meshRelations && meshRelations.length > 0) {
                tool.knowledge_links = tool.knowledge_links || [];

                meshRelations.forEach(rel => {
                    const isOut = rel.norm_source === normRoot;
                    const tid = isOut ? rel.target_id : rel.source_id;
                    if (!tid) return;

                    if (tid.startsWith('concept--')) {
                        const knSlug = tid.replace('concept--', '');
                        if (!tool.knowledge_links.find(l => l.slug === knSlug)) {
                            tool.knowledge_links.push({
                                slug: knSlug,
                                title: knSlug.replace(/-/g, ' ').toUpperCase(),
                                icon: '📚'
                            });
                        }
                    } else if (tid.startsWith('hf-model--') || tid.startsWith('model--')) {
                        const id = tid.replace(/^(hf-model|model)--/, '');
                        tool.models_citing = tool.models_citing || [];
                        if (!tool.models_citing.includes(id)) tool.models_citing.push(id);
                    } else if (tid.startsWith('arxiv--') || tid.startsWith('paper--')) {
                        const id = tid.replace(/^(arxiv|paper)--/, '');
                        tool.arxiv_refs = tool.arxiv_refs || [];
                        if (!tool.arxiv_refs.includes(id)) tool.arxiv_refs.push(id);
                    }
                });
            }
        } catch (meshError) {
            console.warn("[ToolPageData] Mesh injection failed:", meshError.message);
        }

        return { tool, isFallback: false, similarEntities, tagsArray, meshRelations: meshRelations || [] };
    } else {
        // Fallback Tool
        const cleanSlug = slugStr.replace(/--/g, '/');
        const parts = cleanSlug.split('/');
        const repoName = parts.pop() || 'Unknown Tool';
        const authorName = parts.join('/') || 'Community';

        let fallbackTool = {
            id: `hf-tool--${slugStr.replace(/\//g, '--')}`,
            name: repoName,
            author: authorName,
            source: 'github',
            source_url: `https://github.com/${cleanSlug}`,
            description: `AI Development Tool: ${repoName} by ${authorName}.`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        fallbackTool = hydrateEntity(fallbackTool, 'tool', summaryData);
        fallbackTool.entityType = 'tool';
        fallbackTool.entityDefinition = ENTITY_DEFINITIONS['tool'];
        tagsArray = Array.isArray(fallbackTool.tags) ? fallbackTool.tags : [];

        return { tool: fallbackTool, isFallback: true, repoName, similarEntities, tagsArray, meshRelations: [] };
    }
}
