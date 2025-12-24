/**
 * L5 Data Quality Monitor V1.0
 * Phase B.8: User Understanding Infrastructure
 * 
 * Generates statistics on data quality for Phase B.8 metrics
 * 
 * Usage:
 *   node scripts/l5/data-quality-monitor.js data/entities.json
 */

import fs from 'fs';

/**
 * Calculate fill rates for Phase B.8 fields
 */
function calculateFillRates(entities) {
    const total = entities.length;

    // Core technical fields
    const stats = {
        params_billions: 0,
        context_length: 0,
        architecture: 0,
        quantizations: 0,
        benchmarks: 0,
        example_code: 0,
        is_commercial: 0,
        meta_extended: 0
    };

    // Relations stats
    let totalRelations = 0;
    let entitiesWithRelations = 0;
    let entitiesWithMinRelations = 0; // ≥3 relations

    for (const entity of entities) {
        // Direct fields
        if (entity.params_billions) stats.params_billions++;
        if (entity.context_length) stats.context_length++;
        if (entity.architecture) stats.architecture++;

        // Parse meta_json
        let meta = entity.meta_json;
        if (typeof meta === 'string') {
            try { meta = JSON.parse(meta); }
            catch { meta = {}; }
        }

        const extended = meta?.extended || {};

        if (extended.quantizations?.length > 0) stats.quantizations++;
        if (extended.benchmarks && Object.keys(extended.benchmarks).length > 0) stats.benchmarks++;
        if (extended.example_code) stats.example_code++;
        if (extended.is_commercial !== undefined) stats.is_commercial++;
        if (Object.keys(extended).length > 0) stats.meta_extended++;

        // Relations
        const relCount = entity.relations_count || 0;
        if (relCount > 0) {
            totalRelations += relCount;
            entitiesWithRelations++;
            if (relCount >= 3) entitiesWithMinRelations++;
        }
    }

    // Calculate percentages
    const fillRates = {};
    for (const [key, count] of Object.entries(stats)) {
        fillRates[key] = {
            count,
            percentage: ((count / total) * 100).toFixed(1) + '%'
        };
    }

    return {
        total_entities: total,
        fill_rates: fillRates,
        relations: {
            total_relations: totalRelations,
            entities_with_relations: entitiesWithRelations,
            entities_with_min_relations: entitiesWithMinRelations,
            avg_relations: (totalRelations / total).toFixed(2),
            min_relations_coverage: ((entitiesWithMinRelations / total) * 100).toFixed(1) + '%'
        }
    };
}

/**
 * Generate Phase B.8 quality report
 */
function generateReport(entities) {
    const stats = calculateFillRates(entities);

    console.log('\n══════════════════════════════════════════════════════════');
    console.log('📊 Phase B.8 User Understanding Infrastructure - Data Quality');
    console.log('══════════════════════════════════════════════════════════\n');

    console.log(`📦 Total Entities: ${stats.total_entities}\n`);

    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│ Phase 1: Technical Fields                               │');
    console.log('├───────────────────────────────┬───────────┬─────────────┤');
    console.log('│ Field                         │ Count     │ Fill Rate   │');
    console.log('├───────────────────────────────┼───────────┼─────────────┤');

    const p1Fields = ['params_billions', 'context_length', 'architecture'];
    for (const field of p1Fields) {
        const data = stats.fill_rates[field];
        console.log(`│ ${field.padEnd(29)} │ ${String(data.count).padEnd(9)} │ ${data.percentage.padEnd(11)} │`);
    }
    console.log('└───────────────────────────────┴───────────┴─────────────┘\n');

    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│ Phase 2: Knowledge Injection                            │');
    console.log('├───────────────────────────────┬───────────┬─────────────┤');

    const p2Fields = ['quantizations', 'benchmarks', 'example_code'];
    for (const field of p2Fields) {
        const data = stats.fill_rates[field];
        console.log(`│ ${field.padEnd(29)} │ ${String(data.count).padEnd(9)} │ ${data.percentage.padEnd(11)} │`);
    }
    console.log('└───────────────────────────────┴───────────┴─────────────┘\n');

    console.log('┌─────────────────────────────────────────────────────────┐');
    console.log('│ Phase 3: Knowledge Relations                            │');
    console.log('├───────────────────────────────┬─────────────────────────┤');
    console.log(`│ Total Relations               │ ${String(stats.relations.total_relations).padEnd(23)} │`);
    console.log(`│ Entities with Relations       │ ${String(stats.relations.entities_with_relations).padEnd(23)} │`);
    console.log(`│ Entities with ≥3 Relations    │ ${String(stats.relations.entities_with_min_relations).padEnd(23)} │`);
    console.log(`│ Avg Relations per Entity      │ ${stats.relations.avg_relations.padEnd(23)} │`);
    console.log(`│ ≥3 Relations Coverage         │ ${stats.relations.min_relations_coverage.padEnd(23)} │`);
    console.log('└───────────────────────────────┴─────────────────────────┘\n');

    // Summary
    const targets = {
        params_billions: 40,
        context_length: 30,
        architecture: 30,
        min_relations: 50
    };

    console.log('📋 Phase B.8 Target Status:');
    const paramRate = parseFloat(stats.fill_rates.params_billions.percentage);
    const relRate = parseFloat(stats.relations.min_relations_coverage);

    console.log(`   params_billions: ${paramRate >= targets.params_billions ? '✅' : '⏳'} ${stats.fill_rates.params_billions.percentage} (target: ${targets.params_billions}%)`);
    console.log(`   ≥3 relations:    ${relRate >= targets.min_relations ? '✅' : '⏳'} ${stats.relations.min_relations_coverage} (target: ${targets.min_relations}%)`);

    return stats;
}

/**
 * Main execution
 */
async function main() {
    const args = process.argv.slice(2);
    const inputPath = args[0] || 'data/entities.json';

    console.log('📊 L5 Data Quality Monitor V1.0');
    console.log(`📄 Input: ${inputPath}`);

    if (!fs.existsSync(inputPath)) {
        console.error('❌ Input file not found:', inputPath);
        process.exit(1);
    }

    const entities = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
    const stats = generateReport(entities);

    // Save stats to JSON
    const outputPath = inputPath.replace('.json', '_quality_stats.json');
    fs.writeFileSync(outputPath, JSON.stringify(stats, null, 2));
    console.log(`\n✅ Stats saved to: ${outputPath}`);
}

main().catch(err => {
    console.error('❌ Quality monitoring failed:', err);
    process.exit(1);
});
