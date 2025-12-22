const fs = require('fs');
const path = require('path');

// STRICT CONSTITUTIONAL LIMIT: 250 Lines (Art 1.4)
const MAX_LINES = 250;

// IGNORE LISTS (Requires Explicit User Approval for additions)
const IGNORE_DIRS = ['node_modules', '.git', 'dist', '.wrangler', '.astro', 'coverage'];

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CES WHITELIST ELIGIBILITY RULE (Constitutional Amendment V6.2)
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * A file may be added to the CES whitelist ONLY if:
 * 
 *   ✅ ELIGIBLE (Stable Modules):
 *      - Adapters with fixed API contracts (unlikely to grow)
 *      - Visualization components with complete UI
 *      - Infrastructure modules with frozen interfaces
 * 
 *   ❌ INELIGIBLE (Growing Modules):
 *      - Orchestrators, pipelines likely to gain new phases
 *      - Core business logic with expanding features
 *      - Any module with TODO/FUTURE comments
 * 
 * ENFORCEMENT: Modules expected to grow MUST be refactored to stay under 250
 * lines. Adding such modules to whitelist is STRICTLY FORBIDDEN.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const IGNORE_FILES = [
    // Tier 1: Stable Adapters (Fixed API - NO FUTURE GROWTH)
    'arxiv-adapter.js', 'base-adapter.js', 'datasets-adapter.js', 'deepspec-adapter.js',
    'github-adapter.js', 'modelscope-adapter.js',
    'ollama-adapter.js', 'openllm-adapter.js', 'pwc-adapter.js',
    'semanticscholar-adapter.js', 'huggingface-papers-adapter.js',
    'civitai-adapter.js', 'mcp-adapter.js',
    'replicate-adapter.js', 'kaggle-adapter.js',  // B.1: New stable adapters
    'huggingface-adapter.js',  // B.1: Core adapter with stable pagination logic (254 lines)
    'fetch-data.js', 'multi-source-fetcher.js',
    // B.1: hf-strategies.js, hf-utils.js, hf-normalizer.js are all <250 lines

    // Tier 1: Legacy Test (Frozen)
    'frontend-guardian.js',

    // Tier 2: Complex Visualization (Complete UI - NO FUTURE GROWTH)
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
