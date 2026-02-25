import { getTypeFromId, stripPrefix, KNOWLEDGE_ALIAS_MAP } from './knowledge-cache-reader.js';

/**
 * Pure Logic: Process raw relations into tiers
 * Extracted from mesh-orchestrator.js to comply with CES file size limits.
 */
export function processRelationsIntoTiers(rawRelations, nodeRegistry, seenIds, graphMeta, tiers, normRoot, isValidNode = () => true) {
    const processedRelations = [];
    const UNIVERSAL_ICONS = {
        'model': '🧠', 'agent': '🤖', 'tool': '⚙️', 'dataset': '📊',
        'paper': '📄', 'space': '🚀', 'knowledge': '🎓', 'report': '📰'
    };

    const ensureNode = (id, typeHint = 'model', optionalMeta = {}) => {
        if (!id || typeof id !== 'string') return null;

        // V16.9 Integrity Guard: Block nodes that would 404
        if (!isValidNode(id)) {
            return null;
        }

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

        // V16.8.8: Passthrough rich metadata from relation itself
        let node = ensureNode(neighborId, rel.target_type || rel.source_type, rel);
        if (!node) return;

        seenIds.add(normNeighbor);

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

/**
 * V22.8: Inject Structural Relations
 * Extracted from mesh-orchestrator.js to restore CES compliance.
 */
export function injectStructuralRelations(entity, { nodeRegistry, seenIds, tiers, normRoot, isNodeValid, ensureNode, filteredRelations }) {
    if (!entity) return;

    if (entity.base_model && typeof entity.base_model === 'string') {
        const id = entity.base_model.includes('--') ? entity.base_model : `hf-model--${entity.base_model.replace(/\//g, '--')}`;
        const norm = stripPrefix(id);
        if (norm !== normRoot && !seenIds.has(norm)) {
            seenIds.add(norm);
            let node = ensureNode(id, 'model');
            if (node) {
                node.relation = 'BASED_ON';
                if (!node._mapped) {
                    node._mapped = true;
                    tiers.core.nodes.push(node);
                    filteredRelations.push({ target_id: id, target_type: 'model', target_name: node.name, relation_type: 'BASED_ON', confidence: 1.0 });
                }
            }
        }
    }

    if (Array.isArray(entity.datasets_used)) {
        entity.datasets_used.forEach(ds => {
            if (!ds || typeof ds !== 'string') return;
            const id = ds.includes('--') ? ds : `hf-dataset--${ds.replace(/\//g, '--')}`;
            const norm = stripPrefix(id);
            if (norm !== normRoot && !seenIds.has(norm)) {
                seenIds.add(norm);
                let node = ensureNode(id, 'dataset');
                if (node) {
                    node.relation = 'TRAINED_ON';
                    if (!node._mapped) {
                        node._mapped = true;
                        tiers.utility.nodes.push(node);
                        filteredRelations.push({ target_id: id, target_type: 'dataset', target_name: node.name, relation_type: 'TRAINED_ON', confidence: 0.9 });
                    }
                }
            }
        });
    }

    if (Array.isArray(entity.arxiv_refs)) {
        entity.arxiv_refs.forEach(r => {
            if (!r) return;
            const id = `arxiv--${r}`;
            const norm = stripPrefix(id);
            if (norm === normRoot || seenIds.has(norm)) return;
            seenIds.add(norm);

            let node = ensureNode(id, 'paper');
            if (node) {
                node.relation = 'CITES';
                if (!node._mapped) {
                    node._mapped = true;
                    tiers.utility.nodes.push(node);
                    filteredRelations.push({ target_id: id, target_type: 'paper', target_name: node.name, relation_type: 'CITES', confidence: 1.0 });
                }
            }
        });
    }

    if (Array.isArray(entity.relations)) {
        entity.relations.forEach(r => {
            const tid = r.target_id;
            if (!tid) return;
            const norm = stripPrefix(tid);
            if (norm === normRoot || seenIds.has(norm)) return;
            seenIds.add(norm);

            let node = ensureNode(tid, r.target_type || getTypeFromId(tid));
            if (!node) return;

            let relType = (r.relation_type || r.type || 'RELATED').toUpperCase();
            if (relType === 'HAS_CODE' || relType === 'CODEBASE') relType = 'STACK';

            node.relation = relType;
            if (!node._mapped) {
                node._mapped = true;
                if (node.type === 'knowledge') tiers.explanation.nodes.push(node);
                else if (['model', 'agent', 'tool', 'space'].includes(node.type)) tiers.core.nodes.push(node);
                else if (['dataset', 'paper'].includes(node.type)) tiers.utility.nodes.push(node);
                else if (node.type === 'report') tiers.digest.nodes.push(node);

                filteredRelations.push({
                    target_id: tid,
                    target_type: node.type,
                    target_name: node.name,
                    relation_type: relType,
                    confidence: r.confidence || 1.0
                });
            }
        });
    }
}

/**
 * V22.8: Inject Category Similarity
 * Extracted from mesh-orchestrator.js to restore CES compliance.
 */
export function injectCategoryAlts(categoryAlts, rootId, { nodeRegistry, seenIds, tiers, normRoot, ensureNode, filteredRelations, isMatch }) {
    if (!Array.isArray(categoryAlts)) return;

    const myAltsRecord = categoryAlts.find(r => isMatch(r.source_id, rootId));
    if (myAltsRecord && Array.isArray(myAltsRecord.alts)) {
        myAltsRecord.alts.forEach(([tid, score]) => {
            const norm = stripPrefix(tid);
            if (norm === normRoot || seenIds.has(norm)) return;

            let node = ensureNode(tid, getTypeFromId(tid));
            if (!node) return;

            seenIds.add(norm);
            node.relation = 'ALTERNATIVE';
            node.match_score = score;

            if (!node._mapped) {
                node._mapped = true;
                if (['model', 'agent', 'tool', 'space'].includes(node.type)) tiers.core.nodes.push(node);
                else if (['dataset', 'paper'].includes(node.type)) tiers.utility.nodes.push(node);

                filteredRelations.push({
                    target_id: tid,
                    target_type: node.type,
                    target_name: node.name,
                    relation_type: 'ALTERNATIVE',
                    confidence: score / 100
                });
            }
        });
    }
}
