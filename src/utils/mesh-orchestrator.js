/**
 * Mesh Orchestrator (V16.11) - Compliance Optimized
 * Centralizes node extraction, tiering, and deduplication.
 * V16.11: Restricted to R2 Source only. No dynamic tag promotion.
 */
import { fetchMeshRelations, fetchGraphMetadata, fetchConceptMetadata, stripPrefix, isMatch, getTypeFromId, normalizeSlug } from './knowledge-cache-reader.js';

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
        explanation: { title: '🎓 Knowledge Base', nodes: [], icon: '🎓' },
        core: { title: '🔗 Core Ecosystem', nodes: [], icon: '⚡' },
        utility: { title: '🔬 Research & Data', nodes: [], icon: '🔬' },
        digest: { title: '📰 Timeline & Reports', nodes: [], icon: '📰' }
    };

    const UNIVERSAL_ICONS = {
        'model': '🧠',
        'agent': '🤖',
        'tool': '⚙️',
        'dataset': '📊',
        'paper': '📄',
        'space': '🚀',
        'knowledge': '🎓',
        'report': '📰'
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
            icon: meta.icon || UNIVERSAL_ICONS[nodeType] || '📦',
            author: nodeAuthor,
            relation: '',
            _mapped: false
        };
        nodeRegistry.set(norm, node);
        return node;
    };

    // 1. Process Relations (The ONLY source for the Mesh Hub)
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
            else if (['model', 'agent', 'tool', 'space'].includes(node.type)) tiers.core.nodes.push(node);
            else if (['dataset', 'paper', 'report'].includes(node.type)) tiers.utility.nodes.push(node);
        }
    });

    // 2. Process High-Confidence Injections (ArXiv ONLY)
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
                else if (['model', 'agent', 'tool', 'space'].includes(node.type)) tiers.core.nodes.push(node);
                else if (['dataset', 'paper'].includes(node.type)) tiers.utility.nodes.push(node);
            }
        };

        // Removed Tag-to-Mesh injection to prevent 404 ghost nodes.
        if (Array.isArray(entity.arxiv_refs)) entity.arxiv_refs.forEach(r => inject(`arxiv--${r}`, 'paper', 'CITES'));
    }

    // 3. Final SSOT Validation: Ensure all knowledge nodes have corresponding R2 articles
    const validKnowledgeSlugs = new Set(knowledgeIndex.map((a) => a.slug));

    tiers.explanation.nodes = tiers.explanation.nodes.filter(node => {
        if (node.type !== 'knowledge') return true;
        // The slug is the last part of the norm (e.g., knowledge--rag -> rag)
        const slug = node.norm.split('--').pop();
        const exists = validKnowledgeSlugs.has(slug);

        if (!exists) {
            console.warn(`[MeshOrchestrator] Filtering ghost knowledge node: ${node.id}`);
            node.isGhost = true; // Mark as ghost for UI handling if needed
        }
        return exists; // Strictly remove from the Tiered Hub if not in R2 Index
    });

    return { tiers, nodeRegistry };
}
