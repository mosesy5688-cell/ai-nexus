/**
 * V4.3.2 Data Population Script
 * 
 * Populates model_benchmarks and model_specs tables using adapter data.
 * To be run as a one-time migration or scheduled job.
 * 
 * Usage: node scripts/populate-v432-data.js
 */

import { OpenLLMLeaderboardAdapter } from './ingestion/adapters/openllm-adapter.js';
import { DeepSpecAdapter } from './ingestion/adapters/deepspec-adapter.js';
import { SemanticScholarAdapter } from './ingestion/adapters/semanticscholar-adapter.js';

const DRY_RUN = true; // Set to false to actually write to D1

async function main() {
    console.log('====================================');
    console.log('V4.3.2 Data Population Script');
    console.log('====================================');
    console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

    // 1. Fetch Benchmarks
    console.log('📊 Step 1: Fetching benchmark data...');
    const openllm = new OpenLLMLeaderboardAdapter();
    const benchmarks = await openllm.fetch({ limit: 15 });
    console.log(`   Got ${benchmarks.length} benchmark records\n`);

    // 2. Fetch Deep Specs
    console.log('🔧 Step 2: Fetching model specs...');
    const deepspec = new DeepSpecAdapter();
    const specs = await deepspec.fetch({ limit: 10 });
    console.log(`   Got ${specs.length} spec records\n`);

    // 3. Fetch Citations
    console.log('📚 Step 3: Fetching citation data...');
    const s2 = new SemanticScholarAdapter();
    const citations = await s2.fetch({});
    console.log(`   Got ${citations.length} citation records\n`);

    // 4. Generate SQL Statements
    console.log('📝 Step 4: Generating SQL statements...\n');

    // Benchmark INSERT statements
    console.log('-- model_benchmarks INSERT statements');
    for (const b of benchmarks) {
        const sql = `INSERT OR REPLACE INTO model_benchmarks (umid, source, mmlu, humaneval, truthfulqa, hellaswag, arc_challenge, winogrande, gsm8k, avg_score, quality_flag, eval_meta) VALUES ('${b.normalized_name}', '${b.source}', ${b.mmlu}, ${b.humaneval}, ${b.truthfulqa}, ${b.hellaswag}, ${b.arc_challenge}, ${b.winogrande}, ${b.gsm8k}, ${b.avg_score}, '${b.quality_flag}', '${b.eval_meta.replace(/'/g, "''")}');`;
        console.log(sql);
    }

    console.log('\n-- model_specs INSERT statements');
    for (const s of specs) {
        if (!s) continue;
        const sql = `INSERT OR REPLACE INTO model_specs (umid, params_billions, context_length, vocab_size, hidden_size, num_layers, architecture, architecture_family, deploy_score) VALUES ('${s.normalized_name}', ${s.params_billions}, ${s.context_length}, ${s.vocab_size || 'NULL'}, ${s.hidden_size || 'NULL'}, ${s.num_layers || 'NULL'}, '${s.architecture || ''}', '${s.architecture_family}', ${s.deploy_score});`;
        console.log(sql);
    }

    console.log('\n-- model_citations INSERT statements');
    for (const c of citations) {
        const sql = `INSERT OR REPLACE INTO model_citations (umid, paper_id, title, citation_count, influential_citation_count, source) VALUES ('${c.model_family || 'unknown'}', '${c.paper_id}', '${c.title.replace(/'/g, "''")}', ${c.citation_count}, ${c.influential_citation_count}, '${c.source}');`;
        console.log(sql);
    }

    // Summary
    console.log('\n====================================');
    console.log('Summary:');
    console.log(`   Benchmarks: ${benchmarks.length} records`);
    console.log(`   Specs: ${specs.length} records`);
    console.log(`   Citations: ${citations.length} records`);
    console.log('====================================');

    if (DRY_RUN) {
        console.log('\n⚠️ DRY RUN mode - no data written to D1');
        console.log('Set DRY_RUN = false to execute');
    }
}

main().catch(console.error);
