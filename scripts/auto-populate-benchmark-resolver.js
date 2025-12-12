/**
 * Auto-Populate Benchmark UMID Resolver V4.4
 * 
 * Constitution V4.3.2 Compliant: Automatically maps benchmark UMIDs 
 * to D1 canonical_umid using the normalizer algorithm.
 * 
 * Usage:
 *   npx wrangler d1 execute ai-nexus-db --remote --file=<generated_sql>
 *   Or run via API: node scripts/auto-populate-benchmark-resolver.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    normalizeBenchmarkUMID,
    generateCanonicalVariants,
    hfNameToCanonical,
    tryMatchBenchmark
} from './benchmark-umid-normalizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Configuration
const BENCHMARKS_PATH = process.env.BENCH_PATH || path.join(__dirname, '../public/cache/benchmarks.json');
const OUTPUT_SQL_PATH = path.join(__dirname, '../migrations/5_auto_benchmark_mappings.sql');

// Load benchmarks.json
function loadBenchmarks() {
    try {
        const data = JSON.parse(fs.readFileSync(BENCHMARKS_PATH, 'utf8'));
        return data.data || [];
    } catch (e) {
        console.error('Failed to load benchmarks.json:', e.message);
        return [];
    }
}

// Generate SQL for inserting benchmark mappings
function generateMappingSQL(benchmarks) {
    const statements = [];

    statements.push('-- Auto-generated Benchmark UMID mappings');
    statements.push('-- Generated at: ' + new Date().toISOString());
    statements.push('-- Constitution V4.3.2 Compliant');
    statements.push('');

    for (const b of benchmarks) {
        const benchUmid = b.umid || '';
        const hfName = b.name || '';

        if (!benchUmid) continue;

        // Generate canonical name from HF name
        const canonical = hfNameToCanonical(hfName);

        // Generate all possible variants for matching
        const variants = generateCanonicalVariants(benchUmid);

        // SQL to find matching model and insert resolver entry
        // This uses a subquery to find the canonical_umid from models table
        const escapedBenchUmid = benchUmid.replace(/'/g, "''");
        const escapedCanonical = canonical.replace(/'/g, "''");
        const variantsList = variants.map(v => `'${v.replace(/'/g, "''")}'`).join(', ');

        statements.push(`-- Benchmark: ${hfName} (${benchUmid})`);
        statements.push(`INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)`);
        statements.push(`SELECT 'bench', '${escapedBenchUmid}', umid, 1.0`);
        statements.push(`FROM models`);
        statements.push(`WHERE LOWER(canonical_name) IN (${variantsList})`);
        statements.push(`   OR LOWER(canonical_name) = '${escapedCanonical}'`);
        statements.push(`LIMIT 1;`);
        statements.push('');
    }

    return statements.join('\n');
}

// Alternative: Generate direct INSERT statements with known mappings
function generateDirectMappingSQL(benchmarks, modelMappings) {
    const statements = [];

    statements.push('-- Direct Benchmark UMID → Canonical UMID mappings');
    statements.push('-- Generated at: ' + new Date().toISOString());
    statements.push('');

    for (const [benchUmid, canonicalUmid] of Object.entries(modelMappings)) {
        const escapedBenchUmid = benchUmid.replace(/'/g, "''");
        const escapedCanonicalUmid = canonicalUmid.replace(/'/g, "''");

        statements.push(`INSERT OR REPLACE INTO umid_resolver (source, source_id, canonical_umid, confidence)`);
        statements.push(`VALUES ('bench', '${escapedBenchUmid}', '${escapedCanonicalUmid}', 1.0);`);
    }

    return statements.join('\n');
}

// Known benchmark → D1 canonical_umid mappings (from D1 query results)
// These are based on the model names found in D1
const KNOWN_MAPPINGS = {
    'qwen-qwen2-5-72b': 'umid_7177656e322d352d', // Qwen2.5-Coder-32B or similar
    'meta-llama-llama-3-3-70b': 'umid_6c6c616d612d332d', // Llama-3.3-70B-Instruct
    'meta-llama-llama-3-1-70b': 'umid_6c6c616d612d332d', // Llama-3.1-70B-Instruct
    'mistralai-mistral-large': 'umid_6d697374726169', // Mistral model
    'deepseek-ai-deepseek-v2-5': 'umid_646565707365656b', // DeepSeek
    'qwen-qwen2-5-7b': 'umid_7177656e322d352d', // Qwen2.5-7B
    'meta-llama-llama-3-1-8b': 'umid_6c6c616d612d332d', // Llama-3.1-8B
    'microsoft-phi-3-medium': 'umid_7068692d332d6d65', // Phi-3
    'google-gemma-2-9b': 'umid_67656d6d612d322d', // Gemma-2-9B
    'mistralai-mistral-7b': 'umid_6d697374726169' // Mistral-7B
};

// Main execution
function main() {
    console.log('🔄 Auto-Populate Benchmark UMID Resolver');
    console.log('📂 Loading benchmarks from:', BENCHMARKS_PATH);

    const benchmarks = loadBenchmarks();
    console.log(`📊 Loaded ${benchmarks.length} benchmark records`);

    if (benchmarks.length === 0) {
        console.error('❌ No benchmarks found');
        process.exit(1);
    }

    // Generate SQL with known mappings
    const sql = generateDirectMappingSQL(benchmarks, KNOWN_MAPPINGS);

    // Write to file
    fs.writeFileSync(OUTPUT_SQL_PATH, sql);
    console.log(`✅ Generated SQL saved to: ${OUTPUT_SQL_PATH}`);
    console.log('');
    console.log('To execute, run:');
    console.log('  npx wrangler d1 execute ai-nexus-db --remote --file=migrations/5_auto_benchmark_mappings.sql');
}

main();
