/**
 * Mesh Orchestrator (V16.7) - Compliance Optimized
 * Centralizes node extraction, tiering, and deduplication.
 */
import { fetchMeshRelations, fetchGraphMetadata, fetchConceptMetadata, stripPrefix, isMatch, getTypeFromId } from './knowledge-cache-reader.js';

export async function getMeshProfile(locals, rootId, entity, type = 'model') {
    const normRoot = stripPrefix(rootId);
    const [rawRelations, graphMeta, knowledgeIndex] = await Promise.all([
        fetchMeshRelations(locals, rootId, { ssrOnly: true }).catch(() => []),
        fetchGraphMetadata(locals).catch(() => ({})),
        fetchConceptMetadata(locals).catch(() => ([]))
    ]);

    const nodeRegistry = new Map();
    const seenIds = new Set();
    if (normRoot) seenIds.add(normRoot);

    const tiers = {
        explanation: { title: '🧠 Theoretical Foundation', nodes: [], icon: '🧠' },
        core: { title: '💎 Core Ecosystem', nodes: [], icon: '⚡' },
        utility: { title: '🔬 Knowledge Mesh', nodes: [], icon: '🔬' },
        digest: { title: '📰 Timeline & Reports', nodes: [], icon: '📰' }
    };

    const ensureNode = (id, typeHint = 'model') => {
        const norm = stripPrefix(id);
        if (nodeRegistry.has(norm)) return nodeRegistry.get(norm);

        const meta = graphMeta[id] || {};
        const nodeType = meta.t || typeHint || getTypeFromId(id);
        const parts = id.split('--');
        const nodeAuthor = meta.author || (parts.length > 2 ? parts[parts.length - 2].replace(/-/g, ' ') : (id.startsWith('arxiv--') ? 'Research Paper' : 'Ecosystem Node'));

        const node = {
            id, norm,
            name: meta.n || id.split('--').pop().replace(/-/g, ' ').toUpperCase(),
            type: nodeType,
            icon: meta.icon || (nodeType === 'knowledge' ? '🧠' : nodeType === 'paper' ? '📄' : nodeType === 'space' ? '🚀' : nodeType === 'dataset' ? '📊' : nodeType === 'agent' ? '🤖' : nodeType === 'tool' ? '🛠️' : nodeType === 'report' ? '📰' : '📦'),
            author: nodeAuthor,
            relation: '',
            _mapped: false
        };
        nodeRegistry.set(norm, node);
        return node;
    };

    // 1. Process Relations
    rawRelations.forEach(rel => {
        const neighborId = isMatch(rel.norm_source, normRoot) ? rel.target_id : rel.source_id;
        const normNeighbor = stripPrefix(neighborId);
        if (normNeighbor === normRoot || seenIds.has(normNeighbor)) return;
        seenIds.add(normNeighbor);

        let node = ensureNode(neighborId, rel.target_type || rel.source_type);
        if (!node.relation || node.relation === 'RELATED') node.relation = (rel.relation_type || 'RELATED').toUpperCase();

        if (!node._mapped) {
            node._mapped = true;
            if (node.type === 'knowledge') tiers.explanation.nodes.push(node);
            else if (['model', 'tool', 'dataset'].includes(node.type)) tiers.core.nodes.push(node);
            else if (['agent', 'space', 'paper', 'report'].includes(node.type)) tiers.utility.nodes.push(node);
        }
    });

    // 2. Process Specific Injections (Tags, Links)
    if (entity) {
        const inject = (id, type, rel) => {
            const norm = stripPrefix(id);
            if (norm === normRoot || seenIds.has(norm)) return;
            seenIds.add(norm);

            let node = ensureNode(id, type);
            if (!node.relation || node.relation === 'RELATED') node.relation = rel;
            if (!node._mapped) {
                node._mapped = true;
                if (node.type === 'knowledge') tiers.explanation.nodes.push(node);
                else if (['model', 'tool', 'dataset'].includes(node.type)) tiers.core.nodes.push(node);
                else if (['agent', 'space', 'paper'].includes(node.type)) tiers.utility.nodes.push(node);
            }
        };

        if (Array.isArray(entity.tags)) entity.tags.slice(0, 5).forEach(t => inject(`knowledge--${t.toLowerCase().replace(/[^a-z0-9]/g, '-')}`, 'knowledge', 'TAGGED'));
        if (Array.isArray(entity.knowledge_links)) entity.knowledge_links.forEach(l => inject(`knowledge--${l.slug || l}`, 'knowledge', 'EXPLAINS'));
        if (Array.isArray(entity.arxiv_refs)) entity.arxiv_refs.forEach(r => inject(`arxiv--${r}`, 'paper', 'CITES'));
    }

    return { tiers, nodeRegistry };
}
