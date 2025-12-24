/**
 * L5 Benchmark Fusion Script V1.0
 * Phase B.8: User Understanding Infrastructure
 * 
 * Fuses OpenLLM benchmark data into entity meta.extended.benchmarks
 * 
 * Constitution V6.x: L5 Sidecar handles heavy compute (avoid L8 memory limits)
 * 
 * Usage:
 *   node scripts/l5/benchmark-fusion.js data/entities.json data/enriched.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    normalizeBenchmarkUMID,
    hfNameToCanonical,
    tryMatchBenchmark
} from '../benchmark-umid-normalizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Benchmark file paths
const BENCHMARKS_PATH = process.env.BENCH_PATH || path.join(__dirname, '../../public/cache/benchmarks.json');

/**
 * Load benchmarks from cache
 */
function loadBenchmarks() {
    try {
        if (!fs.existsSync(BENCHMARKS_PATH)) {
            console.log('⚠️ benchmarks.json not found, skipping fusion');
            return [];
        }
        const data = JSON.parse(fs.readFileSync(BENCHMARKS_PATH, 'utf8'));
        return data.data || [];
    } catch (e) {
        console.error('Failed to load benchmarks.json:', e.message);
        return [];
    }
}

/**
 * Build lookup maps for efficient matching
 */
function buildEntityMaps(entities) {
    const canonicalMap = new Map();
    const idMap = new Map();

    for (const entity of entities) {
        const id = entity.id || '';
        const canonicalName = (entity.canonical_name || entity.name || '').toLowerCase();

        if (id) idMap.set(id, entity);
        if (canonicalName) canonicalMap.set(canonicalName, entity);
    }

    return { canonicalMap, idMap };
}

/**
 * Extract benchmark scores from OpenLLM format
 */
function extractScores(benchmark) {
    const scores = {};

    // Common benchmark fields from OpenLLM Leaderboard
    if (benchmark.mmlu !== undefined) {
        scores.mmlu = {
            score: parseFloat(benchmark.mmlu) || 0,
            source: 'openllm',
            confidence: 'high'
        };
    }

    if (benchmark.gsm8k !== undefined) {
        scores.gsm8k = {
            score: parseFloat(benchmark.gsm8k) || 0,
            source: 'openllm',
            confidence: 'high'
        };
    }

    if (benchmark.human_eval !== undefined || benchmark.humaneval !== undefined) {
        scores.human_eval = {
            score: parseFloat(benchmark.human_eval || benchmark.humaneval) || 0,
            source: 'openllm',
            confidence: 'high'
        };
    }

    if (benchmark.arc !== undefined) {
        scores.arc = {
            score: parseFloat(benchmark.arc) || 0,
            source: 'openllm',
            confidence: 'high'
        };
    }

    if (benchmark.truthfulqa !== undefined) {
        scores.truthfulqa = {
            score: parseFloat(benchmark.truthfulqa) || 0,
            source: 'openllm',
            confidence: 'high'
        };
    }

    return Object.keys(scores).length > 0 ? scores : null;
}

/**
 * Fuse benchmarks into entities
 */
function fuseBenchmarks(entities, benchmarks) {
    const { canonicalMap, idMap } = buildEntityMaps(entities);

    let matched = 0;
    let unmatched = 0;

    for (const benchmark of benchmarks) {
        const matchResult = tryMatchBenchmark(benchmark, canonicalMap, idMap);

        if (matchResult) {
            const entity = matchResult.model;
            const scores = extractScores(benchmark);

            if (scores) {
                // Initialize meta structure if needed
                if (!entity.meta_json) entity.meta_json = {};
                if (typeof entity.meta_json === 'string') {
                    try {
                        entity.meta_json = JSON.parse(entity.meta_json);
                    } catch { entity.meta_json = {}; }
                }

                if (!entity.meta_json.extended) entity.meta_json.extended = {};

                // Merge benchmarks
                entity.meta_json.extended.benchmarks = {
                    ...entity.meta_json.extended.benchmarks,
                    ...scores
                };

                matched++;
            }
        } else {
            unmatched++;
        }
    }

    console.log(`📊 Benchmark Fusion: ${matched} matched, ${unmatched} unmatched`);
    return entities;
}

/**
 * Main execution
 */
async function main() {
    const args = process.argv.slice(2);
    const inputPath = args[0] || 'data/entities.json';
    const outputPath = args[1] || 'data/entities_with_benchmarks.json';

    console.log('🔗 L5 Benchmark Fusion V1.0');
    console.log(`📄 Input: ${inputPath}`);
    console.log(`📄 Output: ${outputPath}`);

    // Load entities
    if (!fs.existsSync(inputPath)) {
        console.error('❌ Input file not found:', inputPath);
        process.exit(1);
    }

    const entities = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    console.log(`📊 Loaded ${entities.length} entities`);

    // Load benchmarks
    const benchmarks = loadBenchmarks();
    console.log(`📊 Loaded ${benchmarks.length} benchmark records`);

    if (benchmarks.length === 0) {
        console.log('⚠️ No benchmarks to fuse, writing entities unchanged');
        fs.writeFileSync(outputPath, JSON.stringify(entities, null, 2));
        return;
    }

    // Fuse benchmarks
    const enrichedEntities = fuseBenchmarks(entities, benchmarks);

    // Write output
    fs.writeFileSync(outputPath, JSON.stringify(enrichedEntities, null, 2));
    console.log(`✅ Written to: ${outputPath}`);

    // Summary
    const withBenchmarks = enrichedEntities.filter(e =>
        e.meta_json?.extended?.benchmarks &&
        Object.keys(e.meta_json.extended.benchmarks).length > 0
    ).length;

    console.log(`📊 Summary: ${withBenchmarks}/${enrichedEntities.length} entities have benchmarks`);
}

main().catch(err => {
    console.error('❌ Benchmark fusion failed:', err);
    process.exit(1);
});
