/**
 * Relations Generator V14.5.2
 * SPEC: SPEC-KNOWLEDGE-V14.5.2
 * Constitution: Art 4.4 (Cross-Entity Ranking), Art 5.1 (< 250 lines)
 * 
 * Generates relations.json for frontend knowledge linking.
 * Outputs: explicit.json (V14.5.2) + relations.json (legacy)
 */

import fs from 'fs/promises';
import path from 'path';
import { extractEntityRelations } from './relation-extractors.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';

// Relation statistics template
const RELATION_STATS = {
    BASED_ON: 0, TRAINED_ON: 0, CITES: 0, IMPLEMENTS: 0,
    USES: 0, DEMO_OF: 0, STACK: 0, DEP: 0,
    FEATURES: 0, TRENDING: 0, EXPLAIN: 0, FOLLOWS: 0
};

/**
 * Generate relations.json for frontend knowledge linking
 * Outputs both V14.5.2 adjacency list and legacy format
 */
export async function generateRelations(entities, outputDir = './output') {
    console.log('[RELATIONS V14.5.2] Extracting entity relations...');

    const cacheDir = path.join(outputDir, 'cache');
    const relationsDir = path.join(cacheDir, 'relations');
    await fs.mkdir(relationsDir, { recursive: true });

    const allRelations = [];
    const counts = { ...RELATION_STATS };
    const nodes = {};
    const edges = {};

    const HUB_NODES = ['concept--trending-now', 'concept--daily-highlights', 'concept--agentic-ai'];
    for (const hubId of HUB_NODES) {
        nodes[hubId] = { t: 'concept', f: 10.0, hub: true };
    }

    // V15: Inject Daily Reports (Time Dimension)
    try {
        const dailyDir = path.join(outputDir, 'daily');
        const reportFiles = await fs.readdir(dailyDir).catch(() => []);
        for (const file of reportFiles) {
            if (file.endsWith('.json')) {
                const reportData = JSON.parse(await fs.readFile(path.join(dailyDir, file)));
                if (reportData.id) {
                    const rId = `report--${reportData.id}`;
                    nodes[rId] = { t: 'report', f: 5.0, title: reportData.title, day: reportData.id };

                    // Link report to highlights
                    if (reportData.highlights) {
                        for (const h of reportData.highlights) {
                            const hType = h.type || 'model';
                            const hSource = getNodeSource(h.id, hType);
                            const hId = normalizeId(h.id, hSource, hType);
                            allRelations.push({
                                source_id: rId, source_type: 'report',
                                target_id: hId, target_type: hType,
                                relation_type: 'FEATURES', confidence: 1.0
                            });
                        }
                    }
                }
            }
        }

        // V15: Link sequential reports (FOLLOWS)
        const sortedReports = Object.values(nodes)
            .filter(n => n.t === 'report')
            .sort((a, b) => b.day.localeCompare(a.day)); // Newest first

        for (let i = 0; i < sortedReports.length - 1; i++) {
            const nextDay = sortedReports[i + 1].day;
            allRelations.push({
                source_id: sortedReports[i].id || `report--${sortedReports[i].day}`,
                source_type: 'report',
                target_id: sortedReports[i + 1].id || `report--${nextDay}`,
                target_type: 'report',
                relation_type: 'FOLLOWS',
                confidence: 1.0
            });
        }
    } catch (e) {
        console.warn('  [RELATIONS] Could not inject daily reports into graph:', e.message);
    }

    // Extract relations from each entity
    for (const entity of entities) {
        const id = entity.id || entity.slug;
        const type = entity.type || 'model';

        nodes[id] = { t: type, f: Math.round((entity.fni_score || 0) * 10) / 10 };

        const relations = extractEntityRelations(entity);
        for (const rel of relations) {
            allRelations.push(rel);
            counts[rel.relation_type] = (counts[rel.relation_type] || 0) + 1;

            // Build adjacency list
            if (!edges[rel.source_id]) edges[rel.source_id] = [];
            edges[rel.source_id].push([
                rel.target_id,
                rel.relation_type,
                Math.round((rel.confidence || 1) * 100)
            ]);
        }
    }

    // Build reverse lookup
    const reverse = {};
    for (const rel of allRelations) {
        if (!reverse[rel.target_id]) reverse[rel.target_id] = [];
        reverse[rel.target_id].push({
            source_id: rel.source_id,
            source_type: rel.source_type,
            relation_type: rel.relation_type,
            confidence: rel.confidence || 1.0
        });

        // Ensure target node exists in nodes map
        if (!nodes[rel.target_id]) {
            nodes[rel.target_id] = { t: rel.target_type || 'concept', f: 0 };
        }
    }

    // V14.5.2 Output
    const v2Output = {
        _v: '14.5.2',
        _ts: new Date().toISOString(),
        _count: allRelations.length,
        _stats: counts,
        nodes,
        edges,
    };

    // Legacy output
    const legacyOutput = {
        relations: allRelations,
        reverse_lookup: reverse,
        stats: counts,
        _count: allRelations.length,
        _generated: new Date().toISOString(),
    };

    // Write both formats
    await fs.writeFile(path.join(relationsDir, 'explicit.json'), JSON.stringify(v2Output));
    await fs.writeFile(path.join(cacheDir, 'relations.json'), JSON.stringify(legacyOutput));

    console.log(`  [RELATIONS] ${allRelations.length} relations extracted`);
    for (const [type, count] of Object.entries(counts)) {
        if (count > 0) console.log(`    - ${type}: ${count}`);
    }

    return { relationCounts: counts, totalRelations: allRelations.length };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const entitiesPath = process.argv[2] || './output/entities.json';
    const outputDir = process.argv[3] || './output';

    try {
        const data = await fs.readFile(entitiesPath);
        const entities = JSON.parse(data);
        await generateRelations(Array.isArray(entities) ? entities : entities.entities || [], outputDir);
    } catch (error) {
        console.error('[RELATIONS] Error:', error.message);
        process.exit(1);
    }
}
