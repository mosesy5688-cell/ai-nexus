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
import { smartWriteWithVersioning } from './smart-writer.js';
import { extractEntityRelations } from './relation-extractors.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { buildRelationsGraphFromFilesFFI, buildRelationsGraphFFI } from './rust-bridge.js';

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
export async function generateRelations(shardReader, outputDir = './output') {
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
        const { autoDecompress } = await import('./zstd-helper.js');
        for (const file of reportFiles) {
            if (file.endsWith('.json') || file.endsWith('.json.gz') || file.endsWith('.json.zst')) {
                let data = await fs.readFile(path.join(dailyDir, file));
                data = await autoDecompress(data);
                const reportData = JSON.parse(data.toString('utf-8'));
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

    // V25.9: Streaming entity relation extraction
    await shardReader(async (entities) => {
        for (const entity of entities) {
            const id = entity.id || entity.slug;
            const type = entity.type || 'model';

            nodes[id] = { t: type, f: Math.round((entity.fni_score || 0) * 10) / 10 };

            const relations = extractEntityRelations(entity);
            for (const rel of relations) {
                allRelations.push(rel);
                counts[rel.relation_type] = (counts[rel.relation_type] || 0) + 1;

                if (!edges[rel.source_id]) edges[rel.source_id] = [];
                edges[rel.source_id].push([
                    rel.target_id, rel.relation_type,
                    Math.round((rel.confidence || 1) * 100)
                ]);
            }
        }
    }, { slim: true });

    // V26.5: Try Rust file-based graph building first (no V8 string limit)
    let rustResult = null;
    try {
        const { zstdCompress } = await import('./zstd-helper.js');
        const nodesPath = path.join(relationsDir, '_tmp-nodes.json.zst');
        const relsPath = path.join(relationsDir, '_tmp-relations.json.zst');
        await fs.writeFile(nodesPath, await zstdCompress(JSON.stringify(nodes)));
        await fs.writeFile(relsPath, await zstdCompress(JSON.stringify(allRelations)));
        rustResult = buildRelationsGraphFromFilesFFI(nodesPath, relsPath, relationsDir);
        await fs.unlink(nodesPath).catch(() => {});
        await fs.unlink(relsPath).catch(() => {});
    } catch (e) { console.warn(`[RELATIONS] Rust file FFI skipped (${e.message}).`); }
    if (!rustResult) {
        try { rustResult = buildRelationsGraphFFI(Buffer.from(JSON.stringify(nodes)), Buffer.from(JSON.stringify(allRelations))); }
        catch (e) { console.warn(`[RELATIONS] Rust Buffer FFI skipped (${e.message}). Using JS path.`); }
    }
    if (rustResult?.explicit_json && rustResult?.legacy_json) {
        await fs.writeFile(path.join(relationsDir, 'explicit.json.zst'), Buffer.from(rustResult.explicit_json));
        const legacyPath = path.join(cacheDir, 'relations.json.zst');
        await fs.writeFile(legacyPath, Buffer.from(rustResult.legacy_json));
        console.log(`  [RELATIONS] Rust FFI: ${rustResult.total_relations} relations`);
    } else {
        if (rustResult) console.warn(`[RELATIONS] Rust FFI returned incomplete result. Using JS path.`);
        // JS fallback: build reverse lookup + write
        // RISK-M2: Skip legacy reverse index if relation count exceeds V8 safe threshold
        const reverse = {};
        const skipLegacy = allRelations.length > 5_000_000;
        if (skipLegacy) console.warn(`  [RELATIONS] ${allRelations.length} relations exceeds 5M — skipping legacy reverse index to prevent V8 OOM`);
        for (const rel of allRelations) {
            if (!skipLegacy) {
                if (!reverse[rel.target_id]) reverse[rel.target_id] = [];
                reverse[rel.target_id].push({ source_id: rel.source_id, source_type: rel.source_type, relation_type: rel.relation_type, confidence: rel.confidence || 1.0 });
            }
            if (!nodes[rel.target_id]) nodes[rel.target_id] = { t: rel.target_type || 'concept', f: 0 };
        }
        const v2Output = { _v: '14.5.2', _ts: new Date().toISOString(), _count: allRelations.length, _stats: counts, nodes, edges };
        await smartWriteWithVersioning('relations/explicit.json', v2Output, cacheDir, { compress: true });
        if (!skipLegacy) {
            const legacyOutput = { relations: allRelations, reverse_lookup: reverse, stats: counts, _count: allRelations.length, _generated: new Date().toISOString() };
            await smartWriteWithVersioning('relations.json', legacyOutput, cacheDir, { compress: true });
        }
    }

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
        const { autoDecompress } = await import('./zstd-helper.js');
        const raw = await fs.readFile(entitiesPath);
        const entities = JSON.parse((await autoDecompress(raw)).toString('utf-8'));
        await generateRelations(Array.isArray(entities) ? entities : entities.entities || [], outputDir);
    } catch (error) {
        console.error('[RELATIONS] Error:', error.message);
        process.exit(1);
    }
}
