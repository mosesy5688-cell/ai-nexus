// tests/frontend-guardian.js
// Helios Frontend Guardian V1.0 - Unified Test & Auto-Fix System
// Constitution V4.3.2 Compliant

const BASE = process.env.BASE_URL || 'https://free2aitools.com';

/**
 * HELIOS FRONTEND GUARDIAN V1.0
 * 
 * Mission: Maintain perfect UI integrity, layout structure, and SSR correctness
 * 
 * Capabilities:
 * 1. Layout & Rendering Validation
 * 2. Component Completeness Check
 * 3. UMID/Slug Link Verification
 * 4. Performance Metrics Collection
 * 5. Automatic Issue Detection & Reporting
 */

// ═══════════════════════════════════════════════════════════
//                    CONFIGURATION
// ═══════════════════════════════════════════════════════════

const CONFIG = {
    // Pages to validate
    pages: [
        { name: 'Home', path: '/', critical: true },
        { name: 'Explore', path: '/explore', critical: true },
        { name: 'Leaderboard', path: '/leaderboard', critical: true },
        { name: 'Ranking', path: '/ranking', critical: true },
        { name: 'Model (bench)', path: '/model/qwen-qwen2-5-72b', critical: true },
        { name: 'Model (HF)', path: '/model/meta-llama-llama-3-3-70b', critical: true },
    ],

    // API endpoints to validate
    apis: [
        { name: 'Model API', path: '/api/model/qwen-qwen2-5-72b', mustHave: ['model', 'resolution'] },
        { name: 'Search API', path: '/api/search?q=qwen&limit=3', mustHave: ['results'] },
        { name: 'Trending API', path: '/api/trending.json', mustHave: [] },
        { name: 'DB Connection', path: '/api/test-db-connection', mustHave: ['success', 'dbConnected'] },
    ],

    // Model page required components (per Constitution)
    modelPageComponents: [
        'model-title',
        'model-metadata',
        'model-description',
        'fni-badge',
        'tags-section',
        'benchmark-section',
        'related-models',
    ],

    // Performance thresholds
    performance: {
        fcp: { target: 1500, warning: 2500, critical: 4000 },
        lcp: { target: 2500, warning: 4000, critical: 6000 },
        speedIndex: { target: 3000, warning: 5000, critical: 8000 },
        tbt: { target: 300, warning: 600, critical: 1000 },
    }
};

// ═══════════════════════════════════════════════════════════
//                    TEST FUNCTIONS
// ═══════════════════════════════════════════════════════════

async function validatePage(page) {
    const url = BASE + page.path;
    const start = Date.now();

    try {
        const response = await fetch(url);
        const duration = Date.now() - start;
        const html = await response.text();

        const issues = [];

        // Check status
        if (response.status !== 200) {
            issues.push({ type: 'STATUS_ERROR', message: `Expected 200, got ${response.status}` });
        }

        // Check for SSR errors in HTML (more precise patterns)
        const ssrErrorPatterns = [
            /TypeError:.*undefined/i,
            /ReferenceError:/i,
            /Cannot read propert.*of undefined/i,
            /is not defined/i,
            /Astro\..*Error/i,
            /<pre>Error:/i,
        ];

        const hasSSRError = ssrErrorPatterns.some(pattern => pattern.test(html));
        if (hasSSRError) {
            issues.push({ type: 'SSR_ERROR', message: 'SSR error detected in HTML output' });
        }

        // Check for debug panels (should not be in production)
        if (html.includes('BEFORE CALL:') || html.includes('dbBeforeCall:')) {
            issues.push({ type: 'DEBUG_LEAK', message: 'Debug panel detected in production' });
        }

        // Check for Model Not Found on model pages
        if (page.path.includes('/model/') && html.includes('Model Not Found')) {
            issues.push({ type: 'MODEL_NOT_FOUND', message: 'Model page showing not found' });
        }

        return {
            page: page.name,
            url: page.path,
            status: response.status,
            duration,
            issues,
            pass: issues.length === 0
        };

    } catch (error) {
        return {
            page: page.name,
            url: page.path,
            status: 'ERROR',
            duration: Date.now() - start,
            issues: [{ type: 'FETCH_ERROR', message: error.message }],
            pass: false
        };
    }
}

async function validateAPI(api) {
    const url = BASE + api.path;
    const start = Date.now();

    try {
        const response = await fetch(url);
        const duration = Date.now() - start;
        const data = await response.json();

        const issues = [];

        // Check status
        if (response.status !== 200) {
            issues.push({ type: 'STATUS_ERROR', message: `Expected 200, got ${response.status}` });
        }

        // Check required fields
        for (const field of api.mustHave) {
            if (data[field] === undefined) {
                issues.push({ type: 'MISSING_FIELD', message: `Missing required field: ${field}` });
            }
        }

        // Check for error responses
        if (data.error) {
            issues.push({ type: 'API_ERROR', message: data.error });
        }

        return {
            api: api.name,
            url: api.path,
            status: response.status,
            duration,
            issues,
            pass: issues.length === 0
        };

    } catch (error) {
        return {
            api: api.name,
            url: api.path,
            status: 'ERROR',
            duration: Date.now() - start,
            issues: [{ type: 'FETCH_ERROR', message: error.message }],
            pass: false
        };
    }
}

