// Mesh Graph Generator V16.4.3 - SPEC-KNOWLEDGE-MESH-V16.2

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { buildMeshGraphFromFilesFFI, buildMeshGraphFFI } from './rust-bridge.js';
import { newEvidenceDict, edgeId, structuralSentinel } from './evidence-carrier.js';

const VERSION = '16.2';

/** Load file as raw buffer (for Rust FFI). Tries .zst/.gz variants. */
async function loadJsonBuffer(filePath) {
    try { return await fs.readFile(filePath + '.zst'); } catch {}
    try { return await fs.readFile(filePath + '.gz'); } catch {}
    try { return await fs.readFile(filePath); } catch {}
    return null;
}

async function loadJson(filePath) {
    const { autoDecompress } = await import('./zstd-helper.js');
    const candidates = [filePath];
    if (!filePath.endsWith('.zst') && !filePath.endsWith('.gz')) {
        candidates.push(filePath + '.zst', filePath + '.gz');
    }
    for (const p of candidates) {
        try {
            const raw = await fs.readFile(p);
            const content = await autoDecompress(raw);
            return JSON.parse(content.toString('utf-8'));
        } catch {}
    }
    console.warn(`  [WARN] Could not load ${filePath}`);
    return null;
}

// Canonical prefix -> node-type table. MUST stay in parity with the Rust impl
// (rust/satellite-tasks/src/mesh_graph.rs get_node_type, the PRIMARY path) and
// the id-normalizer.js PREFIX_MAP. JS getNodeType is fallback-only; keep identical
// so a Rust-skip cycle never produces a divergent by_type histogram. Longest-match
// first (more-specific prefixes win where one is a substring of another).
const NODE_TYPE_PREFIXES = [
    ['hf-model--', 'model'], ['gh-model--', 'model'], ['civitai-model--', 'model'],
    ['replicate-model--', 'model'], ['ollama-model--', 'model'], ['kaggle-model--', 'model'],
    ['kb-model--', 'model'], ['huggingface--', 'model'], ['model--', 'model'],
    ['arxiv-paper--', 'paper'], ['s2-paper--', 'paper'], ['hf-paper--', 'paper'],
    ['arxiv--', 'paper'], ['paper--', 'paper'],
    ['hf-dataset--', 'dataset'], ['kaggle-dataset--', 'dataset'], ['dataset--', 'dataset'],
    ['hf-space--', 'space'], ['gh-space--', 'space'], ['space--', 'space'],
    ['hf-agent--', 'agent'], ['gh-agent--', 'agent'], ['replicate-agent--', 'agent'],
    ['langchain-agent--', 'agent'], ['mcp-server--', 'agent'], ['agent--', 'agent'],
    ['gh-tool--', 'tool'], ['hf-tool--', 'tool'], ['gh-repo--', 'tool'],
    ['mcp-tool--', 'tool'], ['tool--', 'tool'],
    ['langchain-prompt--', 'prompt'], ['hf-prompt--', 'prompt'], ['prompt--', 'prompt'],
    ['benchmark--', 'benchmark'],
    ['knowledge--', 'knowledge'], ['k--', 'knowledge'], ['kb--', 'knowledge'],
    ['report--', 'report'],
].sort((a, b) => b[0].length - a[0].length);

function getNodeType(id) {
    if (!id) return 'unknown';
    const cleanId = id.toLowerCase();
    for (const [prefix, type] of NODE_TYPE_PREFIXES) {
        if (cleanId.startsWith(prefix)) return type;
    }
    return 'unknown';
}

