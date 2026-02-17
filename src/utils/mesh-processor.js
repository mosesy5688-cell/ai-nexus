import { getTypeFromId, stripPrefix, KNOWLEDGE_ALIAS_MAP } from './knowledge-cache-reader.js';

/**
 * Pure Logic: Process raw relations into tiers
 * Extracted from mesh-orchestrator.js to comply with CES file size limits.
 */
export function processRelationsIntoTiers(rawRelations, nodeRegistry, seenIds, graphMeta, tiers, normRoot) {
    const processedRelations = [];
    const UNIVERSAL_ICONS = {
        'model': '🧠', 'agent': '🤖', 'tool': '⚙️', 'dataset': '📊',
        'paper': '📄', 'space': '🚀', 'knowledge': '🎓', 'report': '📰'
    };

    const ensureNode = (id, typeHint = 'model', optionalMeta = {}) => {
        if (!id || typeof id !== 'string') return null;
        let norm = stripPrefix(id);
        if (nodeRegistry.has(norm)) return nodeRegistry.get(norm);

        const meta = graphMeta[id] || optionalMeta || {};
        const idDerived = getTypeFromId(id);
        let nodeType = (id.includes('--')) ? idDerived : (meta.t || typeHint || idDerived);

        if (nodeType === 'knowledge' && KNOWLEDGE_ALIAS_MAP[norm]) {
            norm = KNOWLEDGE_ALIAS_MAP[norm];
            id = `knowledge--${norm}`;
        }

        const parts = id.split('--');
        const nodeAuthor = meta.author || (parts.length > 2 ? parts[parts.length - 2].replace(/-/g, ' ') : (id.startsWith('arxiv--') ? 'Research Paper' : 'Ecosystem Node'));

        // V16.8.8: High-Fidelity naming from mesh stream data
        const node = {
            id, norm,
            name: meta.n || meta.target_name || id.split('--').pop()?.replace(/-/g, ' ')?.toUpperCase() || 'UNKNOWN',
            type: nodeType,
            icon: meta.icon || meta.target_icon || UNIVERSAL_ICONS[nodeType] || '📦',
            author: nodeAuthor,
            relation: '',
            _mapped: false
        };
        nodeRegistry.set(norm, node);
        return node;
    };

    if (Array.isArray(rawRelations)) rawRelations.forEach(rel => {
        if (!rel) return;

        let neighborId = rel.target_id;

        // If undirected/raw edge, determine neighbor relative to root
        if (!neighborId || (rel.source_id && !rel.target_id) || (rel.source_id && rel.target_id)) {
            // If implicit source/target, resolve direction
            if (normRoot && rel.norm_source) {
                neighborId = (rel.norm_source === normRoot) ? rel.target_id : rel.source_id;
            }
        }

        if (!neighborId) return;

        const normNeighbor = stripPrefix(neighborId);
        if (normRoot && (normNeighbor === normRoot || seenIds.has(normNeighbor))) return;

        seenIds.add(normNeighbor);

        // V16.8.8: Passthrough rich metadata from relation itself
        let node = ensureNode(neighborId, rel.target_type || rel.source_type, rel);
        if (!node) return;

        const relType = (rel.relation_type || 'RELATED').toUpperCase();
        node.relation = relType;

        if (!node._mapped) {
            node._mapped = true;
            // 4-Tier Magnetic Alignment
            if (node.type === 'knowledge') tiers.explanation.nodes.push(node);
            else if (['model', 'agent', 'tool', 'space'].includes(node.type)) tiers.core.nodes.push(node);
            else if (['dataset', 'paper'].includes(node.type)) tiers.utility.nodes.push(node);
            else if (node.type === 'report') tiers.digest.nodes.push(node);

            processedRelations.push({
                target_id: neighborId,
                target_type: node.type,
                target_name: node.name,
                relation_type: relType,
                confidence: rel.confidence || 1.0
            });
        }
    });

    return { tiers, processedRelations, nodeRegistry };
}
