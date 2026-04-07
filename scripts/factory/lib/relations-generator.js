/**
 * Relations Generator V25.9.1
 * SPEC: SPEC-KNOWLEDGE-V14.5.2
 * Constitution: Art 4.4 (Cross-Entity Ranking), Art 5.1 (< 250 lines)
 *
 * V25.9.1: Eliminate allRelations[] — keep only nodes{} + edges{} in memory.
 * Runs as independent satellite task (separate Node process per task).
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { extractEntityRelations } from './relation-extractors.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { buildRelationsGraphFromFilesFFI } from './rust-bridge.js';

const RELATION_STATS = {
    BASED_ON: 0, TRAINED_ON: 0, CITES: 0, IMPLEMENTS: 0,
    USES: 0, DEMO_OF: 0, STACK: 0, DEP: 0,
    FEATURES: 0, TRENDING: 0, EXPLAIN: 0, FOLLOWS: 0
};

/** Add edge to edges map + update counts */
function addEdge(edges, counts, sourceId, targetId, relType, confidence = 1.0) {
    if (!edges[sourceId]) edges[sourceId] = [];
    edges[sourceId].push([targetId, relType, Math.round(confidence * 100)]);
    counts[relType] = (counts[relType] || 0) + 1;
}

/**
 * Generate explicit.json for frontend knowledge linking.
 * V25.9.1: Zero allRelations[] accumulation — only nodes + edges in memory.
 */
export async function generateRelations(shardReader, outputDir = './output') {
    console.log('[RELATIONS V25.9.1] Extracting entity relations (streaming)...');

    const cacheDir = path.join(outputDir, 'cache');
    const relationsDir = path.join(cacheDir, 'relations');
    await fs.mkdir(relationsDir, { recursive: true });

    const counts = { ...RELATION_STATS };
    const nodes = {};
    const edges = {};
    let totalRelations = 0;

    const HUB_NODES = ['concept--trending-now', 'concept--daily-highlights', 'concept--agentic-ai'];
    for (const hubId of HUB_NODES) {
        nodes[hubId] = { t: 'concept', f: 10.0, hub: true };
    }

    // V15: Inject Daily Reports (Time Dimension)
    try {
        const dailyDir = path.join(outputDir, 'daily');
        const reportFiles = await fs.readdir(dailyDir).catch(() => []);
        const { autoDecompress } = await import('./zstd-helper.js');
        for (const file of reportFiles) {
            if (!file.endsWith('.json') && !file.endsWith('.json.gz') && !file.endsWith('.json.zst')) continue;
            let data = await fs.readFile(path.join(dailyDir, file));
            data = await autoDecompress(data);
            const rd = JSON.parse(data.toString('utf-8'));
            if (!rd.id) continue;
            const rId = `report--${rd.id}`;
            nodes[rId] = { t: 'report', f: 5.0, title: rd.title, day: rd.id };
            for (const h of (rd.highlights || [])) {
                const hType = h.type || 'model';
                const hId = normalizeId(h.id, getNodeSource(h.id, hType), hType);
                addEdge(edges, counts, rId, hId, 'FEATURES');
                totalRelations++;
            }
        }
        // Link sequential reports (FOLLOWS)
        const sorted = Object.values(nodes).filter(n => n.t === 'report').sort((a, b) => b.day.localeCompare(a.day));
        for (let i = 0; i < sorted.length - 1; i++) {
            addEdge(edges, counts, `report--${sorted[i].day}`, `report--${sorted[i + 1].day}`, 'FOLLOWS');
            totalRelations++;
        }
    } catch (e) {
        console.warn('  [RELATIONS] Could not inject daily reports:', e.message);
    }

    // Streaming entity relation extraction — no allRelations[] accumulation
    await shardReader(async (entities) => {
        for (const entity of entities) {
            const id = entity.id || entity.slug;
            nodes[id] = { t: entity.type || 'model', f: Math.round((entity.fni_score || 0) * 10) / 10 };
            for (const rel of extractEntityRelations(entity)) {
                addEdge(edges, counts, rel.source_id, rel.target_id, rel.relation_type, rel.confidence);
                if (!nodes[rel.target_id]) nodes[rel.target_id] = { t: rel.target_type || 'concept', f: 0 };
                totalRelations++;
            }
        }
    }, { slim: true });

    // Try Rust file-based graph building
    let rustDone = false;
    try {
        const { zstdCompress } = await import('./zstd-helper.js');
        const nodesPath = path.join(relationsDir, '_tmp-nodes.json.zst');
        const relsPath = path.join(relationsDir, '_tmp-relations.json.zst');
        await fs.writeFile(nodesPath, await zstdCompress(JSON.stringify(nodes)));
        // Reconstruct flat relations from edges for Rust (streamed write, not accumulated)
        const relsFromEdges = [];
        for (const [sourceId, edgeList] of Object.entries(edges)) {
            const sType = nodes[sourceId]?.t || 'model';
            for (const [targetId, relType, conf] of edgeList) {
                relsFromEdges.push({ source_id: sourceId, source_type: sType, target_id: targetId, target_type: nodes[targetId]?.t || 'concept', relation_type: relType, confidence: conf / 100 });
            }
        }
        await fs.writeFile(relsPath, await zstdCompress(JSON.stringify(relsFromEdges)));
        relsFromEdges.length = 0; // Release immediately
        const r = buildRelationsGraphFromFilesFFI(nodesPath, relsPath, relationsDir);
        await fs.unlink(nodesPath).catch(() => {});
        await fs.unlink(relsPath).catch(() => {});
        if (r?.explicit_json && r?.legacy_json) {
            await fs.writeFile(path.join(relationsDir, 'explicit.json.zst'), Buffer.from(r.explicit_json));
            await fs.writeFile(path.join(cacheDir, 'relations.json.zst'), Buffer.from(r.legacy_json));
            console.log(`  [RELATIONS] Rust FFI: ${r.total_relations} relations`);
            rustDone = true;
        }
    } catch (e) { console.warn(`[RELATIONS] Rust FFI skipped (${e.message}).`); }

    // JS fallback: write explicit.json from nodes + edges
    if (!rustDone) {
        const output = { _v: '25.9.1', _ts: new Date().toISOString(), _count: totalRelations, _stats: counts, nodes, edges };
        await smartWriteWithVersioning('relations/explicit.json', output, cacheDir, { compress: true });
    }

    console.log(`  [RELATIONS] ${totalRelations} relations extracted`);
    for (const [type, count] of Object.entries(counts)) {
        if (count > 0) console.log(`    - ${type}: ${count}`);
    }
    return { relationCounts: counts, totalRelations };
}
