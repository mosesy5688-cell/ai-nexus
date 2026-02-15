import { fetchMeshRelations, fetchGraphMetadata, fetchConceptMetadata, fetchCategoryAlts, stripPrefix, isMatch, getTypeFromId, normalizeSlug, KNOWLEDGE_ALIAS_MAP } from './knowledge-cache-reader.js';
import { processRelationsIntoTiers } from './mesh-processor.js';
import { loadCachedJSON, loadSpecs } from './loadCachedJSON.js';
import { articles as knowledgeArticles } from '../data/knowledge-articles.js';
import { UNIVERSAL_ICONS, DEFAULT_TIERS } from './mesh-constants.js';

export async function getMeshProfile(locals, rootId, entity, type = 'model') {
    const normRoot = stripPrefix(rootId);

    // V18.2.5: SSR Lite Protection
    const isSSR = Boolean(locals?.runtime?.env);

    // V18.12.0: Resolve category for alt-discovery
    const category = entity?.primary_category || entity?.pipeline_tag || '';

    // V16.12: Fetch all relevant indices for cross-validation
    const [rawRelations, graphMeta, knowledgeIndex, specsResult, meshStatsResult, categoryAlts] = await Promise.all([
        fetchMeshRelations(locals, rootId, { ssrOnly: true }).catch(() => []),
        fetchGraphMetadata(locals).catch(() => ({})),
        fetchConceptMetadata(locals).catch(() => ([])),
        isSSR ? Promise.resolve(null) : loadSpecs(locals).catch(() => null),
        isSSR ? Promise.resolve(null) : loadCachedJSON('cache/mesh/stats.json', { locals }).catch(() => null),
        category ? fetchCategoryAlts(locals, category).catch(() => []) : Promise.resolve([])
    ]);

    const nodeRegistry = new Map();
    const seenIds = new Set();
    if (normRoot) seenIds.add(normRoot);

    // Deep clone tiers to prevent reference leaks
    const tiers = JSON.parse(JSON.stringify(DEFAULT_TIERS));

    // V16.14: Multi-Source Knowledge SSOT
    const validKnowledgeSlugs = new Set([
        ...Object.keys(knowledgeArticles),
        ...(Array.isArray(knowledgeIndex) ? knowledgeIndex : (knowledgeIndex?.articles || [])).map(a => a?.slug || a?.id?.split('--')?.pop())
    ].filter(Boolean).map(s => stripPrefix(s)));


    // V18.12.0: Integrity Guard - Pre-check candidates for existence
    const validIds = new Set(Object.keys(graphMeta));
    if (specsResult?.data) specsResult.data.forEach(s => {
        if (s.id) validIds.add(s.id);
        if (s.umid) validIds.add(s.umid);
    });

    const isNodeValid = (id) => {
        if (!id) return false;
        // TRUST internal routing for core site features
        if (id.startsWith('knowledge--') || id.startsWith('report--')) return true;

        // V18.12.0: Repair - Relaxed filtering for local development or empty index
        // If we have very few nodes in the index, it's likely a fragmented local clone
        if (validIds.size < 50) return true; // Fail-open to allow mesh exploration manually

        return validIds.has(id) || validIds.has(stripPrefix(id));
    };

    const ensureNode = (id, typeHint = 'model') => {
        if (!id || typeof id !== 'string') return null;

        // Zero 404 Guard: Filter out unregistered external nodes
        if (!isNodeValid(id)) {
            console.warn(`[IntegrityGuard] Dropped node ${id} to prevent 404`);
            return null;
        }

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
    const { tiers: processedTiers, processedRelations, nodeRegistry: registry } = processRelationsIntoTiers(rawRelations, nodeRegistry, seenIds, graphMeta, tiers, normRoot);

    // Merge back
    Object.assign(tiers, processedTiers);
    const filteredRelations = [];
    processedRelations.forEach(r => filteredRelations.push(r));
    // Registry updated by reference, but ensuring sync

    // 2. High-Confidence Structural Injections (ArXiv & Explicit Relations)
    if (entity) {
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
                if (!tid) return; // Null safety for ghost relations
                const norm = stripPrefix(tid);
                if (norm === normRoot || seenIds.has(norm)) return;
                seenIds.add(norm);

                let node = ensureNode(tid, r.target_type || getTypeFromId(tid));
                if (!node) return; // Dropped by IntegrityGuard

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

        // V18.12.0: Inject Category Alts (Smart Similarity)
        if (Array.isArray(categoryAlts)) {
            // Find relations for "this" entity
            const myAltsRecord = categoryAlts.find(r => isMatch(r.source_id, rootId));
            if (myAltsRecord && Array.isArray(myAltsRecord.alts)) {
                myAltsRecord.alts.forEach(([tid, score]) => {
                    const norm = stripPrefix(tid);
                    if (norm === normRoot || seenIds.has(norm)) return;

                    let node = ensureNode(tid, getTypeFromId(tid));
                    if (!node) return; // Dropped by IntegrityGuard

                    seenIds.add(norm);
                    node.relation = 'ALTERNATIVE';
                    node.match_score = score; // Transparency: Attach match %

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
    }

    return { tiers, nodeRegistry, filteredRelations };
}

// Logic extracted to mesh-processor.js
