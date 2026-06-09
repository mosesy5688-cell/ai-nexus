/**
 * Mesh relation-content bake canary (extracted from verify-canaries.js to stay
 * under CES 250). Two layers over the served relation graph:
 *
 *  1. mesh_graph topology — aggregate topology + EVALUATED_ON + each CRITICAL
 *     edge class > 0 (catches a whole relation type silent-zeroing, the gap the
 *     2026-06-06 backend audit and #2144 EVALUATED_ON regression exposed).
 *  2. PR-1 Mesh Resolution — every served ui_related_mesh edge resolves to a real
 *     packed entity (No-Fake-Density-at-source). The distiller RESOLVE-FILTERS the
 *     graph now (drops entity_lookup misses + concept/knowledge stubs instead of
 *     keeping a humanized fake), so honest sparsity is VALID and the canary asserts
 *     ZERO surviving unresolved/concept-stub edges via isResolvedMeshNode.
 *
 * Every threshold is CONSERVATIVE: a false canary blocks every bake.
 */
import { isResolvedMeshNode } from './mesh-resolve-filter.js';
import { assertEdgeTrail } from './evidence-carrier.js';

/**
 * Per-edge-type topology canary.
 *
 * verify-db's aggregate `topo > 0` passes on a SINGLE BASED_ON edge even if
 * CITES / TRAINED_ON / USES were all silently stripped by a projection bug
 * (exactly how EVALUATED_ON silent-zeroed invisibly until #2144). We assert each
 * CRITICAL relation class is independently present.
 * CRITICAL set = the four classes structurally guaranteed at corpus scale (every
 * cycle has model->dataset TRAINED_ON, paper CITES, model BASED_ON, tool/ecosystem
 * USES); EVALUATED_ON keeps its own dedicated check below. Rare/optional classes
 * (IMPLEMENTS, DEMO_OF, DEP) are EXCLUDED: they can legitimately be 0.
 */
const CRITICAL_EDGE_TYPES = ['BASED_ON', 'TRAINED_ON', 'CITES', 'USES'];
const TOPOLOGY = new Set(['BASED_ON', 'TRAINED_ON', 'CITES', 'USES', 'IMPLEMENTS', 'DEMO_OF', 'DEP', 'EVALUATED_ON']);

function verifyEdgeTypeTopology(graph, check) {
    const counts = Object.create(null);
    for (const list of Object.values(graph.edges || {})) {
        for (const e of (Array.isArray(list) ? list : [])) {
            const t = ((Array.isArray(e) ? e[1] : (e.type || e.relation_type)) || '').toUpperCase();
            if (!t) continue;
            counts[t] = (counts[t] || 0) + 1;
        }
    }
    for (const t of CRITICAL_EDGE_TYPES) {
        const n = counts[t] || 0;
        // Floor is > 0 (not a ratio): at real corpus scale each class numbers in
        // the thousands, so 0 unambiguously means the whole class was stripped.
        check(`Edge: ${t}`, n > 0, `${n} edges (need > 0)`);
    }
}

/**
 * V27.94 (A.3) mesh topology + PR-1 resolution canary. `database`/`check` are
 * passed in (not module-scoped) so this stays a pure, testable function.
 */
