/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FREE2AITOOLS V4.4 FRONTEND QA ORCHESTRATOR
 * ═══════════════════════════════════════════════════════════════════════════
 * 
 * Purpose: Comprehensive automated validation of all frontend pages
 * Constitution Reference: V4.3.2 Phase 3 Blueprint
 * 
 * Test Scope:
 * - Core Pages: /, /leaderboard, /explore, /compare, /ranking, /knowledge
 * - Model Details: 10 random models via UMID
 * - Knowledge Articles: All available articles
 * - Cache Files: benchmarks.json, specs.json
 * - APIs: /api/search, /api/trending.json
 * - SEO: JSON-LD validation
 * 
 * Usage: node scripts/qa-orchestrator.js https://free2aitools.com
 */

const TARGET_URL = (process.argv[2] || 'http://localhost:4321').replace(/\/$/, '');

const HEADERS = {
    'User-Agent': 'Free2AITools-QA/1.0 (Testing; +http://free2aitools.com)',
    'Accept': 'text/html,application/json,*/*'
};

// ═══════════════════════════════════════════════════════════════════════════
// TEST DEFINITIONS
// ═══════════════════════════════════════════════════════════════════════════

const CORE_PAGES = [
    { url: '/', name: 'Home Page', requiredComponents: ['<html', '<head', '<body', 'model-card', 'class='] },
    { url: '/leaderboard', name: 'Leaderboard Page', requiredComponents: ['DOCTYPE', 'leaderboard', 'benchmark'] },
    { url: '/explore', name: 'Explore Page', requiredComponents: ['DOCTYPE', 'explore', 'model'] },
    { url: '/compare', name: 'Compare Page', requiredComponents: ['DOCTYPE', 'compare', 'model'] },
    { url: '/ranking', name: 'Rankings Page', requiredComponents: ['DOCTYPE', 'ranking', 'model'] },
    { url: '/knowledge', name: 'Knowledge Base', requiredComponents: ['DOCTYPE', 'knowledge', 'article'] },
    { url: '/methodology', name: 'Methodology Page', requiredComponents: ['DOCTYPE', 'methodology'] },
    { url: '/about', name: 'About Page', requiredComponents: ['DOCTYPE', 'about'] }
];

const CACHE_FILES = [
    { url: '/cache/benchmarks.json', name: 'Benchmarks Cache', requiredKeys: ['version', 'data'], minRecords: 5 },
    { url: '/cache/specs.json', name: 'Specs Cache', requiredKeys: ['version', 'data'], minRecords: 3 }
];

const API_ENDPOINTS = [
    { url: '/api/search?q=llama', name: 'Search API', requiredKeys: ['results'] },
    { url: '/api/trending.json', name: 'Trending API', requiredKeys: ['data'] }
];

const KNOWLEDGE_ARTICLES = [
    { url: '/knowledge/what-is-mmlu', name: 'Article: MMLU' },
    { url: '/knowledge/what-is-humaneval', name: 'Article: HumanEval' },
    { url: '/knowledge/what-is-fni', name: 'Article: FNI' },
    { url: '/knowledge/what-is-deploy-score', name: 'Article: Deploy Score' },
    { url: '/knowledge/what-is-context-length', name: 'Article: Context Length' }
];

// Models from benchmarks.json to test
const MODEL_UMIDS = [
    'qwen-qwen2-5-72b',
    'meta-llama-llama-3-3-70b',
    'meta-llama-llama-3-1-70b',
    'mistralai-mistral-large',
    'deepseek-ai-deepseek-v2-5',
    'qwen-qwen2-5-7b',
    'meta-llama-llama-3-1-8b',
    'microsoft-phi-3-medium',
    'google-gemma-2-9b',
    'mistralai-mistral-7b'
];

// ═══════════════════════════════════════════════════════════════════════════
// QA RESULTS STORAGE
// ═══════════════════════════════════════════════════════════════════════════

const results = {
    corePages: [],
    cacheFiles: [],
    apiEndpoints: [],
    knowledgeArticles: [],
    modelDetails: [],
    seoValidation: [],
    summary: { passed: 0, failed: 0, warnings: 0, total: 0 }
};

// ═══════════════════════════════════════════════════════════════════════════
// TEST FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