export async function generateMeshGraph(outputDir = './output') {
    console.log('[MESH-GRAPH V16.2] Generating 8-node mesh graph...');

    const meshDir = path.join(outputDir, 'cache', 'mesh');
    await fs.mkdir(meshDir, { recursive: true });

    // V26.5: Try Rust file-based FFI first (no V8 string limit)
    const relDir = path.join(outputDir, 'cache', 'relations');
    const reportsDir = path.join(outputDir, 'cache', 'reports');
    try {
        const r = buildMeshGraphFromFilesFFI(
            path.join(relDir, 'explicit.json.zst'), path.join(relDir, 'knowledge-links.json.zst'),
            path.join(reportsDir, 'index.json.zst'), meshDir
        );
        if (r?.nodeCount > 0) {
            await fs.writeFile(path.join(meshDir, 'graph.json.zst'), Buffer.from(r.graphData));
            await fs.writeFile(path.join(meshDir, 'stats.json.zst'), Buffer.from(r.statsData));
            console.log(`[MESH-GRAPH] Rust file FFI: ${r.nodeCount} nodes, ${r.edgeCount} edges`);
            return { nodes: r.nodeCount, edges: r.edgeCount };
        }
    } catch (e) { console.log(`[MESH-GRAPH] Rust file FFI skipped: ${e.message}`); }

    // V25.8.3: Fallback — Rust Buffer FFI
    try {
        const explicitBuf = await loadJsonBuffer(path.join(relDir, 'explicit.json'));
        const knowledgeBuf = await loadJsonBuffer(path.join(relDir, 'knowledge-links.json'));
        const reportsBuf = await loadJsonBuffer(path.join(reportsDir, 'index.json'));
        if (explicitBuf) {
            const r = buildMeshGraphFFI(explicitBuf, knowledgeBuf || Buffer.alloc(0), reportsBuf || Buffer.alloc(0));
            if (r?.nodeCount > 0) {
                await fs.writeFile(path.join(meshDir, 'graph.json.zst'), Buffer.from(r.graphData));
                await fs.writeFile(path.join(meshDir, 'stats.json.zst'), Buffer.from(r.statsData));
                console.log(`[MESH-GRAPH] Rust Buffer FFI: ${r.nodeCount} nodes, ${r.edgeCount} edges`);
                return { nodes: r.nodeCount, edges: r.edgeCount };
            }
        }
    } catch (e) { console.log(`[MESH-GRAPH] Rust Buffer FFI skipped: ${e.message}`); }

    const nodes = {};
    const edges = {};
    const stats = { nodes: 0, edges: 0, by_type: {}, by_edge_type: {} };

    // Edge dedup keyed by (source, target, relation_type) — MUST match Rust
    // mesh_graph.rs seen_edges. Target-only dedup dropped the 2nd type when two
    // entities share >1 relation (USES+STACK, BASED_ON+CITES).
    const seenEdges = new Set();
    const edgeKey = (s, t, ty) => [s, t, ty].join("|");

    // Load explicit relations. D0a: seed the evidence dict from the relations stage;
    // this fallback APPENDS structural sentinels for the EXPLAINS/FEATURED_IN it mints.
    const explicit = await loadJson(path.join(outputDir, 'cache', 'relations', 'explicit.json'));
    const ed = newEvidenceDict(explicit?.evidence_dict);
    if (explicit?.nodes) {
        console.log('  [EXPLICIT] Loading nodes and edges...');
        for (const [id, nodeData] of Object.entries(explicit.nodes)) {
            nodes[id] = {
                t: nodeData.t || getNodeType(id),
                f: nodeData.f || 0
            };
        }

        if (explicit.edges) {
            for (const [sourceId, edgeList] of Object.entries(explicit.edges)) {
                if (!edges[sourceId]) edges[sourceId] = [];
                for (const edge of edgeList) {
                    // D0a: preserve the carrier (slot[3]=source_trail refs, slot[4]=edge_id)
                    // on BOTH paths so a Rust-skip cycle does not silently drop the trail.
                    const isArr = Array.isArray(edge);
                    const [target, type, weight] = isArr ? edge : [edge.target, edge.type, edge.weight || 100];
                    const relType = type || 'RELATED';
                    const srcTrail = (isArr ? edge[3] : edge.source_trail) || [];
                    const eid = (isArr ? edge[4] : edge.edge_id) || edgeId(sourceId, relType, target);
                    const k = edgeKey(sourceId, target, relType);
                    if (seenEdges.has(k)) continue;
                    seenEdges.add(k);
                    edges[sourceId].push({ target, type: relType, weight: (weight || 100) / 100, source_trail: srcTrail, edge_id: eid });
                    stats.by_edge_type[relType] = (stats.by_edge_type[relType] || 0) + 1;
                }
            }
        }
    }

    // Load knowledge links
    const knowledgeLinks = await loadJson(path.join(outputDir, 'cache', 'relations', 'knowledge-links.json'));
    if (knowledgeLinks?.links) {
        console.log('  [KNOWLEDGE] Adding EXPLAINS edges...');
        for (const link of knowledgeLinks.links) {
            const sourceId = link.entity_id; // Already normalized in knowledge-links.json
            // V16.3 FIX: knowledge is an array, not a flat field
            for (const kEntry of (link.knowledge || [])) {
                const targetId = `knowledge--${kEntry.slug || kEntry.id}`;
                if (!nodes[sourceId]) nodes[sourceId] = { t: link.entity_type || 'model', f: 0 };
                if (!nodes[targetId]) nodes[targetId] = { t: 'knowledge', f: 0 };
                if (!edges[sourceId]) edges[sourceId] = [];
                // Avoid duplicate edges ((source,target,type) key — matches Rust)
                const k = edgeKey(sourceId, targetId, 'EXPLAINS');
                if (!seenEdges.has(k)) {
                    seenEdges.add(k);
                    // D0a: structural sentinel (no external source_url for a knowledge link).
                    const ref = ed.add(structuralSentinel('mesh_graph_explains', 'knowledge-links.json'));
                    edges[sourceId].push({ target: targetId, type: 'EXPLAINS', weight: (kEntry.confidence || 80) / 100, source_trail: [ref], edge_id: edgeId(sourceId, 'EXPLAINS', targetId) });
                    stats.by_edge_type['EXPLAINS'] = (stats.by_edge_type['EXPLAINS'] || 0) + 1;
                }
            }
        }
    }


    // Load reports and add FEATURED_IN edges
    const reportsIndex = await loadJson(path.join(outputDir, 'cache', 'reports', 'index.json'));
    if (reportsIndex?.reports) {
        console.log('  [REPORTS] Adding FEATURED_IN edges...');
        for (const report of reportsIndex.reports) {
            const reportId = `report--${report.id}`;
            nodes[reportId] = { t: 'report', f: report.highlights || 0 };

            // Load individual report for highlights
            try {
                const reportPath = path.join(outputDir, 'cache', 'reports', 'daily', `${report.id}.json.gz`);
                const reportData = await loadJson(reportPath);
                if (reportData?.highlights) {
                    for (const highlight of reportData.highlights) {
                        const entityId = highlight.entity_id;
                        const fk = entityId && edgeKey(entityId, reportId, 'FEATURED_IN');
                        if (entityId && !seenEdges.has(fk)) {
                            seenEdges.add(fk);
                            if (!edges[entityId]) edges[entityId] = [];
                            // D0a: structural sentinel (no external source_url for a report).
                            const ref = ed.add(structuralSentinel('mesh_graph_featured_in', 'reports'));
                            edges[entityId].push({ target: reportId, type: 'FEATURED_IN', weight: 1.0, source_trail: [ref], edge_id: edgeId(entityId, 'FEATURED_IN', reportId) });
                            stats.by_edge_type['FEATURED_IN'] = (stats.by_edge_type['FEATURED_IN'] || 0) + 1;
                        }
                    }
                }
            } catch (e) {
                // Skip if report file not found
            }
        }
    }

    // Calculate final stats
    stats.nodes = Object.keys(nodes).length;
    stats.edges = Object.values(edges).reduce((sum, arr) => sum + arr.length, 0);

    for (const node of Object.values(nodes)) {
        stats.by_type[node.t] = (stats.by_type[node.t] || 0) + 1;
    }

    const ts = new Date().toISOString();
    // D0a: emit the merged evidence_dict (relations refs + minted sentinels).
    await smartWriteWithVersioning('graph.json', { _v: VERSION, _ts: ts, nodes, edges, evidence_dict: ed.dict, stats }, meshDir, { compress: true });
    await smartWriteWithVersioning('stats.json', { _v: VERSION, _ts: ts, ...stats }, meshDir, { compress: true });

    console.log(`[MESH-GRAPH] Generated graph with ${stats.nodes} nodes, ${stats.edges} edges`);
    console.log(`  By type: ${JSON.stringify(stats.by_type)}`);

    return stats;
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const outputDir = process.argv[2] || './output';
    generateMeshGraph(outputDir)
        .then(stats => console.log(`✅ Mesh graph complete: ${stats.nodes} nodes, ${stats.edges} edges`))
        .catch(e => {
            console.error('❌ Mesh graph failed:', e.message);
            process.exit(1);
        });
}
