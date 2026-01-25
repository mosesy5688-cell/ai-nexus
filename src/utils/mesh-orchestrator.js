/**
 * Mesh Orchestrator (V16.11) - Compliance Optimized
 * Centralizes node extraction, tiering, and deduplication.
 * V16.11: Restricted to R2 Source only. No dynamic tag promotion.
 */
import { fetchMeshRelations, fetchGraphMetadata, fetchConceptMetadata, stripPrefix, isMatch, getTypeFromId, normalizeSlug } from './knowledge-cache-reader.js';
import { articles as KNOWLEDGE_REGISTRY } from '../data/knowledge-articles';

export async function getMeshProfile(locals, rootId, entity, type = 'model') {
    const normRoot = stripPrefix(rootId);

    // V16.12: Fetch all relevant indices for cross-validation
    const [rawRelations, graphMeta, knowledgeIndex, specsResult] = await Promise.all([
        fetchMeshRelations(locals, rootId, { ssrOnly: true }).catch(() => []),
        fetchGraphMetadata(locals).catch(() => ({})),
        fetchConceptMetadata(locals).catch(() => ([])),
        locals?.runtime?.env?.R2_ASSETS?.get('cache/specs.json').then(async (f) => f ? await f.json() : null).catch(() => null)
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

    // V16.14: Multi-Source Knowledge SSOT (Normalized)
    const validKnowledgeSlugs = new Set([
        ...Object.keys(KNOWLEDGE_REGISTRY),
        ...(knowledgeIndex.articles || knowledgeIndex || []).map(a => a.slug || a.id?.split('--')?.pop())
    ].filter(Boolean).map(s => stripPrefix(s)));

    // Model validation index (normalized for easy matching)
    const validSpecIds = new Set();
    if (specsResult && Array.isArray(specsResult.data)) {
        specsResult.data.forEach(s => {
            if (s.umid) validSpecIds.add(stripPrefix(s.umid));
            if (s.id) validSpecIds.add(stripPrefix(s.id));
        });
    }

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

    // 1. Process Relations
    const filteredRelations = [];
    rawRelations.forEach(rel => {
        const neighborId = isMatch(rel.norm_source, normRoot) ? rel.target_id : rel.source_id;
        const normNeighbor = stripPrefix(neighborId);
        if (normNeighbor === normRoot || seenIds.has(normNeighbor)) return;

        // V16.14: Strict SSOT Filter before processing
        const nType = getTypeFromId(neighborId);
        if (nType === 'knowledge') {
            const rawSlug = normNeighbor.split('--').pop();
            const slug = stripPrefix(rawSlug); // Canonical normalization check
            if (!validKnowledgeSlugs.has(slug)) return;
        }

        seenIds.add(normNeighbor);

        let node = ensureNode(neighborId, rel.target_type || rel.source_type);
        if (!node.relation || node.relation === 'RELATED') node.relation = (rel.relation_type || 'RELATED').toUpperCase();

        if (!node._mapped) {
            node._mapped = true;
            if (node.type === 'knowledge') tiers.explanation.nodes.push(node);
            else if (['model', 'agent', 'tool', 'space'].includes(node.type)) tiers.core.nodes.push(node);
            else if (['dataset', 'paper', 'report'].includes(node.type)) tiers.utility.nodes.push(node);

            // Track as a valid relation for the Matrix
            filteredRelations.push({
                ...rel,
                target_id: neighborId,
                target_type: nType,
                target_name: node.name
            });
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

        if (Array.isArray(entity.arxiv_refs)) entity.arxiv_refs.forEach(r => inject(`arxiv--${r}`, 'paper', 'CITES'));

        // V16.22: Legendary Entity Heuristic Injection (Ensure Mesh Visibility)
        const isLegendary = (entity.fni_score || 0) >= 80 || (entity.params_billions || 0) >= 70;
        if (isLegendary && filteredRelations.length === 0) {
            // If no relations found, inject author and base tech as "Ecosystem Nodes"
            if (entity.author && entity.author !== 'Unknown') {
                inject(`author--${normalizeSlug(entity.author)}`, 'knowledge', 'DEVELOPED BY');
            }
            if (type === 'model') {
                inject(`knowledge--large-language-model`, 'knowledge', 'FIELD');
                inject(`knowledge--transformer`, 'knowledge', 'ARCHITECTURE');
            } else if (type === 'paper') {
                inject(`knowledge--artificial-intelligence`, 'knowledge', 'FIELD');
                inject(`knowledge--research`, 'knowledge', 'TYPE');
            } else if (type === 'dataset') {
                inject(`knowledge--machine-learning-dataset`, 'knowledge', 'TYPE');
                inject(`knowledge--training-data`, 'knowledge', 'USAGE');
            } else if (type === 'agent' || type === 'tool' || type === 'space') {
                inject(`knowledge--ai-infrastructure`, 'knowledge', 'DOMAIN');
                inject(`knowledge--open-source`, 'knowledge', 'DELIVERY');
            }
        }
    }

    return { tiers, nodeRegistry, filteredRelations };
}
