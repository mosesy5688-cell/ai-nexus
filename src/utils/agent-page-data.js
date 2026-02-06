/**
 * V16.5 Agent Page Data Orchestrator
 * Standardized to match Model page architecture.
 */
import { hydrateEntity, augmentEntity } from './entity-cache-reader-core.js';
import { loadSpecs, loadBenchmarks } from './loadCachedJSON';
import { deriveEntityType, ENTITY_DEFINITIONS } from '../data/entity-definitions';
import { fetchEntityFromR2 } from './entity-cache-reader-core.js';
import { fetchMeshRelations, stripPrefix } from './knowledge-cache-reader.js';

export async function prepareAgentPageData(slug, slugStr, locals) {
    let summaryData = null;
    let similarEntities = [];
    let tagsArray = [];

    try {
        const specsResult = await loadSpecs(locals);
        summaryData = specsResult.data?.data || [];
    } catch (e) {
        console.warn("[AgentPageData] Summary data load failed:", e.message);
    }

    // V16.5: Fetch specifically as 'agent' type
    const result = await fetchEntityFromR2('agent', slug, locals);
    let agent = hydrateEntity(result, 'agent', summaryData);

    // Benchmarks Augmentation (V16.5 Unified)
    try {
        const benchResult = await loadBenchmarks(locals);
        const benchEntry = benchResult.data?.data?.find(b =>
            b.umid === slugStr.replace(/\//g, '-') ||
            b.umid === slugStr.replace(/\//g, '--') ||
            b.name === (agent?.id || slugStr)
        );

        if (benchEntry) {
            agent = augmentEntity(agent || {}, benchEntry);
        }
    } catch (benchError) {
        console.warn("[AgentPageData] Benchmark augmentation failed:", benchError.message);
    }

    if (agent && agent._hydrated) {
        const resolution = deriveEntityType(agent, 'agent');
        agent.entityType = resolution.type;
        agent.entityDefinition = ENTITY_DEFINITIONS[agent.entityType];

        // Similar Entities logical hydration (V16.5 Unified)
        const rawSimilar = agent.similar_entities || agent.similar_models || agent.related_projects || [];
        if (Array.isArray(rawSimilar) && rawSimilar.length > 0) {
            const resolvedPromises = rawSimilar.map(async (item) => {
                if (typeof item === 'string') {
                    // Try to get from cache (generic fallback to entity-cache-reader)
                    return await hydrateEntity({ id: item }, 'agent', summaryData);
                }
                return item;
            });
            similarEntities = (await Promise.all(resolvedPromises)).filter(Boolean);
        }

        tagsArray = Array.isArray(agent.tags) ? agent.tags : [];

        // Mesh Relations Integration
        let meshRelations = [];
        try {
            meshRelations = await fetchMeshRelations(locals, agent.id || slugStr);
            const aId = agent.id || slugStr;
            const normRoot = stripPrefix(aId);

            if (meshRelations && meshRelations.length > 0) {
                agent.arxiv_refs = agent.arxiv_refs || [];
                agent.datasets_used = agent.datasets_used || [];
                agent.knowledge_links = agent.knowledge_links || [];

                meshRelations.forEach(rel => {
                    const isOut = rel.norm_source === normRoot;
                    const tid = isOut ? rel.target_id : rel.source_id;
                    if (!tid) return;

                    if (tid.startsWith('arxiv--') || tid.startsWith('paper--')) {
                        const id = tid.replace(/^(arxiv|paper)--/, '');
                        if (!agent.arxiv_refs.includes(id)) agent.arxiv_refs.push(id);
                    } else if (tid.startsWith('hf-dataset--') || tid.startsWith('dataset--')) {
                        const id = tid.replace(/^(hf-dataset|dataset)--/, '');
                        if (!agent.datasets_used.includes(id)) agent.datasets_used.push(id);
                    } else if (tid.startsWith('concept--')) {
                        const knSlug = tid.replace('concept--', '');
                        if (!agent.knowledge_links.find(l => l.slug === knSlug)) {
                            agent.knowledge_links.push({
                                slug: knSlug,
                                title: knSlug.replace(/-/g, ' ').toUpperCase(),
                                icon: '📚'
                            });
                        }
                    }
                });
            }
        } catch (meshError) {
            console.warn("[AgentPageData] Mesh injection failed:", meshError.message);
        }

        return { agent, isFallback: false, similarEntities, tagsArray, meshRelations: meshRelations || [] };
    } else {
        // Fallback Agent (Consistent with Model fallback)
        const cleanSlug = slugStr.replace(/--/g, '/');
        const parts = cleanSlug.split('/');
        const repoName = parts.pop() || 'Unknown Agent';
        const authorName = parts.join('/') || 'Community';

        let fallbackAgent = {
            id: `hf-agent--${slugStr.replace(/\//g, '--')}`,
            name: repoName,
            author: authorName,
            source: 'huggingface',
            source_url: `https://huggingface.co/${cleanSlug}`,
            description: `Autonomous agent entity: ${repoName} by ${authorName}.`,
            tags: [],
            fni_score: 0,
            _cache_source: 'fallback-ui'
        };

        fallbackAgent = hydrateEntity(fallbackAgent, 'agent', summaryData);
        fallbackAgent.entityType = 'agent';
        fallbackAgent.entityDefinition = ENTITY_DEFINITIONS['agent'];
        tagsArray = Array.isArray(fallbackAgent.tags) ? fallbackAgent.tags : [];

        return { agent: fallbackAgent, isFallback: true, repoName, similarEntities, tagsArray, meshRelations: [] };
    }
}
