/**
 * L5 FNI Compute Script - V18.9 Singularity
 * CES Compliant (Art 5.1): Split into modules to stay under 250 lines.
 */
import fs from 'fs';
import path from 'path';
import * as percentile from './fni-percentile.js';
import { processBatches } from './fni-processor.js';

// V18.9: Source Parity Coefficients (Ks)
const SOURCE_COEFFICIENTS = { hf: 1.0, gh: 5.0, arxiv: 30.0, s2: 30.0, default: 0.2 };

// V18.9: Decay Tiers
const DECAY_TIERS = [
    { lambda: 0.002, types: ['model', 'tool', 'agent'] },
    { lambda: 0.005, types: ['dataset', 'collection', 'paper'] },
    { lambda: 0.025, types: ['prompt', 'space'] }
];

// V18.9: Relation Weights for Sm (synced with Ks)
function calculateMeshPoints(entity) {
    let points = 0;
    const refs = entity.mesh_data?.referenced_by || [];
    for (const id of refs) {
        if (id.startsWith('arxiv-') || id.startsWith('s2-')) points += 30;
        else if (id.startsWith('gh-')) points += 5;
        else if (id.includes('collection') || id.includes('hub')) points += 10;
        else points += 1;
    }
    // Also count explicit citation_count
    const citations = parseInt(entity.citations || entity.citation_count) || 0;
    if (citations > 0 && refs.length === 0) {
        const prefix = getSourcePrefix(entity.id || '');
        if (prefix === 'arxiv' || prefix === 's2') points += citations * 30;
        else if (prefix === 'gh') points += citations * 5;
        else points += citations;
    }
    return points;
}

function getSourcePrefix(id) {
    if (id.startsWith('hf-')) return 'hf';
    if (id.startsWith('gh-')) return 'gh';
    if (id.startsWith('arxiv-')) return 'arxiv';
    if (id.startsWith('s2-')) return 's2';
    return 'default';
}

function getDecayLambda(type) {
    for (const tier of DECAY_TIERS) {
        if (tier.types.includes(type)) return tier.lambda;
    }
    return 0.005;
}

function calcCompleteness(entity) {
    let s = 0;
    const type = entity.entity_type || entity.type || 'model';
    const body = entity.body_content || entity.readme_content || entity.description || '';
    if (body.length > 500) s += 40;
    if (type === 'paper') {
        if (entity.arxiv_id || entity.pdf_url || entity.source_url) s += 20;
        if (parseInt(entity.citations || entity.citation_count || entity.upvotes || entity.popularity) > 0) s += 10;
    } else {
        if (entity.meta_json?.params_billions || entity.params_billions || entity.size) s += 30;
    }
    if (entity.tags?.length > 0) s += 15;
    if (entity.author && entity.author !== 'Community' && entity.author !== 'unknown') s += 15;
    return s;
}

function calcUtility(entity) {
    let s = 30;
    const source = (entity.source || '').toLowerCase();
    const pipeline = entity.pipeline_tag || entity.meta_json?.pipeline_tag;
    if (source.includes('ollama') || pipeline) s += 40;
    if (entity.spaces_count > 0 || entity.has_demo || (entity.mesh_data?.referenced_by?.length > 0)) s += 30;
    return Math.min(100, s);
}

export function calculateFNI(entity) {
    const id = entity.id || '';
    const type = entity.entity_type || entity.type || 'model';

    // V18.9 Section 2: rawPop = Metrics × Ks
    const sourcePrefix = getSourcePrefix(id);
    const Ks = SOURCE_COEFFICIENTS[sourcePrefix] || SOURCE_COEFFICIENTS.default;
    let rawMetrics = 0;

    if (sourcePrefix === 'hf') {
        rawMetrics = (entity.likes || 0) + ((entity.downloads || 0) * 0.01);
    } else if (sourcePrefix === 'gh') {
        rawMetrics = (entity.stars || entity.likes || 0) + ((entity.forks || 0) * 2);
    } else if (sourcePrefix === 'arxiv' || sourcePrefix === 's2') {
        rawMetrics = (entity.citations || entity.likes || 0);
    } else {
        rawMetrics = ((entity.likes || entity.stars || 0) * 20) + (entity.downloads || 0);
    }
    const rawPop = rawMetrics * Ks;

    // Quality Correction Factor
    const Sc = calcCompleteness(entity);
    const Su = calcUtility(entity);

    // V18.9 Sp: Asymptotic Log Compressor (base 8)
    const logCompressed = 99.9 * (1 - Math.pow(10, -(Math.log10(rawPop + 1) / 8)));
    const qualityFactor = 1 + (Sc + Su) / 500;
    const Sp_base = Math.min(99.9, logCompressed * qualityFactor);

    // V18.9 Section 3: Sf - 3-tier Dynamic Decay
    const lambda = getDecayLambda(type);
    const lastUpdate = entity.last_modified || entity.last_updated || entity.published_date || entity._updated;
    // Null-Time Trap: 365-day penalty
    let days = 365;
    if (lastUpdate) {
        const parsed = new Date(lastUpdate).getTime();
        if (!isNaN(parsed)) days = Math.max(0, (Date.now() - parsed) / 86400000);
    }
    const Sf = 100 * Math.exp(-lambda * days);

    // Sp with freshness boost
    const Sp = Math.min(99.9, Sp_base * (1 + Sf / 500));

    // V18.9 Section 4: Sm - Asymptotic Gravity
    const meshPoints = calculateMeshPoints(entity);
    const Sm = 99.9 * (1 - Math.pow(10, -(Math.log10(meshPoints + 1) / 4)));

    // V18.9 Master Formula
    const fni = Math.min(99.9, (Sp * 0.45) + (Sf * 0.30) + (Sm * 0.25));

    return {
        fni_score: Math.round(fni * 10) / 10,
        raw_pop: Math.round(rawPop),
        fni_breakdown: {
            P: Math.round(Sp * 10) / 10,
            F: Math.round(Sf * 10) / 10,
            M: Math.round(Sm * 10) / 10,
            C: Math.round(Sc),
            U: Math.round(Su)
        }
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
