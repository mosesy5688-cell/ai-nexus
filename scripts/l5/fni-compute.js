/**
 * L5 FNI Compute Script - V16.5 Consolidated
 * CES Compliant (Art 5.1): Split into modules to stay under 250 lines.
 */
import fs from 'fs';
import path from 'path';
import * as percentile from './fni-percentile.js';
import { processBatches } from './fni-processor.js';

/** FNI Calculation Weights (V16.5 Official) */
const FNI_WEIGHTS = { popularity: 0.40, freshness: 0.35, mesh: 0.25 };

function calculateMeshImpact(entity) {
    // V16.5: Point-based Connectivity
    let points = 0;

    // Citations from Models: +1
    const modelRefs = entity.mesh_data?.referenced_by?.filter(id => id.startsWith('hf-model--')) || [];
    points += modelRefs.length * 1;

    // Citations from Papers: +3
    const paperRefs = entity.mesh_data?.referenced_by?.filter(id => id.startsWith('arxiv-paper--') || id.startsWith('s2-paper--')) || [];
    points += paperRefs.length * 3;

    // Inclusion in Collections (e.g., LangChain Hub, MCP): +5
    const collectionRefs = entity.mesh_data?.referenced_by?.filter(id => id.includes('collection') || id.includes('hub')) || [];
    points += collectionRefs.length * 5;

    return Math.min(100, points);
}

function calcCompleteness(entity) {
    let s = 0;
    const body = entity.body_content || entity.readme_content || entity.description || '';
    if (body.length > 500) s += 40;
    if (entity.meta_json?.params_billions || entity.params_billions || entity.size) s += 30;
    if (entity.tags?.length > 0) s += 15;
    if (entity.author && entity.author !== 'Community' && entity.author !== 'unknown') s += 15;
    return s;
}

function calcUtility(entity) {
    let s = 30; // Base
    const source = (entity.source || '').toLowerCase();
    const pipeline = entity.pipeline_tag || entity.meta_json?.pipeline_tag;
    if (source.includes('ollama') || pipeline) s += 40;
    if (entity.spaces_count > 0 || entity.has_demo || (entity.mesh_data?.referenced_by?.length > 0)) s += 30;
    return Math.min(100, s);
}

function getSpaceHardwareBoost(entity) {
    const hardware = (entity.runtime?.hardware || 'cpu-basic').toLowerCase();
    if (hardware.includes('a100') || hardware.includes('h100')) return 20;
    if (hardware.includes('zerogpu') || hardware.includes('a10g')) return 15;
    if (hardware.includes('upgrade')) return 5;
    return 0;
}

export function calculateFNI(entity) {
    const id = entity.id || '';
    const type = entity.entity_type || entity.type || 'model';
    const source = (entity.source || '').toLowerCase();
    const ONE_DAY = 86400000;

    // 1. Popularity (P) - Spec V16.5 Logic with Source Anchors
    let rawPop = 0;
    let anchor = 7.0; // Default 10M log scale

    if (id.startsWith('hf-model--') || id.startsWith('hf-dataset--')) {
        rawPop = (entity.likes || 0) + ((entity.downloads || 0) * 0.01);
        anchor = 6.0; // 1M anchor
    } else if (id.startsWith('gh-agent--') || id.startsWith('gh-tool--')) {
        rawPop = (entity.stars || entity.likes || 0) + ((entity.forks || 0) * 2);
        anchor = 4.47; // 30k stars anchor
    } else if (id.startsWith('arxiv-paper--') || id.startsWith('s2-paper--')) {
        rawPop = (entity.citations || entity.likes || 0);
        anchor = 3.0; // 1k cites anchor
    } else if (type === 'prompt' || source.includes('langchain') || source.includes('mcp')) {
        // Ecosystems: (likes * 20) + downloads (Base 25)
        rawPop = 25 + ((entity.likes || entity.stars || 0) * 20) + (entity.downloads || 0);
        anchor = 7.0;
    } else if (type === 'space') {
        rawPop = (entity.likes || 0) * 2;
        anchor = 5.0; // 100k anchor for spaces
    }

    let scoreP = (Math.log10(rawPop + 1) / anchor) * 100;
    if (type === 'prompt' || source.includes('langchain') || source.includes('mcp')) {
        scoreP = Math.max(25, scoreP);
    }

    // 2. Freshness (F)
    const lastUpdate = entity.last_modified || entity.last_updated || entity.published_date || entity._updated || new Date();
    const daysSinceUpdate = (Date.now() - new Date(lastUpdate).getTime()) / ONE_DAY;
    const decayFactor = Math.exp(-0.01 * (isNaN(daysSinceUpdate) ? 30 : daysSinceUpdate));
    let scoreF = 100 * decayFactor;
    if (daysSinceUpdate < 7) scoreF *= 1.2;

    // 3. Mesh Connectivity (M)
    const scoreM = calculateMeshImpact(entity);

    // 4. Vitality Score (Section 1)
    const vitality = (scoreP * FNI_WEIGHTS.popularity) + (scoreF * FNI_WEIGHTS.freshness) + (scoreM * FNI_WEIGHTS.mesh);

    // 5. System Blending (Spec V16.5 Section 2.D)
    let Sc = calcCompleteness(entity);
    let Su = calcUtility(entity);
    let finalScore = vitality;

    if (type === 'model' || type === 'agent') {
        // Spec 2.D: 70% Vitality (Sp shortcut) + 15% Comp + 15% Util
        finalScore = (vitality * 0.70) + (Sc * 0.15) + (Su * 0.15);
    } else if (type === 'tool' || type === 'prompt') {
        // Spec 2.D: 85% Vitality + 15% Comp
        finalScore = (vitality * 0.85) + (Sc * 0.15);
    } else if (type === 'space') {
        // Space Appendix Logic: (Sp + Hardware) * kStatus
        const hardwareBoost = getSpaceHardwareBoost(entity);
        let statusScore = scoreP + hardwareBoost;

        const runtime = entity.runtime || {};
        const stage = (runtime.stage || 'STOPPED').toUpperCase();
        const kStatus = (stage === 'RUNNING' || stage === 'APP_STARTING') ? 1.0 : (stage === 'SLEEPING' ? 0.5 : (stage === 'BUILDING' ? 0.1 : 0));
        finalScore = statusScore * kStatus;
    }

    return {
        fni_score: Math.min(100, Math.round(finalScore)),
        fni_breakdown: { P: Math.round(scoreP), F: Math.round(scoreF), M: Math.round(scoreM), C: Math.round(Sc), U: Math.round(Su) }
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
