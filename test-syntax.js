import path from 'path';

const files = [
    './scripts/ingestion/adapters/langchain-adapter.js',
    './scripts/utils/id-normalizer.js',
    './scripts/factory/lib/fni-score.js',
    './scripts/l5/fni-compute.js',
    './src/utils/mesh-routing-core.js',
    './scripts/factory/mesh-profile-baker.js',
    './scripts/factory/lib/category-stats-generator.js',
    './scripts/factory/lib/rankings-generator.js',
    './scripts/factory/lib/trending-generator.js'
];

async function run() {
    let success = true;
    for (const f of files) {
        try {
            await import('file:///' + path.resolve(process.cwd(), f));
            console.log('✅ PASS:', f);
        } catch (e) {
            console.error('❌ FAIL:', f);
            console.error(e);
            success = false;
        }
    }
    process.exit(success ? 0 : 1);
}

run();
