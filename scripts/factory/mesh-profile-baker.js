/**
 * Knowledge Mesh Profile Baker V16.5.1
 * job: Creates atomized, URL-injected mesh profiles for each entity.
 */

import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource, ALL_PREFIXES } from '../utils/id-normalizer.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';
import { getRouteFromId, getTypeFromId } from '../../src/utils/mesh-routing-core.js';

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

        console.log(`[BAKER] Loaded ${nodeIds.length} nodes from graph.`);

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

            const bakedRelations = entityRelations.map(rel => {
                // V27.94 (A.2): Rust emits array-form edges [target_id, type, conf]
                // (relations-generator.js addEdge). Reading rel.target/.type as object
                // keys on an array yielded undefined -> degenerate {type:'model',icon}.
                const isArr = Array.isArray(rel);
                const targetIdRaw = isArr ? rel[0] : (rel.target || rel.target_id || rel.id);
                const relType = isArr ? rel[1] : (rel.type || rel.t);
                // array-form conf is 0-100 (addEdge Math.round(conf*100)); normalize to
                // 0-1 to match object/source convention (frontend tests rel.confidence>0.8).
                const conf = isArr ? (rel[2] != null ? rel[2] / 100 : undefined) : rel.confidence;
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
                const objExtras = isArr ? {} : rel;
                return {
                    ...objExtras, url: bakedUrl,
                    relation_type: relType || (isArr ? undefined : rel.relation_type),
                    confidence: conf != null ? conf : (isArr ? undefined : rel.confidence),
                    target_id: syncedTargetId || targetIdRaw,
                    target_name: (isArr ? undefined : (rel.name || rel.target_name)) || nameNode.name || nameNode.displayName || (syncedTargetId ? syncedTargetId.split('--').pop() : 'Unknown'),
                    icon: (isArr ? undefined : rel.icon) || nameNode.icon || '📦'
                };
            });

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
        if (skippedInvalid > 0) console.warn(`[BAKER] ⚠️ Skipped ${skippedInvalid} nodes with invalid IDs`);
        console.log(`[BAKER] ✅ ${bakedCount} profiles → ${shardIndex} shards (${SHARD_SIZE}/shard).`);
    } catch (error) {
        console.error('[BAKER] ❌ Baking failed:', error.message);
        process.exit(1);
    }
}

main();
