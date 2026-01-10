/**
 * Knowledge Engine Builder - V15.0
 * SPEC: SPEC-KNOWLEDGE-REPORT-V15.0
 * 
 * Main entry point for Knowledge Engine.
 * Orchestrates: Concept extraction → Graph generation → Detail pages
 */

import { extractConcepts, getDiscoveryReport } from './concept-extract.js';
import { generateGraph } from './graph-gen.js';
import { generateConceptDetails } from './concept-detail.js';
import fs from 'fs/promises';
import path from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';

/**
 * Main builder function
 * @param {string} entitiesPath Path to entities.json
 */
export async function buildKnowledge(entitiesPath) {
    console.log('[KNOWLEDGE-ENGINE V15.0] Starting build...');
    const startTime = Date.now();

    // Load entities
    const data = await fs.readFile(entitiesPath, 'utf-8');
    const entities = JSON.parse(data);
    const entityList = Array.isArray(entities) ? entities : entities.entities || [];
    console.log(`  Loaded ${entityList.length} entities`);

    // Step 1: Extract concepts from tags
    const concepts = await extractConcepts(entityList);
    console.log(`  Extracted ${concepts.length} concepts`);

    // Step 2: Generate discovery report (new/unmapped concepts)
    const discovery = getDiscoveryReport(entityList, concepts);
    const discoveryPath = path.join(OUTPUT_DIR, 'knowledge', 'discovery.json');
    await fs.mkdir(path.dirname(discoveryPath), { recursive: true });
    await fs.writeFile(discoveryPath, JSON.stringify(discovery, null, 2));
    console.log(`  Discovery report: ${discovery.new_concepts.length} new concepts`);

    // Step 3: Generate graph.json
    const graph = await generateGraph(entityList, concepts);
    const graphPath = path.join(OUTPUT_DIR, 'knowledge', 'graph.json');
    await fs.writeFile(graphPath, JSON.stringify(graph));
    console.log(`  Graph: ${graph.nodes.length} nodes, ${graph.edges.length} edges`);

    // Step 4: Generate concept detail pages
    const detailCount = await generateConceptDetails(entityList, concepts, OUTPUT_DIR);
    console.log(`  Generated ${detailCount} concept detail files`);

    // Step 5: Generate index.json
    const index = concepts.map(c => ({
        slug: c.slug,
        name: c.name,
        count: c.count,
        category: c.category || 'general'
    })).sort((a, b) => b.count - a.count);
    const indexPath = path.join(OUTPUT_DIR, 'knowledge', 'index.json');
    await fs.writeFile(indexPath, JSON.stringify({ concepts: index, _ts: new Date().toISOString() }));

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[KNOWLEDGE-ENGINE V15.0] Complete in ${duration}s`);

    return { concepts: concepts.length, graph, discovery };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const entitiesPath = process.argv[2] || './output/entities.json';
    buildKnowledge(entitiesPath).catch(err => {
        console.error('[KNOWLEDGE-ENGINE] Error:', err.message);
        process.exit(1);
    });
}
