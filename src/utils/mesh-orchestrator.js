import { fetchMeshRelations, fetchGraphMetadata, fetchConceptMetadata, fetchCategoryAlts, stripPrefix, isMatch, getTypeFromId, KNOWLEDGE_ALIAS_MAP } from './knowledge-cache-reader.js';
import { processRelationsIntoTiers, injectStructuralRelations, injectCategoryAlts } from './mesh-processor.js';
import { loadCachedJSON, loadSpecs } from './loadCachedJSON.js';
import { articles as knowledgeArticles } from '../data/knowledge-articles.js';
import { UNIVERSAL_ICONS, DEFAULT_TIERS } from './mesh-constants.js';

export async function getMeshProfile(locals, rootId, entity, options = {}) {
    const opts = typeof options === 'string' ? { type: options } : (options || {});
    const { type = 'model', ssrOnly = true } = opts;
    const normRoot = stripPrefix(rootId);
    const isSSR = Boolean(locals?.runtime?.env);
    const category = entity?.primary_category || entity?.pipeline_tag || '';

    const [rawRelations, graphMeta, knowledgeIndex, specsResult, meshStatsResult, categoryAlts] = await Promise.all([
        fetchMeshRelations(locals, rootId, { ssrOnly: isSSR ? true : ssrOnly }).catch(() => []),
        fetchGraphMetadata(locals).catch(() => ({})),
        fetchConceptMetadata(locals).catch(() => ([])),
        isSSR ? Promise.resolve(null) : loadSpecs(locals).catch(() => null),
        isSSR ? Promise.resolve(null) : loadCachedJSON('cache/mesh/stats.json', { locals }).catch(() => null),
        category ? fetchCategoryAlts(locals, category).catch(() => []) : Promise.resolve([])
    ]);

    // V22.8: Structural Early-Exit to prevent 1102 CPU timeouts
    if (isSSR && Array.isArray(rawRelations) && rawRelations.length === 0) {
        return { tiers: JSON.parse(JSON.stringify(DEFAULT_TIERS)), nodeRegistry: new Map(), filteredRelations: [] };
    }

    const nodeRegistry = new Map();
    const seenIds = new Set(normRoot ? [normRoot] : []);
    const tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));

    // V18.12.0: Integrity Guard 
    const validIds = new Set(Object.keys(graphMeta));
    if (specsResult?.data?.data) {
        specsResult.data.data.forEach(s => {
            if (s.id) validIds.add(s.id);
            if (s.umid) validIds.add(s.umid);
        });
    }

    const isNodeValid = (id) => {
        if (!id) return false;
        if (id.startsWith('knowledge--') || id.startsWith('report--')) return true;
        if (validIds.size < 100) return true;
        return validIds.has(id) || validIds.has(stripPrefix(id)) || id.includes('--');
    };

    const ensureNode = (id, typeHint = 'model') => {
        if (!id || typeof id !== 'string' || !isNodeValid(id)) return null;

        let norm = stripPrefix(id);
        if (nodeRegistry.has(norm)) return nodeRegistry.get(norm);

        const meta = graphMeta[id] || {};
        const idDerived = getTypeFromId(id);
        let nodeType = (id.includes('--')) ? idDerived : (meta.t || typeHint || idDerived);

        if (nodeType === 'knowledge' && KNOWLEDGE_ALIAS_MAP[norm]) {
            norm = KNOWLEDGE_ALIAS_MAP[norm];
            id = `knowledge--${norm}`;
        }

        const parts = id.split('--');
        const nodeAuthor = meta.author || (parts.length > 2 ? parts[parts.length - 2].replace(/-/g, ' ') : (id.startsWith('arxiv--') ? 'Research Paper' : 'Ecosystem Node'));

        const node = {
            id, norm,
            name: meta.n || id.split('--').pop()?.replace(/-/g, ' ')?.toUpperCase() || 'UNKNOWN',
            type: nodeType,
            icon: meta.icon || UNIVERSAL_ICONS[nodeType] || '📦',
            author: nodeAuthor,
            relation: '',
            _mapped: false
        };
        nodeRegistry.set(norm, node);
        return node;
    };

    // 1. Process Relations (Strict Aggregate from R2)
    const { tiers: processedTiers, processedRelations } = processRelationsIntoTiers(rawRelations, nodeRegistry, seenIds, graphMeta, tiers, normRoot, isNodeValid);

    // Merge back
    Object.assign(tiers, processedTiers);
    const filteredRelations = Array.from(processedRelations);

    // 2. High-Confidence Structural Injections (Refactored to mesh-processor.js)
    const injectionCtx = { nodeRegistry, seenIds, tiers, normRoot, isNodeValid, ensureNode, filteredRelations, isMatch };
    injectStructuralRelations(entity, injectionCtx);

    // 3. Inject Category Alts 
    if (category) injectCategoryAlts(categoryAlts, rootId, injectionCtx);

    return { tiers, nodeRegistry, filteredRelations };
}
