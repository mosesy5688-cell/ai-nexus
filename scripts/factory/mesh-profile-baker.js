/**
 * Knowledge Mesh Profile Baker V16.5.1
 * job: Creates atomized, URL-injected mesh profiles for each entity.
 */

import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource, ALL_PREFIXES } from '../utils/id-normalizer.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';
import { getRouteFromId } from '../../src/utils/mesh-routing-core.js';

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const GRAPH_PATH = path.join(CACHE_DIR, 'mesh/graph.json.gz');

// URL routing mapping
const TYPE_TO_ROUTE = {
    'model': '/model',
    'agent': '/agent',
    'dataset': '/dataset',
    'paper': '/paper',
    'space': '/space',
    'tool': '/tool'
};



async function main() {
    console.log('[BAKER V16.5.1] Baking atomized Mesh Profiles...');

    try {
        // 1. Load authoritative graph (V16.11 Gzip Support)
        let graphBuffer = await fs.readFile(GRAPH_PATH);

        // Manual Gunzip for baker core
        try {
            const zlib = await import('zlib');
            graphBuffer = zlib.default.gunzipSync(graphBuffer);
        } catch (e) {
            // Fallback if already uncompressed (dev mode)
        }

        const graph = JSON.parse(graphBuffer.toString('utf-8'));
        const nodeRegistry = graph.nodes || {};
        const edgeRegistry = graph.edges || {}; // Authoritative adjacency list
        const nodeIds = Object.keys(nodeRegistry);

        console.log(`[BAKER] Loaded ${nodeIds.length} nodes from graph.`);

        let bakedCount = 0;

        // 2. Process each node
        for (const nodeId of nodeIds) {
            const node = nodeRegistry[nodeId];
            const entityRelations = edgeRegistry[nodeId] || [];

            // V16.11 Fix: Support shorthand 't' or full 'type' from graph.json
            const typeValue = node.type || node.t;
            if (!node || !typeValue) continue;

            const baseType = typeValue.toLowerCase();
            const canonUrl = getRouteFromId(nodeId, baseType);

            // 3. Process relations with baked URLs
            const bakedRelations = entityRelations.map(rel => {
                const targetId = rel.target || rel.target_id || rel.id;
                const targetType = (rel.type || rel.t || 'model').toLowerCase();
                const bakedUrl = getRouteFromId(targetId, targetType);

                return {
                    ...rel,
                    url: bakedUrl,
                    target_id: targetId,
                    target_name: rel.name || rel.target_name || (targetId.includes('--') ? targetId.split('--').pop() : targetId)
                };
            });

            // 4. Construct Atomized Profile
            const profile = {
                id: nodeId,
                name: node.name || (nodeId.includes('--') ? nodeId.split('--').pop() : nodeId),
                type: typeValue,
                url: canonUrl,
                icon: node.icon || '📦',
                relations: bakedRelations,
                _generated_at: new Date().toISOString(),
                _version: '16.5.1-baked'
            };

            // 5. Smart Write: mesh/profiles/{nodeId}.json (Gzip Enabled)
            const targetKey = `mesh/profiles/${nodeId}.json`;
            await smartWriteWithVersioning(targetKey, profile, CACHE_DIR, { compress: true });

            bakedCount++;
            if (bakedCount % 10000 === 0) console.log(`[BAKER] Baked ${bakedCount} profiles...`);
        }

        console.log(`[BAKER] ✅ Successfully baked ${bakedCount} Mesh Profiles.`);

    } catch (error) {
        console.error('[BAKER] ❌ Baking failed:', error.message);
        process.exit(1);
    }
}

main();
