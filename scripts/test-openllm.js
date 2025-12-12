// Test Open LLM Leaderboard Adapter
import { OpenLLMLeaderboardAdapter } from './ingestion/adapters/openllm-adapter.js';

const adapter = new OpenLLMLeaderboardAdapter();
console.log('Testing Open LLM Leaderboard Adapter...');
console.log('========================================');

try {
    const benchmarks = await adapter.fetch({ limit: 5 });
    console.log(`\nFetched: ${benchmarks.length} benchmark records\n`);

    for (const b of benchmarks) {
        console.log('---');
        console.log('Model:', b.model_name);
        console.log('Normalized:', b.normalized_name);
        console.log('MMLU:', b.mmlu, '| HellaSwag:', b.hellaswag);
        console.log('Average Score:', b.avg_score);
        console.log('Quality Flag:', b.quality_flag === 'ok' ? '✅ ok' : '⚠️ ' + b.quality_flag);
    }

    console.log('\n✅ Open LLM Leaderboard Adapter Test Complete');
} catch (e) {
    console.error('❌ Error:', e.message);
}