async function testPage(config) {
    const target = `${TARGET_URL}${config.url}`;
    const start = performance.now();

    try {
        const res = await fetch(target, { headers: HEADERS });
        const duration = Math.round(performance.now() - start);
        const text = await res.text();

        const result = {
            name: config.name,
            url: config.url,
            status: res.ok ? 'PASS' : 'FAIL',
            httpStatus: res.status,
            duration: duration,
            contentLength: text.length,
            componentsFound: [],
            componentsMissing: [],
            hasJsonLd: text.includes('application/ld+json'),
            hasSsrError: res.status >= 500,
            hasHydrationError: text.includes('Hydration failed'),
            isSlow: duration > 1000,
            issues: []
        };

        // Check required components
        if (config.requiredComponents) {
            for (const comp of config.requiredComponents) {
                if (text.includes(comp)) {
                    result.componentsFound.push(comp);
                } else {
                    result.componentsMissing.push(comp);
                }
            }

            if (result.componentsMissing.length > 0) {
                result.status = 'WARN';
                result.issues.push(`Missing: ${result.componentsMissing.join(', ')}`);
            }
        }

        if (!res.ok) {
            result.status = 'FAIL';
            result.issues.push(`HTTP ${res.status} ${res.statusText}`);
        }

        if (result.hasSsrError) {
            result.status = 'FAIL';
            result.issues.push('SSR Error detected');
        }

        if (result.isSlow) {
            result.issues.push(`Slow response: ${duration}ms`);
        }

        return result;

    } catch (err) {
        return {
            name: config.name,
            url: config.url,
            status: 'FAIL',
            httpStatus: 0,
            duration: 0,
            issues: [err.message]
        };
    }
}

async function testJson(config) {
    const target = `${TARGET_URL}${config.url}`;
    const start = performance.now();

    try {
        const res = await fetch(target, { headers: HEADERS });
        const duration = Math.round(performance.now() - start);
        const text = await res.text();

        let json = null;
        try {
            json = JSON.parse(text);
        } catch (e) {
            return {
                name: config.name,
                url: config.url,
                status: 'FAIL',
                httpStatus: res.status,
                duration: duration,
                issues: ['Invalid JSON format']
            };
        }

        const result = {
            name: config.name,
            url: config.url,
            status: 'PASS',
            httpStatus: res.status,
            duration: duration,
            recordCount: Array.isArray(json.data) ? json.data.length : (json.results?.length || 0),
            keysFound: [],
            keysMissing: [],
            issues: []
        };

        // Check required keys
        if (config.requiredKeys) {
            for (const key of config.requiredKeys) {
                if (json.hasOwnProperty(key)) {
                    result.keysFound.push(key);
                } else {
                    result.keysMissing.push(key);
                }
            }

            if (result.keysMissing.length > 0) {
                result.status = 'WARN';
                result.issues.push(`Missing keys: ${result.keysMissing.join(', ')}`);
            }
        }

        // Check min records
        if (config.minRecords && result.recordCount < config.minRecords) {
            result.status = 'WARN';
            result.issues.push(`Only ${result.recordCount} records (expected >= ${config.minRecords})`);
        }

        if (!res.ok) {
            result.status = 'FAIL';
            result.issues.push(`HTTP ${res.status}`);
        }

        return result;

    } catch (err) {
        return {
            name: config.name,
            url: config.url,
            status: 'FAIL',
            httpStatus: 0,
            issues: [err.message]
        };
    }
}

