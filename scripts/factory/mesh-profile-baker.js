/**
 * Knowledge Mesh Profile Baker V16.5.0
 * job: Creates atomized, URL-injected mesh profiles for each entity.
 */

import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource, ALL_PREFIXES } from '../utils/id-normalizer.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';

const CACHE_DIR = process.env.CACHE_DIR || './cache';
const GRAPH_PATH = path.join(CACHE_DIR, 'mesh/graph.json');
const RELATIONS_PATH = path.join(CACHE_DIR, 'relations.json');

// URL routing mapping (Art 6.2 Alignment)
const TYPE_TO_ROUTE = {
    'model': '/model',
    'agent': '/agent',
    'dataset': '/dataset',
    'paper': '/paper',
    'space': '/space',
    'tool': '/tool'
};

function stripPrefix(id) {
    if (!id) return '';
    let clean = id;
    const sortedPrefixes = [...ALL_PREFIXES].sort((a, b) => b.length - a.length);
    for (const p of sortedPrefixes) {
        if (clean.startsWith(p)) {
            clean = clean.slice(p.length);
            break;
        }
    }
    return clean;
}

async function main() {
    console.log('[BAKER] 🧁 Baking atomized Mesh Profiles...');

    try {
        // 1. Load authoritative graph and relations
        const graph = JSON.parse(await fs.readFile(GRAPH_PATH, 'utf-8'));
        const relations = JSON.parse(await fs.readFile(RELATIONS_PATH, 'utf-8'));

        const nodeRegistry = graph.nodes || {};
        const edgeRegistry = relations || {};
        const nodeIds = Object.keys(nodeRegistry);

        console.log(`[BAKER] Loaded ${nodeIds.length} nodes and ${Object.keys(edgeRegistry).length} relation sets.`);

        let bakedCount = 0;

        // 2. Process each node
        for (const nodeId of nodeIds) {
            const node = nodeRegistry[nodeId];
            const entityRelations = edgeRegistry[nodeId] || [];

            // V16.11 Fix: Support 't' (shorthand) or 'type'
            const typeValue = node.type || node.t;
            if (!node || !typeValue) continue;

            const baseType = typeValue.toLowerCase();
            const route = TYPE_TO_ROUTE[baseType] || '/knowledge';
            const slug = stripPrefix(nodeId);

            // Bake absolute URL for self
            const canonUrl = `${route}/${slug}`;

            // 3. Process relations with baked URLs
            const bakedRelations = entityRelations.map(rel => {
                const targetId = rel.target_id || rel.id;
                const targetType = (rel.target_type || rel.type || rel.t || 'model').toLowerCase();
                const targetRoute = TYPE_TO_ROUTE[targetType] || '/knowledge';
                const targetSlug = stripPrefix(targetId);

                return {
                    ...rel,
                    url: `${targetRoute}/${targetSlug}`,
                    target_name: rel.target_name || rel.name || targetSlug
                };
            });

            // 4. Construct Atomized Profile
            const profile = {
                id: nodeId,
                name: node.name,
                type: typeValue,
                url: canonUrl,
                icon: node.icon || '📦',
                relations: bakedRelations,
                _generated_at: new Date().toISOString(),
                _version: '16.5.0-baked'
            };

            // 5. Smart Write to storage (Atomic) - Structure: mesh/profiles/{nodeId}.json
            const targetKey = `mesh/profiles/${nodeId}.json`;
            await smartWriteWithVersioning(targetKey, profile, CACHE_DIR);

            bakedCount++;
            if (bakedCount % 5000 === 0) console.log(`[BAKER] Baked ${bakedCount} profiles...`);
        }

        console.log(`[BAKER] ✅ Successfully baked ${bakedCount} Mesh Profiles.`);

    } catch (error) {
        console.error('[BAKER] ❌ Baking failed:', error.message);
        process.exit(1);
    }
}

main();
