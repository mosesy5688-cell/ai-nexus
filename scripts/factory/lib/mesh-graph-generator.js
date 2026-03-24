// Mesh Graph Generator V16.4.3 - SPEC-KNOWLEDGE-MESH-V16.2

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { buildMeshGraphFromFilesFFI, buildMeshGraphFFI } from './rust-bridge.js';

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

function getNodeType(id) {
    if (!id) return 'unknown';
    const cleanId = id.toLowerCase();

    // Model Tier
    if (cleanId.startsWith('hf-model--') || cleanId.startsWith('huggingface--') || cleanId.startsWith('model--') ||
        cleanId.startsWith('kb-model--') || cleanId.startsWith('civitai-model--') ||
        cleanId.startsWith('replicate-model--') || cleanId.startsWith('ollama-model--') ||
        cleanId.startsWith('kaggle-model--')) return 'model';

    // Paper Tier
    if (cleanId.startsWith('arxiv-paper--') || cleanId.startsWith('paper--') ||
        cleanId.startsWith('arxiv--') || cleanId.startsWith('hf-paper--')) return 'paper';

    // Other entities
    if (cleanId.startsWith('hf-agent--') || cleanId.startsWith('gh-agent--') || cleanId.startsWith('agent--')) return 'agent';
    if (cleanId.startsWith('hf-space--') || cleanId.startsWith('gh-space--') || cleanId.startsWith('space--')) return 'space';
    if (cleanId.startsWith('dataset--') || cleanId.startsWith('hf-dataset--') || cleanId.startsWith('kaggle-dataset--')) return 'dataset';
    if (cleanId.startsWith('tool--') || cleanId.startsWith('gh-tool--') || cleanId.startsWith('hf-tool--')) return 'tool';
    if (cleanId.startsWith('knowledge--') || cleanId.startsWith('kb--')) return 'knowledge';
    if (cleanId.startsWith('report--')) return 'report';

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
            path.join(relDir, 'explicit.json'), path.join(relDir, 'knowledge-links.json'),
            path.join(reportsDir, 'index.json'), meshDir
        );
        if (r) {
            await fs.writeFile(path.join(meshDir, 'graph.json.zst'), Buffer.from(r.graph_data));
            await fs.writeFile(path.join(meshDir, 'stats.json.zst'), Buffer.from(r.stats_data));
            console.log(`[MESH-GRAPH] Rust file FFI: ${r.node_count} nodes, ${r.edge_count} edges`);
            return { nodes: r.node_count, edges: r.edge_count };
        }
    } catch (e) { console.log(`[MESH-GRAPH] Rust file FFI skipped: ${e.message}`); }

    // V25.8.3: Fallback — Rust Buffer FFI
    try {
        const explicitBuf = await loadJsonBuffer(path.join(relDir, 'explicit.json'));
        const knowledgeBuf = await loadJsonBuffer(path.join(relDir, 'knowledge-links.json'));
        const reportsBuf = await loadJsonBuffer(path.join(reportsDir, 'index.json'));
        if (explicitBuf) {
            const r = buildMeshGraphFFI(explicitBuf, knowledgeBuf || Buffer.alloc(0), reportsBuf || Buffer.alloc(0));
            if (r) {
                await fs.writeFile(path.join(meshDir, 'graph.json.zst'), Buffer.from(r.graph_data));
                await fs.writeFile(path.join(meshDir, 'stats.json.zst'), Buffer.from(r.stats_data));
                console.log(`[MESH-GRAPH] Rust Buffer FFI: ${r.node_count} nodes, ${r.edge_count} edges`);
                return { nodes: r.node_count, edges: r.edge_count };
            }
        }
    } catch (e) { console.log(`[MESH-GRAPH] Rust Buffer FFI skipped: ${e.message}`); }

    const nodes = {};
    const edges = {};
    const stats = {
        nodes: 0,
        edges: 0,
        by_type: {},
        by_edge_type: {}
    };

    // Load explicit relations
    const explicit = await loadJson(path.join(outputDir, 'cache', 'relations', 'explicit.json'));
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
                    const [target, type, weight] = Array.isArray(edge)
                        ? edge
                        : [edge.target, edge.type, edge.weight || 100];

                    edges[sourceId].push({
                        target,
                        type: type || 'RELATED',
                        weight: (weight || 100) / 100
                    });

                    stats.by_edge_type[type] = (stats.by_edge_type[type] || 0) + 1;
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
            const knowledgeArray = link.knowledge || [];
            for (const kEntry of knowledgeArray) {
                const targetId = `knowledge--${kEntry.slug || kEntry.id}`;

                if (!nodes[sourceId]) {
                    nodes[sourceId] = { t: link.entity_type || 'model', f: 0 };
                }
                if (!nodes[targetId]) {
                    nodes[targetId] = { t: 'knowledge', f: 0 };
                }

                if (!edges[sourceId]) edges[sourceId] = [];

                // Avoid duplicate edges
                if (!edges[sourceId].find(e => e.target === targetId)) {
                    edges[sourceId].push({
                        target: targetId,
                        type: 'EXPLAINS',
                        weight: (kEntry.confidence || 80) / 100
                    });
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
                        if (entityId && !edges[entityId]?.find(e => e.target === reportId)) {
                            if (!edges[entityId]) edges[entityId] = [];
                            edges[entityId].push({
                                target: reportId,
                                type: 'FEATURED_IN',
                                weight: 1.0
                            });
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
    await smartWriteWithVersioning('graph.json', { _v: VERSION, _ts: ts, nodes, edges, stats }, meshDir, { compress: true });
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