export function verifyRelationContent(database, hasMeshGraph, check) {
    if (hasMeshGraph) {
        try {
            const graph = JSON.parse(database.prepare("SELECT value FROM site_metadata WHERE key='mesh_graph'").get().value);
            let topo = 0, total = 0, evalOn = 0;
            for (const list of Object.values(graph.edges || {})) {
                for (const e of (Array.isArray(list) ? list : [])) {
                    total++;
                    const t = ((Array.isArray(e) ? e[1] : (e.type || e.relation_type)) || '').toUpperCase();
                    if (TOPOLOGY.has(t)) topo++; if (t === 'EVALUATED_ON') evalOn++; // EVALUATED_ON dedicated count
                }
            }
            check('Mesh Topology Edges', topo > 0, `${topo} topology / ${total} total (need > 0)`);
            check('EVALUATED_ON edges', evalOn > 0, `${evalOn} model-benchmark (need > 0)`);
            verifyEdgeTypeTopology(graph, check); // per-class: catch a whole relation type silent-zeroing
        } catch (e) {
            check('Mesh Topology Edges', false, `mesh_graph parse failed: ${e.message.slice(0, 40)}`);
        }
    }
    // PR-1 Mesh Resolution canary (No-Fake-Density-at-source). The distiller now
    // RESOLVE-FILTERS ui_related_mesh: every served edge points at a real packed
    // entity; unresolved targets + concept/knowledge stubs are DROPPED, not kept
    // with a humanized name. So this is no longer a degeneracy RATIO (the fake
    // density that masked sparsity is gone): honest sparsity (an entity with 0
    // real relations, or a tiny sample) is VALID -> PASS, but ANY surviving
    // unresolved/concept-stub edge FAILS. We sample top-FNI rows and assert ZERO
    // unresolved nodes via the shared isResolvedMeshNode authority.
    try {
        const rows = database.prepare("SELECT ui_related_mesh AS m FROM entities WHERE ui_related_mesh IS NOT NULL AND ui_related_mesh != '[]' ORDER BY fni_score DESC LIMIT 500").all();
        let relCount = 0, unresolved = 0;
        for (const r of rows) {
            let arr; try { arr = JSON.parse(r.m); } catch { continue; }
            for (const rel of (Array.isArray(arr) ? arr : [])) {
                relCount++;
                if (!isResolvedMeshNode(rel)) unresolved++;
            }
        }
        // honest-empty / sparse sample -> PASS (no fabricated edges to find).
        if (relCount === 0) { console.log('[VERIFY] Mesh Resolution: PASS (0 relations sampled — honest sparsity)'); return; }
        check('Mesh Resolution', unresolved === 0, `${unresolved} unresolved/concept-stub of ${relCount} served edges (need 0)`);
    } catch (e) {
        console.log(`[VERIFY] Mesh Resolution: skipped (${e.message.slice(0, 40)})`);
    }
    // D0a source_trail coverage (WARN-only: REPORTS, never fails the bake; the
    // bake-FAIL flip + negative-fixture gate is PR-D0b, spec sec 13).
    verifySourceTrailCoverage(database, hasMeshGraph);
}

/** Read the carrier refs off an edge (array slot[3] | object .source_trail). */
function edgeRefs(e) {
    if (Array.isArray(e)) return Array.isArray(e[3]) ? e[3] : [];
    return Array.isArray(e && e.source_trail) ? e.source_trail : [];
}

/**
 * D0a WARN coverage report over BOTH baked sinks (spec sec 9, WARN mode). Reports
 * % of edges carrying >=1 RESOLVABLE source_trail ref + a per-producer histogram;
 * logs gaps. Does NOT exit(1) -- one re-bake reads this to size PR-D0b's FAIL flip.
 */
export function verifySourceTrailCoverage(database, hasMeshGraph) {
    if (!hasMeshGraph) return;
    let graph;
    try {
        graph = JSON.parse(database.prepare("SELECT value FROM site_metadata WHERE key='mesh_graph'").get().value);
    } catch { console.log('[VERIFY] source_trail coverage (WARN): skipped (mesh_graph parse)'); return; }
    const dict = graph.evidence_dict || null;
    // Sink 1: graph blob.
    reportSink('graph_blob', Object.values(graph.edges || {}), dict);
    // Sink 2: ui_related_mesh (resolves vs graph.evidence_dict; reverse-sentinel
    // refs the baker appended are NOT in the graph dict yet -> surface as gaps,
    // exactly what WARN mode is for. PR-D0b folds them into one served dict).
    try {
        const rows = database.prepare("SELECT ui_related_mesh AS m FROM entities WHERE ui_related_mesh IS NOT NULL AND ui_related_mesh != '[]'").all();
        const lists = [];
        for (const r of rows) { try { lists.push(JSON.parse(r.m)); } catch { /* skip */ } }
        reportSink('ui_related_mesh', lists, dict);
    } catch (e) { console.log(`[VERIFY] source_trail ui_related_mesh: skipped (${e.message.slice(0, 30)})`); }
}

/** Scan one sink's edge lists; log coverage % + per-producer histogram (WARN). */
function reportSink(sinkName, edgeLists, dict) {
    let scanned = 0, covered = 0;
    const byProducer = Object.create(null);
    for (const list of edgeLists) {
        for (const e of (Array.isArray(list) ? list : [])) {
            scanned++;
            const refs = edgeRefs(e);
            const r = assertEdgeTrail(refs, dict);
            if (r.ok) {
                covered++;
                for (const ref of refs) {
                    const el = dict.elements[ref];
                    const p = el && dict.producers[el[5]];
                    if (p) byProducer[p] = (byProducer[p] || 0) + 1;
                }
            }
        }
    }
    const pct = scanned > 0 ? ((covered / scanned) * 100).toFixed(1) : '0.0';
    const gap = scanned - covered;
    console.log(`[VERIFY] source_trail coverage (WARN) [${sinkName}]: ${pct}% (${covered}/${scanned}); ${gap} gap`);
    if (Object.keys(byProducer).length) console.log(`           by producer: ${JSON.stringify(byProducer)}`);
}
