const fs = require('fs');
const path = require('path');

// STRICT CONSTITUTIONAL LIMIT: 250 Lines (Art 1.4)
const MAX_LINES = 250;

// IGNORE LISTS (Requires Explicit User Approval for additions)
const IGNORE_DIRS = ['node_modules', '.git', 'dist', '.wrangler', '.astro', 'coverage'];

// LEGACY WHITELIST (Approved by User Step 2099)
const IGNORE_FILES = [
    // Tier 1: Stable Adapters (Infrastructure)
    'arxiv-adapter.js', 'base-adapter.js', 'datasets-adapter.js', 'deepspec-adapter.js',
    'github-adapter.js', 'huggingface-adapter.js', 'modelscope-adapter.js',
    'ollama-adapter.js', 'openllm-adapter.js', 'pwc-adapter.js',
    'semanticscholar-adapter.js', 'huggingface-papers-adapter.js', // V6.2
    'civitai-adapter.js', // V6.2 - Stable adapter
    'fetch-data.js', 'multi-source-fetcher.js',

    // Tier 1: Legacy Test
    'frontend-guardian.js',

    // Tier 2: Complex Visualization Components
    'GraphExplorer.astro', 'NeuralGraphExplorer.astro',
    'FamilyTree.astro', 'ArchitectureModule.astro'
];

const CHECK_EXTS = ['.ts', '.tsx', '.js', '.cjs', '.mjs', '.astro'];

function walk(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        if (IGNORE_DIRS.includes(file)) continue;
        if (IGNORE_FILES.includes(file)) continue;

        // Ignore temp files (Approved exclusion for non-source)
        if (file.startsWith('temp_')) continue;

        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
            walk(filePath, fileList);
        } else {
            const ext = path.extname(file);
            if (CHECK_EXTS.includes(ext)) {
                fileList.push(filePath);
            }
        }
    }
    return fileList;
}

console.log('🛡️  Running CES Check (Strict 250 Lines)...');
const files = walk('.');
let violations = 0;

for (const file of files) {
    try {
        const content = fs.readFileSync(file, 'utf-8');
        const lines = content.split('\n').length;

        if (lines > MAX_LINES) {
            console.error(`❌ VIOLATION: ${file} has ${lines} lines (Limit: ${MAX_LINES})`);
            violations++;
        }
    } catch (e) {
        console.warn(`⚠️  Could not read ${file}: ${e.message}`);
    }
}

if (violations > 0) {
    console.error(`\n🚫 CES Check FAILED: ${violations} files exceed strict line limit.`);
    console.error('ACTION REQUIRED: Refactor these files OR Request User Approval to whitelist stable modules.');
    process.exit(1);
} else {
    console.log('\n✅ CES Check Passed: All files comply with Art 1.4 modularity.');
}
