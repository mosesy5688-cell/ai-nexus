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
    'tool': '/tool',
    'prompt': '/prompt'
};

async function main() {
    console.log('[BAKER V22.0] Baking atomized Mesh Profiles (ID Sync Level)...');

    try {
        let graphBuffer = await fs.readFile(GRAPH_PATH);
        try {
            const zlib = await import('zlib');
            graphBuffer = zlib.default.gunzipSync(graphBuffer);
        } catch (e) { }

        const graph = JSON.parse(graphBuffer.toString('utf-8'));
        const nodeRegistry = graph.nodes || {};
        const edgeRegistry = graph.edges || {};
        const nodeIds = Object.keys(nodeRegistry);

        console.log(`[BAKER] Loaded ${nodeIds.length} nodes from graph.`);

        let bakedCount = 0;
        for (let nodeId of nodeIds) {
            // V22.0 Phase 3: Synchronize all entity IDs with V2.1 prefixes
            const node = nodeRegistry[nodeId];
            const typeValue = node.type || node.t || 'model';

            // Ensure ID is normalized per SPEC-V2.1
            const syncedId = normalizeId(nodeId, getNodeSource(nodeId, typeValue), typeValue);

            const entityRelations = edgeRegistry[nodeId] || [];
            const canonUrl = getRouteFromId(syncedId, typeValue);

            const bakedRelations = entityRelations.map(rel => {
                const targetIdRaw = rel.target || rel.target_id || rel.id;
                const targetType = (rel.type || rel.t || 'model').toLowerCase();
                const syncedTargetId = normalizeId(targetIdRaw, getNodeSource(targetIdRaw, targetType), targetType);
                const bakedUrl = getRouteFromId(syncedTargetId, targetType);

                // V25.1 Compute Shift-Left: Zero-Placeholder Registry Lookup
                const registryNode = nodeRegistry[targetIdRaw] || nodeRegistry[syncedTargetId] || {};
                const finalTargetName = rel.name || rel.target_name || registryNode.name || registryNode.displayName || (syncedTargetId.split('--').pop());
                const finalTargetIcon = rel.icon || registryNode.icon || '📦';

                return {
                    ...rel,
                    url: bakedUrl,
                    target_id: syncedTargetId,
                    target_name: finalTargetName,
                    icon: finalTargetIcon
                };
            });

            // V25.1 Compute Shift-Left: Enforce High-Fidelity Naming
            const profile = {
                id: syncedId,
                name: node.name || node.displayName || (syncedId.split('--').pop()),
                type: typeValue,
                url: canonUrl,
                icon: node.icon || '📦',
                relations: bakedRelations,
                _generated_at: new Date().toISOString(),
                _version: '22.0.0-synced-baker'
            };

            const targetKey = `mesh/profiles/${syncedId}.json`;
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
