// Test Deep Spec Adapter
import { DeepSpecAdapter } from './ingestion/adapters/deepspec-adapter.js';

const adapter = new DeepSpecAdapter();
console.log('Testing Deep Spec Adapter (V4.3.2)...');
console.log('=====================================');

try {
    // Test with specific popular models
    const testModels = [
        'meta-llama/Llama-3.1-8B-Instruct',
        'Qwen/Qwen2.5-7B-Instruct',
        'mistralai/Mistral-7B-Instruct-v0.3',
        'google/gemma-2-9b-it'
    ];

    const specs = await adapter.fetch({ modelIds: testModels });
    console.log(`\nExtracted: ${specs.length} model specs\n`);

    for (const s of specs) {
        console.log('---');
        console.log('Model:', s.model_id);
        console.log('Params:', s.params_billions, 'B');
        console.log('Context:', s.context_length);
        console.log('Architecture:', s.architecture_family);
        console.log('Deploy Score:', s.deploy_score);
    }

    console.log('\n✅ Deep Spec Adapter Test Complete');
} catch (e) {
    console.error('❌ Error:', e.message);
}
