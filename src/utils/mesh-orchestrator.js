/**
 * Mesh Orchestrator (V16.11) - Compliance Optimized
 * Centralizes node extraction, tiering, and deduplication.
 * V16.11: Restricted to R2 Source only. No dynamic tag promotion.
 */
import { fetchMeshRelations, fetchGraphMetadata, fetchConceptMetadata, stripPrefix, isMatch, getTypeFromId, normalizeSlug, KNOWLEDGE_ALIAS_MAP } from './knowledge-cache-reader.js';
import { articles as knowledgeArticles } from '../data/knowledge-articles.js';

export async function getMeshProfile(locals, rootId, entity, type = 'model') {
    const normRoot = stripPrefix(rootId);

    // V16.12: Fetch all relevant indices for cross-validation
    const [rawRelations, graphMeta, knowledgeIndex, specsResult, meshStats] = await Promise.all([
        fetchMeshRelations(locals, rootId, { ssrOnly: true }).catch(() => []),
        fetchGraphMetadata(locals).catch(() => ({})),
        fetchConceptMetadata(locals).catch(() => ([])),
        locals?.runtime?.env?.R2_ASSETS?.get('cache/specs.json').then(async (f) => f ? await f.json() : null).catch(() => null),
        locals?.runtime?.env?.R2_ASSETS?.get('cache/mesh/stats.json').then(async (f) => f ? await f.json() : null).catch(() => null)
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
        ...Object.keys(knowledgeArticles),
        ...(Array.isArray(knowledgeIndex) ? knowledgeIndex : (knowledgeIndex?.articles || [])).map(a => a.slug || a.id?.split('--')?.pop())
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
        let norm = stripPrefix(id);
        if (nodeRegistry.has(norm)) return nodeRegistry.get(norm);

        const meta = graphMeta[id] || {};
        // V16.50: Strict metadata trust. If R2 specifies a type 't', use it.
        let nodeType = meta.t || typeHint || getTypeFromId(id);

        // V16.70: Apply Knowledge Aliasing
        if (nodeType === 'knowledge' && KNOWLEDGE_ALIAS_MAP[norm]) {
            norm = KNOWLEDGE_ALIAS_MAP[norm];
            id = `knowledge--${norm}`;
        }

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

    // 1. Process Relations (Strict Aggregate from R2)
    const filteredRelations = [];
    rawRelations.forEach(rel => {
        const neighborId = isMatch(rel.norm_source, normRoot) ? rel.target_id : rel.source_id;
        const normNeighbor = stripPrefix(neighborId);
        if (normNeighbor === normRoot || seenIds.has(normNeighbor)) return;

        seenIds.add(normNeighbor);

        let node = ensureNode(neighborId, rel.target_type || rel.source_type);
        const relType = (rel.relation_type || 'RELATED').toUpperCase();
        node.relation = relType;

        if (!node._mapped) {
            node._mapped = true;
            // 4-Tier Magnetic Alignment
            if (node.type === 'knowledge') tiers.explanation.nodes.push(node);
            else if (['model', 'agent', 'tool', 'space'].includes(node.type)) tiers.core.nodes.push(node);
            else if (['dataset', 'paper'].includes(node.type)) tiers.utility.nodes.push(node);
            else if (node.type === 'report') tiers.digest.nodes.push(node);

            filteredRelations.push({
                ...rel,
                target_id: neighborId,
                target_type: node.type,
                target_name: node.name
            });
        }
    });

    // 2. High-Confidence Structural Injections (ArXiv & Explicit Relations)
    if (entity) {
        if (entity.base_model) {
            const id = entity.base_model.includes('--') ? entity.base_model : `hf-model--${entity.base_model.replace(/\//g, '--')}`;
            const norm = stripPrefix(id);
            if (norm !== normRoot && !seenIds.has(norm)) {
                seenIds.add(norm);
                let node = ensureNode(id, 'model');
                node.relation = 'BASED_ON';
                if (!node._mapped) {
                    node._mapped = true;
                    tiers.core.nodes.push(node);
                    filteredRelations.push({ target_id: id, target_type: 'model', target_name: node.name, relation_type: 'BASED_ON', confidence: 1.0 });
                }
            }
        }

        if (Array.isArray(entity.datasets_used)) {
            entity.datasets_used.forEach(ds => {
                const id = ds.includes('--') ? ds : `hf-dataset--${ds.replace(/\//g, '--')}`;
                const norm = stripPrefix(id);
                if (norm !== normRoot && !seenIds.has(norm)) {
                    seenIds.add(norm);
                    let node = ensureNode(id, 'dataset');
                    node.relation = 'TRAINED_ON';
                    if (!node._mapped) {
                        node._mapped = true;
                        tiers.utility.nodes.push(node);
                        filteredRelations.push({ target_id: id, target_type: 'dataset', target_name: node.name, relation_type: 'TRAINED_ON', confidence: 0.9 });
                    }
                }
            });
        }

        if (Array.isArray(entity.arxiv_refs)) {
            entity.arxiv_refs.forEach(r => {
                const id = `arxiv--${r}`;
                const norm = stripPrefix(id);
                if (norm === normRoot || seenIds.has(norm)) return;
                seenIds.add(norm);

                let node = ensureNode(id, 'paper');
                node.relation = 'CITES';
                if (!node._mapped) {
                    node._mapped = true;
                    tiers.utility.nodes.push(node);
                    filteredRelations.push({ target_id: id, target_type: 'paper', target_name: node.name, relation_type: 'CITES', confidence: 1.0 });
                }
            });
        }

        if (Array.isArray(entity.relations)) {
            entity.relations.forEach(r => {
                const tid = r.target_id;
                if (!tid) return; // Null safety for ghost relations
                const norm = stripPrefix(tid);
                if (norm === normRoot || seenIds.has(norm)) return;
                seenIds.add(norm);

                let node = ensureNode(tid, r.target_type || getTypeFromId(tid));
                let relType = (r.relation_type || r.type || 'RELATED').toUpperCase();

                // Semantic Normalization
                if (relType === 'HAS_CODE' || relType === 'CODEBASE') relType = 'STACK';

                node.relation = relType;
                if (!node._mapped) {
                    node._mapped = true;
                    // 4-Tier Magnetic Alignment
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

    return { tiers, nodeRegistry, filteredRelations };
}