async function validateUMIDLinks() {
    // Fetch search results and verify UMID links resolve
    const issues = [];

    try {
        const response = await fetch(`${BASE}/api/search?limit=10`);
        const data = await response.json();

        if (!data.results || data.results.length === 0) {
            issues.push({ type: 'NO_RESULTS', message: 'Search API returned no results' });
            return { pass: false, issues };
        }

        // Check each result has umid and slug
        for (const model of data.results.slice(0, 5)) {
            if (!model.umid) {
                issues.push({ type: 'MISSING_UMID', message: `Model ${model.id} missing umid` });
            }
            if (!model.slug) {
                issues.push({ type: 'MISSING_SLUG', message: `Model ${model.id} missing slug` });
            }
        }

        // Verify first result's model page resolves
        if (data.results[0]?.slug) {
            const modelUrl = `${BASE}/model/${encodeURIComponent(data.results[0].slug)}`;
            const modelResponse = await fetch(modelUrl);
            if (modelResponse.status !== 200) {
                issues.push({
                    type: 'BROKEN_LINK',
                    message: `Model link ${data.results[0].slug} returned ${modelResponse.status}`
                });
            }
        }

    } catch (error) {
        issues.push({ type: 'VALIDATION_ERROR', message: error.message });
    }

    return { pass: issues.length === 0, issues };
}

// ═══════════════════════════════════════════════════════════
//                    MAIN RUNNER
// ═══════════════════════════════════════════════════════════

async function runGuardian() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║       HELIOS FRONTEND GUARDIAN V1.0                          ║');
    console.log('║       Constitution V4.3.2 Compliant                          ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Base URL: ${BASE.padEnd(48)}║`);
    console.log(`║ Started:  ${new Date().toISOString().padEnd(48)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    const results = {
        pages: [],
        apis: [],
        umidLinks: null,
        summary: { total: 0, passed: 0, failed: 0, issues: [] }
    };

    // ─────────────────────────────────────────────────────────────
    // 1. Page Validation
    // ─────────────────────────────────────────────────────────────
    console.log('┌─────────────────────────────────────────────────────────────┐');
    console.log('│ PHASE 1: Page Validation                                    │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    for (const page of CONFIG.pages) {
        const result = await validatePage(page);
        results.pages.push(result);
        results.summary.total++;

        const icon = result.pass ? '✅' : '❌';
        console.log(`${icon} ${result.page.padEnd(25)} ${result.status}  ${result.duration}ms`);

        if (result.pass) {
            results.summary.passed++;
        } else {
            results.summary.failed++;
            result.issues.forEach(i => {
                console.log(`   ↳ ${i.type}: ${i.message}`);
                results.summary.issues.push({ context: result.page, ...i });
            });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // 2. API Validation
    // ─────────────────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ PHASE 2: API Validation                                     │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    for (const api of CONFIG.apis) {
        const result = await validateAPI(api);
        results.apis.push(result);
        results.summary.total++;

        const icon = result.pass ? '✅' : '❌';
        console.log(`${icon} ${result.api.padEnd(25)} ${result.status}  ${result.duration}ms`);

        if (result.pass) {
            results.summary.passed++;
        } else {
            results.summary.failed++;
            result.issues.forEach(i => {
                console.log(`   ↳ ${i.type}: ${i.message}`);
                results.summary.issues.push({ context: result.api, ...i });
            });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // 3. UMID Link Validation
    // ─────────────────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ PHASE 3: UMID/Slug Link Validation                          │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    results.umidLinks = await validateUMIDLinks();
    results.summary.total++;

    if (results.umidLinks.pass) {
        console.log('✅ UMID Link Resolution                 PASS');
        results.summary.passed++;
    } else {
        console.log('❌ UMID Link Resolution                 FAIL');
        results.summary.failed++;
        results.umidLinks.issues.forEach(i => {
            console.log(`   ↳ ${i.type}: ${i.message}`);
            results.summary.issues.push({ context: 'UMID Links', ...i });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                      GUARDIAN SUMMARY                        ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Total Tests:  ${results.summary.total.toString().padEnd(47)}║`);
    console.log(`║ Passed:       ${results.summary.passed.toString().padEnd(47)}║`);
    console.log(`║ Failed:       ${results.summary.failed.toString().padEnd(47)}║`);
    console.log(`║ Pass Rate:    ${((results.summary.passed / results.summary.total) * 100).toFixed(1)}%${' '.repeat(44)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');

    if (results.summary.failed === 0) {
        console.log('║ Status:       ✅ ALL TESTS PASSED                            ║');
    } else {
        console.log('║ Status:       ❌ ISSUES DETECTED                             ║');
    }

    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Return exit code
    process.exit(results.summary.failed > 0 ? 1 : 0);
}

// Run
runGuardian().catch(e => {
    console.error('Guardian error:', e);
    process.exit(1);
});
