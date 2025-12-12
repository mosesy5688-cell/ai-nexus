// Quick CivitAI test
import { CivitAIAdapter } from './ingestion/adapters/civitai-adapter.js';

const adapter = new CivitAIAdapter();
console.log('Testing CivitAI Adapter...');
console.log('========================');

try {
    const models = await adapter.fetch({ limit: 3 });
    console.log(`\nFetched: ${models.length} models\n`);

    for (const m of models) {
        console.log('---');
        console.log('Name:', m.name);
        console.log('Type:', m.type);
        console.log('NSFW flag:', m.nsfw);

        const isSafe = adapter.isSafeForWork(m);
        console.log('Safety Check:', isSafe ? '✅ PASSED' : '❌ BLOCKED');

        // Test normalization
        const normalized = adapter.normalize(m);
        console.log('Normalized ID:', normalized.id);
        console.log('Source URL:', normalized.source_url);
    }

    console.log('\n✅ CivitAI Test Complete');
} catch (e) {
    console.error('❌ Error:', e.message);
}
