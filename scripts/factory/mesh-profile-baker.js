/**
 * Knowledge Mesh Profile Baker V16.5.1
 * job: Creates atomized, URL-injected mesh profiles for each entity.
 */

import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource, ALL_PREFIXES } from '../utils/id-normalizer.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';
import { getRouteFromId, getTypeFromId } from '../../src/utils/mesh-routing-core.js';
import { buildInverseAdjacency, projectReverseEdges } from './lib/reverse-edge-projector.js';
import { newEvidenceDict, structuralSentinel } from './lib/evidence-carrier.js';

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const GRAPH_PATH = path.join(CACHE_DIR, 'mesh/graph.json.zst');

// URL routing mapping
const TYPE_TO_ROUTE = {
    'model': '/model',
    'agent': '/agent',
    'dataset': '/dataset',
    'paper': '/paper',
    'space': '/space',
    'tool': '/tool',
    'prompt': '/prompt'
};

async function main() {
    console.log('[BAKER V22.0] Baking atomized Mesh Profiles (ID Sync Level)...');

    try {
        const { autoDecompress } = await import('./lib/zstd-helper.js');
        let graphBuffer = await fs.readFile(GRAPH_PATH);
        graphBuffer = await autoDecompress(graphBuffer);

        const graph = JSON.parse(graphBuffer.toString('utf-8'));
        const nodeRegistry = graph.nodes || {};
        const edgeRegistry = graph.edges || {};
        const nodeIds = Object.keys(nodeRegistry);
        // D0a: carry the graph evidence_dict THROUGH to ui_related_mesh (each shard
        // re-emits it so the per-entity sink is self-contained for the canary +
        // serve). Reverse edges get a MINIMAL sentinel ref (full reverse-references-
        // forward-edge is PR-D0b). ed.dict is seeded from graph.evidence_dict.
        const ed = newEvidenceDict(graph.evidence_dict);
        // One sentinel ref reused for every reverse edge this bake mints (D0a: the
        // reversed fact's MINIMAL trail; D0b upgrades to reference the forward edge_id).
        const reverseRef = ed.add(structuralSentinel('reverse_edge_projector', 'inverse_adjacency', 'reverse_of'));

        console.log(`[BAKER] Loaded ${nodeIds.length} nodes from graph.`);

        // PR-2 reverse-edge projection: build the inverse adjacency ONCE (O(E))
        // from the outgoing edge registry. inEdges[targetId] = [[sourceId, verb]],
        // so a paper/benchmark can later emit the INBOUND view (CITED_BY /
        // EVALUATED_BY / DEFINES) of edges that already exist one-directionally.
        // No new facts: every reversed edge is a real outgoing edge seen from the
        // other endpoint. Skip at 100M scale -> needs a streamed pass (not here).
        const inEdges = buildInverseAdjacency(edgeRegistry);
        let reverseCount = 0;

        const SHARD_SIZE = 1000;
        const shardDir = path.join(CACHE_DIR, 'mesh', 'profile-shards');
        await fs.mkdir(shardDir, { recursive: true });

        let bakedCount = 0, skippedInvalid = 0, shardIndex = 0;
        let shardBuffer = [];

        const flushShard = async () => {
            if (shardBuffer.length === 0) return;
            const { zstdCompress } = await import('./lib/zstd-helper.js');
            const jsonl = shardBuffer.map(p => JSON.stringify(p)).join('\n');
            const compressed = await zstdCompress(jsonl);
            const shardFile = path.join(shardDir, `shard-${String(shardIndex).padStart(4, '0')}.jsonl.zst`);
            await fs.writeFile(shardFile, compressed);
            shardIndex++;
            shardBuffer = [];
        };

        for (let nodeId of nodeIds) {
            const node = nodeRegistry[nodeId];
            if (!node) continue;
            const typeValue = node.type || node.t || 'model';
            const syncedId = normalizeId(nodeId, getNodeSource(nodeId, typeValue), typeValue);
            if (!syncedId) { skippedInvalid++; continue; }

            const entityRelations = edgeRegistry[nodeId] || [];
            const canonUrl = getRouteFromId(syncedId, typeValue);

            // bakeEdge: resolve ONE edge (target_id + verb + conf) to the baked
            // relation shape (synced id, route url, name, icon). Shared by the
            // OUTGOING edges below and the PR-2 reverse projection so a reversed
            // edge is shaped identically (and resolve-filtered identically by the
            // downstream distiller resolveMeshEdge against entity_lookup).
            const bakeEdge = (targetIdRaw, relType, conf, objExtras = {}, srcTrail = [], eid = '') => {
                // BUGFIX: relType is the relation VERB (BASED_ON/TRAINED_ON/CITES/USES),
                // NOT the target's entity TYPE. Passing the verb to getNodeSource/
                // normalizeId/getRouteFromId made every non-model target route to
                // /model/<slug> (DEAD LINK: TRAINED_ON->dataset, CITES->paper, ...) and
                // corrupted the normalizeId prefix. Derive the real target TYPE from the
                // node registry (authoritative), falling back to the id prefix.
                const registryNode = nodeRegistry[targetIdRaw] || {};
                const targetType = (registryNode.t || registryNode.type
                    || getTypeFromId(targetIdRaw) || 'model').toLowerCase();
                const syncedTargetId = normalizeId(targetIdRaw, getNodeSource(targetIdRaw, targetType), targetType);
                const bakedUrl = getRouteFromId(syncedTargetId, targetType);
                // name/icon may live under the synced id key (preserve prior fallback).
                const nameNode = (registryNode.name || registryNode.displayName || registryNode.icon)
                    ? registryNode : (nodeRegistry[syncedTargetId] || registryNode);
                return {
                    ...objExtras, url: bakedUrl,
                    // D0a carrier: forward the COMPACT source_trail refs + edge_id
                    // onto the baked relation (reaches ui_related_mesh + serve).
                    source_trail: srcTrail || [],
                    edge_id: eid || '',
                    relation_type: relType,
                    // PR reverse-edge-target-type: emit the real target entity TYPE
                    // (model/paper/dataset/benchmark/concept) alongside the verb.
                    // Without it the distiller defaulted every baked/reverse-projected
                    // edge to 'model', re-canonicalizing knowledge/concept|paper|dataset|
                    // benchmark targets as hf-model-- (#2158 canary: 19 concept stubs +
                    // silent drop of non-model reverse targets on lookup-miss).
                    target_type: targetType,
                    confidence: conf,
                    target_id: syncedTargetId || targetIdRaw,
                    target_name: objExtras.name || objExtras.target_name || nameNode.name || nameNode.displayName || (syncedTargetId ? syncedTargetId.split('--').pop() : 'Unknown'),
                    icon: objExtras.icon || nameNode.icon || '📦'
                };
            };

            const bakedRelations = entityRelations.map(rel => {
                // V27.94 (A.2): Rust emits array-form edges [target_id, type, conf]
                // (relations-generator.js addEdge). Reading rel.target/.type as object
                // keys on an array yielded undefined -> degenerate {type:'model',icon}.
                const isArr = Array.isArray(rel);
                const targetIdRaw = isArr ? rel[0] : (rel.target || rel.target_id || rel.id);
                const relType = (isArr ? rel[1] : (rel.type || rel.t)) || (isArr ? undefined : rel.relation_type);
                // array-form conf is 0-100 (addEdge Math.round(conf*100)); normalize to
                // 0-1 to match object/source convention (frontend tests rel.confidence>0.8).
                const conf = isArr ? (rel[2] != null ? rel[2] / 100 : undefined) : rel.confidence;
                // D0a: read the carrier from slot[3]/[4] (array) or .source_trail/.edge_id (object).
                const srcTrail = isArr ? (rel[3] || []) : (rel.source_trail || []);
                const eid = isArr ? (rel[4] || '') : (rel.edge_id || '');
                return bakeEdge(targetIdRaw, relType, conf, isArr ? {} : rel, srcTrail, eid);
            });

            // PR-2: merge the INBOUND (reversed-verb) view of edges that already
            // exist one-directionally. A paper an HF model CITES gains CITED_BY;
            // a benchmark a model is EVALUATED_ON gains EVALUATED_BY; a benchmark's
            // defining paper gains DEFINES. Deduped by (target_id, relation_type)
            // against existing outgoing edges so bidirectional facts aren't doubled.
            const reverseRelations = projectReverseEdges(
                inEdges[nodeId], typeValue, bakedRelations,
                // D0a: reverse edges carry a MINIMAL sentinel ref (reverse_of). D0b
                // upgrades this to reference the FORWARD edge_id (no new bare fact).
                (sourceId, verb) => bakeEdge(sourceId, verb, 1.0, {}, [reverseRef], ''));
            for (const rr of reverseRelations) bakedRelations.push(rr);
            reverseCount += reverseRelations.length;

            shardBuffer.push({
                id: syncedId,
                name: node.name || node.displayName || syncedId.split('--').pop(),
                type: typeValue, url: canonUrl, icon: node.icon || '📦',
                relations: bakedRelations,
                _generated_at: new Date().toISOString(), _version: '22.0.0-synced-baker'
            });

            bakedCount++;
            if (shardBuffer.length >= SHARD_SIZE) await flushShard();
            if (bakedCount % 50000 === 0) console.log(`[BAKER] Baked ${bakedCount} profiles (${shardIndex} shards)...`);
        }
        await flushShard();
        // D0a: emit the baked evidence_dict sidecar (graph dict + the reverse
        // sentinel the baker appended) so the ui_related_mesh WARN canary can
        // resolve every served ref against ONE dictionary. site_metadata.mesh_graph
        // still carries graph.evidence_dict for the graph-blob sink.
        const { zstdCompress } = await import('./lib/zstd-helper.js');
        await fs.writeFile(path.join(CACHE_DIR, 'mesh', 'profile-evidence-dict.json.zst'),
            await zstdCompress(JSON.stringify(ed.dict)));
        if (skippedInvalid > 0) console.warn(`[BAKER] ⚠️ Skipped ${skippedInvalid} nodes with invalid IDs`);
        console.log(`[BAKER] ✅ ${bakedCount} profiles → ${shardIndex} shards (${SHARD_SIZE}/shard); ${reverseCount} reverse-projected inbound edges.`);
    } catch (error) {
        console.error('[BAKER] ❌ Baking failed:', error.message);
        process.exit(1);
    }
}

main();
