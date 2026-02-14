// Mesh Graph Generator V16.4.3 - SPEC-KNOWLEDGE-MESH-V16.2

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';

const CONFIG = {
    EXPLICIT_PATH: './output/cache/relations/explicit.json.gz',
    KNOWLEDGE_LINKS_PATH: './output/cache/relations/knowledge-links.json.gz',
    REPORTS_INDEX_PATH: './output/cache/reports/index.json.gz',
    OUTPUT_DIR: './output/cache/mesh',
    VERSION: '16.2'
};



/**
 * Load JSON file safely
 */
async function loadJson(filePath) {
    try {
        let content = await fs.readFile(filePath);
        const isGzip = (content.length > 2 && content[0] === 0x1f && content[1] === 0x8b);
        if (filePath.endsWith('.gz') || isGzip) {
            const zlib = await import('zlib');
            try {
                content = zlib.gunzipSync(content);
            } catch (e) {
                if (!isGzip) {
                    console.warn(`[MESH-GRAPH] ⚠️ Fake .gz detected: ${filePath}. Parsing raw.`);
                } else throw e;
            }
        }
        return JSON.parse(content.toString('utf-8'));
    } catch (e) {
        // Try .gz fallback if not found
        if (!filePath.endsWith('.gz')) {
            try {
                let content = await fs.readFile(filePath + '.gz');
                const zlib = await import('zlib');
                content = zlib.gunzipSync(content);
                return JSON.parse(content.toString('utf-8'));
            } catch (e2) { }
        }
        console.warn(`  [WARN] Could not load ${filePath}: ${e.message}`);
        return null;
    }
}

/**
 * Standardize ID Wrapper
 */
function standardizeId(id, type) {
    const source = getNodeSource(id, type);
    return normalizeId(id, source, type);
}

/**
 * Extract node type from ID with v2.1 prefix standard
 */
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

/**
 * Generate unified mesh graph
 */
export async function generateMeshGraph(outputDir = './output') {
    console.log('[MESH-GRAPH V16.2] Generating 8-node mesh graph...');

    const meshDir = path.join(outputDir, 'cache', 'mesh');
    await fs.mkdir(meshDir, { recursive: true });

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

    // Generate graph.json (V16.6: Gzip via SmartWriter)
    const graph = {
        _v: CONFIG.VERSION,
        _ts: new Date().toISOString(),
        nodes,
        edges,
        stats
    };
    await smartWriteWithVersioning('graph.json', graph, meshDir, { compress: true });

    // Generate stats.json
    const statsOutput = {
        _v: CONFIG.VERSION,
        _ts: new Date().toISOString(),
        ...stats
    };

    await smartWriteWithVersioning('stats.json', statsOutput, meshDir, { compress: true });

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
