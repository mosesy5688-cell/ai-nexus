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
import { emitProvisionalSourceSummary } from '../../utils/provisional-source-stats.js';
import { buildRelationsGraphFromFilesFFI } from './rust-bridge.js';
import { newEvidenceDict, edgeId, structuralSentinel } from './evidence-carrier.js';

const RELATION_STATS = {
    BASED_ON: 0, TRAINED_ON: 0, CITES: 0, IMPLEMENTS: 0,
    USES: 0, DEMO_OF: 0, STACK: 0, DEP: 0,
    FEATURES: 0, TRENDING: 0, EXPLAIN: 0, FOLLOWS: 0
};

/**
 * Add edge to edges map + update counts.
 *
 * Edges are stored ONE-DIRECTIONALLY (edges[sourceId] only). The INBOUND view a
 * paper/benchmark needs (CITED_BY / EVALUATED_BY / DEFINES of edges that already
 * exist here) is reverse-projected downstream from the COMPLETE deduped graph in
 * mesh-profile-baker.js (buildInverseAdjacency over graph.edges) — NOT here. This
 * stage's `edges` map is consumed by mesh-graph-generator (Rust-FFI primary) which
 * rebuilds graph.json.zst; an inverse built here would not survive that rebuild,
 * so the baker is the runtime-correct chokepoint for PR-2 reverse projection.
 */
function addEdge(edges, counts, sourceId, targetId, relType, confidence = 1.0, ed = null, evidence = null) {
    if (!edges[sourceId]) edges[sourceId] = [];
    // D0a carrier: widen the 3-tuple to [target, type, conf, source_trail_refs, edge_id].
    // Refs are COMPACT integer indices into the per-graph evidence dictionary (spec
    // 2B) -- NEVER the fat element object. edge_id is deterministic (spec 5).
    const refs = (ed && evidence) ? [ed.add(evidence)] : [];
    const eid = edgeId(sourceId, relType, targetId);
    edges[sourceId].push([targetId, relType, Math.round(confidence * 100), refs, eid]);
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
    // D0a: the relations-stage evidence dictionary (OWNS the per-edge trail slice;
    // the mesh stage later imports + appends structural edges). One ref-space.
    const ed = newEvidenceDict();

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
                // report FEATURES: source = daily report (no source_url) -> sentinel.
                addEdge(edges, counts, rId, hId, 'FEATURES', 1.0, ed,
                    structuralSentinel('report_injection', rId, 'structural_injection'));
                totalRelations++;
            }
        }
        // Link sequential reports (FOLLOWS) -> report-chain structural sentinel.
        const sorted = Object.values(nodes).filter(n => n.t === 'report').sort((a, b) => b.day.localeCompare(a.day));
        for (let i = 0; i < sorted.length - 1; i++) {
            const fId = `report--${sorted[i].day}`;
            addEdge(edges, counts, fId, `report--${sorted[i + 1].day}`, 'FOLLOWS', 1.0, ed,
                structuralSentinel('report_injection', fId, 'report_chain'));
            totalRelations++;
        }
    } catch (e) {
        console.warn('  [RELATIONS] Could not inject daily reports:', e.message);
    }

    // Streaming entity relation extraction — no allRelations[] accumulation.
    // V27.94: use the dedicated relation-aware projection (Rust primary, JS
    // fallback) instead of slim. The slim projection stripped every
    // relation-source field (base_model/datasets/refs/...), so this loop only
    // ever saw STACK-edge inputs (61.8% zero-rel in prod). The relation
    // projection still carries fni_score for the node force weight below.
    await shardReader(async (entities) => {
        for (const entity of entities) {
            const id = entity.id || entity.slug;
            nodes[id] = { t: entity.type || 'model', f: Math.round((entity.fni_score || 0) * 10) / 10 };
            for (const rel of extractEntityRelations(entity)) {
                // D0a: rel._evidence is the LOGICAL 2A element; addEdge interns it
                // into the dict and stores only the COMPACT ref on the edge.
                addEdge(edges, counts, rel.source_id, rel.target_id, rel.relation_type, rel.confidence, ed, rel._evidence);
                if (!nodes[rel.target_id]) nodes[rel.target_id] = { t: rel.target_type || 'concept', f: 0 };
                totalRelations++;
            }
        }
    }, { relations: true });

    // Try Rust file-based graph building
    let rustDone = false;
    try {
        const { zstdCompress } = await import('./zstd-helper.js');
        const nodesPath = path.join(relationsDir, '_tmp-nodes.json.zst');
        const relsPath = path.join(relationsDir, '_tmp-relations.json.zst');
        const dictPath = path.join(relationsDir, '_tmp-evidence-dict.json.zst');
        await fs.writeFile(nodesPath, await zstdCompress(JSON.stringify(nodes)));
        // D0a: hand the relations-stage evidence dictionary to Rust so it embeds
        // explicit.evidence_dict (Rust primary writes explicit.json directly).
        await fs.writeFile(dictPath, await zstdCompress(JSON.stringify(ed.dict)));
        // Reconstruct flat relations from edges for Rust (streamed write, not accumulated)
        // D0a: carry the COMPACT source_trail refs + edge_id THROUGH to Rust (it passes
        // them verbatim into the emitted widened arrays; JS owns the relations-stage dict).
        const relsFromEdges = [];
        for (const [sourceId, edgeList] of Object.entries(edges)) {
            const sType = nodes[sourceId]?.t || 'model';
            for (const [targetId, relType, conf, refs, eid] of edgeList) {
                relsFromEdges.push({ source_id: sourceId, source_type: sType, target_id: targetId, target_type: nodes[targetId]?.t || 'concept', relation_type: relType, confidence: conf / 100, source_trail: refs || [], edge_id: eid || '' });
            }
        }
        await fs.writeFile(relsPath, await zstdCompress(JSON.stringify(relsFromEdges)));
        relsFromEdges.length = 0; // Release immediately
        const r = buildRelationsGraphFromFilesFFI(nodesPath, relsPath, relationsDir, dictPath);
        await fs.unlink(nodesPath).catch(() => {});
        await fs.unlink(relsPath).catch(() => {});
        await fs.unlink(dictPath).catch(() => {});
        if (r?.explicitJson && r?.legacyJson) {
            await fs.writeFile(path.join(relationsDir, 'explicit.json.zst'), Buffer.from(r.explicitJson));
            await fs.writeFile(path.join(cacheDir, 'relations.json.zst'), Buffer.from(r.legacyJson));
            console.log(`  [RELATIONS] Rust FFI: ${r.totalRelations} relations`);
            rustDone = true;
        }
    } catch (e) { console.warn(`[RELATIONS] Rust FFI skipped (${e.message}).`); }

    // JS fallback: write explicit.json from nodes + edges. D0a: include the
    // evidence_dict so refs on widened edges resolve (Rust embeds it identically).
    if (!rustDone) {
        const output = { _v: '25.9.1', _ts: new Date().toISOString(), _count: totalRelations, _stats: counts, nodes, edges, evidence_dict: ed.dict };
        await smartWriteWithVersioning('relations/explicit.json', output, cacheDir, { compress: true });
    }

    console.log(`  [RELATIONS] ${totalRelations} relations extracted`);
    for (const [type, count] of Object.entries(counts)) {
        if (count > 0) console.log(`    - ${type}: ${count}`);
    }
    // Observability-only: surface how many edges leaned on getNodeSource's
    // inferred default source (fabricated provenance debt owned by Identity
    // Layer 2). No-op when zero, so clean runs stay quiet. Zero behavior change.
    emitProvisionalSourceSummary();
    return { relationCounts: counts, totalRelations };
}
