/**
 * L5 FNI Compute Script - V16.5 Consolidated
 * CES Compliant (Art 5.1): Split into modules to stay under 250 lines.
 */
import fs from 'fs';
import path from 'path';
import * as percentile from './fni-percentile.js';
import { processBatches } from './fni-processor.js';

/** FNI Calculation Weights (V16.5) */
const FNI_WEIGHTS = { popularity: 0.40, freshness: 0.35, mesh: 0.25 };

function calculateMeshImpact(entity) {
    const inboundCount = entity.mesh_data?.referenced_by?.length || 0;
    return Math.min(100, inboundCount * 5);
}

export function calculateFNI(entity) {
    const type = entity.entity_type || entity.type || 'model';
    const ONE_DAY = 86400000;

    let rawPop = 0;
    if (type === 'model' || type === 'dataset' || type === 'prompt') {
        rawPop = (entity.likes || 0) + ((entity.downloads || 0) * 0.01);
    } else if (type === 'agent' || type === 'tool') {
        rawPop = (entity.stars || entity.likes || 0);
    } else if (type === 'paper') {
        rawPop = (entity.citations || entity.likes || 0);
    } else if (type === 'space') {
        rawPop = (entity.likes || 0) * 2;
    }
    const scoreP = Math.log10(rawPop + 1) * 20;

    const lastUpdate = entity.last_modified || entity.last_updated || entity.published_date || entity._updated;
    const daysSinceUpdate = (Date.now() - new Date(lastUpdate).getTime()) / ONE_DAY;
    const decayFactor = Math.exp(-0.01 * (isNaN(daysSinceUpdate) ? 30 : daysSinceUpdate));
    let scoreF = 100 * decayFactor;
    if (daysSinceUpdate < 7) scoreF *= 1.2;

    const scoreM = calculateMeshImpact(entity);
    let fni = (scoreP * FNI_WEIGHTS.popularity) + (scoreF * FNI_WEIGHTS.freshness) + (scoreM * FNI_WEIGHTS.mesh);

    if (type === 'space') {
        const runtime = entity.runtime || {};
        const stage = (runtime.stage || 'STOPPED').toUpperCase();
        const kStatus = stage === 'RUNNING' ? 1.0 : (stage === 'SLEEPING' ? 0.5 : (stage === 'BUILDING' ? 0.1 : 0));
        fni *= kStatus;
    }

    return {
        fni_score: Math.min(100, Math.round(fni)),
        fni_breakdown: { P: Math.round(scoreP), F: Math.round(scoreF), M: Math.round(scoreM) }
    };
}

export async function computeAllFNI(inputFile, outputDir) {
    if (!fs.existsSync(inputFile)) throw new Error(`Input file not found: ${inputFile}`);
    const allEntities = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    const FNI_ENTITY_TYPES = ['model', 'agent', 'paper', 'space', 'tool', 'dataset', 'prompt'];
    const entities = allEntities.filter(e => FNI_ENTITY_TYPES.includes(e.entity_type) || FNI_ENTITY_TYPES.includes(e.type));

    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const startTime = Date.now();
    const { results, totalBatches } = await processBatches(entities, outputDir, calculateFNI);

    const thresholds = percentile.calculatePercentileThresholds(results);
    const enriched = percentile.enrichWithPercentiles(results);

    fs.writeFileSync(path.join(outputDir, 'fni_summary.json'), JSON.stringify({
        total_entities: results.length, batches: totalBatches,
        percentile_thresholds: thresholds,
        top_10: [...results].sort((a, b) => b.fni_score - a.fni_score).slice(0, 10)
    }, null, 2));

    fs.writeFileSync(path.join(outputDir, 'fni_with_percentiles.json'), JSON.stringify(enriched, null, 2));
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    return { total_entities: results.length, batches: totalBatches, elapsed_seconds: parseFloat(elapsed) };
}

if (process.argv[1]?.includes('fni-compute')) {
    computeAllFNI(process.argv[2] || 'data/entities.json', process.argv[3] || 'data/computed')
        .then(s => console.log(`✅ FNI Complete: ${s.total_entities} entities, ${s.batches} batches, ${s.elapsed_seconds}s`))
        .catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
}

export default { computeAllFNI, calculateFNI };