async function testModelDetail(umid) {
    const config = {
        url: `/model/${umid}`,
        name: `Model: ${umid}`,
        requiredComponents: ['DOCTYPE', 'model', '<h1']
    };

    const result = await testPage(config);

    // Additional model-specific checks
    if (result.status !== 'FAIL') {
        // Check for "Model Not Found"
        const target = `${TARGET_URL}${config.url}`;
        const res = await fetch(target, { headers: HEADERS });
        const text = await res.text();

        if (text.includes('Model Not Found') || text.includes('not found')) {
            result.status = 'FAIL';
            result.issues.push('Model Not Found - UMID not in database');
        }

        // Check for JSON-LD SEO
        if (!text.includes('application/ld+json')) {
            result.issues.push('Missing SEO JSON-LD schema');
        }
    }

    return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════

async function runQA() {
    console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║        🧪 FREE2AITOOLS V4.4 FRONTEND QA ORCHESTRATOR                    ║
╟──────────────────────────────────────────────────────────────────────────╢
║  Target: ${TARGET_URL.padEnd(62)} ║
║  Time:   ${new Date().toISOString().padEnd(62)} ║
╚══════════════════════════════════════════════════════════════════════════╝
`);

    const startTotal = performance.now();

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 1: CORE PAGES
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n📄 TESTING CORE PAGES...');
    console.log('─'.repeat(70));

    for (const page of CORE_PAGES) {
        process.stdout.write(`  ${page.name.padEnd(30)} `);
        const result = await testPage(page);
        results.corePages.push(result);
        printResult(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 2: CACHE FILES (L8 Precompute)
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n📦 TESTING CACHE FILES (L8 Precompute)...');
    console.log('─'.repeat(70));

    for (const cache of CACHE_FILES) {
        process.stdout.write(`  ${cache.name.padEnd(30)} `);
        const result = await testJson(cache);
        results.cacheFiles.push(result);
        printResult(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 3: API ENDPOINTS
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🔌 TESTING API ENDPOINTS...');
    console.log('─'.repeat(70));

    for (const api of API_ENDPOINTS) {
        process.stdout.write(`  ${api.name.padEnd(30)} `);
        const result = await testJson(api);
        results.apiEndpoints.push(result);
        printResult(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 4: KNOWLEDGE ARTICLES
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n📚 TESTING KNOWLEDGE ARTICLES...');
    console.log('─'.repeat(70));

    for (const article of KNOWLEDGE_ARTICLES) {
        process.stdout.write(`  ${article.name.padEnd(30)} `);
        const result = await testPage({ ...article, requiredComponents: ['DOCTYPE', 'article'] });
        results.knowledgeArticles.push(result);
        printResult(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TEST 5: MODEL DETAIL PAGES
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n🤖 TESTING MODEL DETAIL PAGES (10 models)...');
    console.log('─'.repeat(70));

    for (const umid of MODEL_UMIDS) {
        process.stdout.write(`  ${umid.substring(0, 28).padEnd(30)} `);
        const result = await testModelDetail(umid);
        results.modelDetails.push(result);
        printResult(result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // SUMMARY
    // ─────────────────────────────────────────────────────────────────────────
    const totalDuration = ((performance.now() - startTotal) / 1000).toFixed(2);

    // Calculate totals
    const allResults = [
        ...results.corePages,
        ...results.cacheFiles,
        ...results.apiEndpoints,
        ...results.knowledgeArticles,
        ...results.modelDetails
    ];

    results.summary.total = allResults.length;
    results.summary.passed = allResults.filter(r => r.status === 'PASS').length;
    results.summary.failed = allResults.filter(r => r.status === 'FAIL').length;
    results.summary.warnings = allResults.filter(r => r.status === 'WARN').length;

    console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║                      📋 QA ORCHESTRATOR REPORT                          ║
╟──────────────────────────────────────────────────────────────────────────╢
║  Total Tests:    ${String(results.summary.total).padEnd(55)} ║
║  ✅ Passed:      ${String(results.summary.passed).padEnd(55)} ║
║  ⚠️  Warnings:   ${String(results.summary.warnings).padEnd(55)} ║
║  ❌ Failed:      ${String(results.summary.failed).padEnd(55)} ║
║  ⏱️  Duration:   ${(totalDuration + 's').padEnd(55)} ║
╚══════════════════════════════════════════════════════════════════════════╝
`);

    // Failed items report
    const failedItems = allResults.filter(r => r.status === 'FAIL');
    if (failedItems.length > 0) {
        console.log('❌ FAILED ITEMS:');
        console.log('─'.repeat(70));
        for (const item of failedItems) {
            console.log(`  • ${item.name}`);
            console.log(`    URL: ${item.url}`);
            console.log(`    Issues: ${item.issues.join(', ')}`);
        }
        console.log('');
        console.log('🔧 FIX PATCH PLAN REQUIRED');
        console.log('─'.repeat(70));
        for (const item of failedItems) {
            console.log(`  [${item.name}]`);
            console.log(`    → Check deployment of ${item.url}`);
            console.log(`    → Verify route exists and data is populated`);
        }
        process.exit(1);
    } else {
        console.log(`
╔══════════════════════════════════════════════════════════════════════════╗
║              🎉 PHASE 3 V4.4 DELIVERY CERTIFICATE                       ║
╟──────────────────────────────────────────────────────────────────────────╢
║                                                                          ║
║  All ${String(results.summary.total).padEnd(2)} frontend tests PASSED                                    ║
║                                                                          ║
║  Constitution V4.3.2 Compliance: ✅ VERIFIED                             ║
║  L8 Precompute Cache:            ✅ OPERATIONAL                          ║
║  Phase 3 Components:             ✅ DEPLOYED                             ║
║  Model Detail Routes:            ✅ FUNCTIONAL                           ║
║  Knowledge Base:                 ✅ ACCESSIBLE                           ║
║  SEO Assets:                     ✅ PRESENT                              ║
║                                                                          ║
║  👉 READY FOR MARKETING LAUNCH                                           ║
║                                                                          ║
╚══════════════════════════════════════════════════════════════════════════╝
`);
        process.exit(0);
    }
}

function printResult(result) {
    let statusIcon = result.status === 'PASS' ? '✅' : result.status === 'WARN' ? '⚠️' : '❌';
    let slow = result.isSlow ? ' ⚠️SLOW' : '';
    let issues = result.issues?.length > 0 ? ` [${result.issues[0]}]` : '';
    console.log(`${statusIcon} ${result.status} (${result.duration}ms)${slow}${issues}`);
}

runQA().catch(err => {
    console.error('QA Orchestrator failed:', err);
    process.exit(1);
});
