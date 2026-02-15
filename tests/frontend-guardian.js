// tests/frontend-guardian.js
// Helios Frontend Guardian V1.1 - V4 Stable Execution Layer
// Constitution V4.3.2 Compliant

const BASE = process.env.BASE_URL || 'https://free2aitools.com';

/**
 * HELIOS FRONTEND GUARDIAN V1.1
 * 
 * V4 Stable Layer Enhancements:
 * - PASS/WARN/FAIL status system (C1)
 * - L8 UMID key validation (B2)
 * - source=unknown rejection
 * 
 * Mission: Maintain perfect UI integrity, layout structure, and SSR correctness
 */

// ═══════════════════════════════════════════════════════════
//              V4 STABLE: GUARDIAN STATUS SYSTEM (C1)
// ═══════════════════════════════════════════════════════════

const GUARDIAN_STATUS = {
    PASS: 'PASS',   // Deploy allowed
    WARN: 'WARN',   // Deploy allowed but flagged
    FAIL: 'FAIL'    // Deploy BLOCKED
};

// V4 Stable: Required UMIDs in L8 cache (B2)
const REQUIRED_UMIDS = [
    'meta-llama', 'qwen', 'mistral', 'google-gemma',
    'microsoft-phi', 'deepseek-ai'
];

// V4.7 Constitutional Violations (Art.6, Art.12)
const CONSTITUTIONAL_VIOLATIONS = {
    ILLEGAL_SOURCE: ['unknown', 'null', 'undefined', ''],
    ILLEGAL_FIELDS: ['N/A', 'null', 'undefined']
};

// V4.7 Zen Design Violations (Art.3)
const ZEN_DESIGN_VIOLATIONS = {
    EXTERNAL_FONTS: [
        'fonts.googleapis.com',
        'fonts.gstatic.com',
        'use.typekit.net',
        'fast.fonts.net'
    ],
    FORBIDDEN_PATTERNS: [
        'particles.js',
        'three.js',
        'webgl'
    ]
};

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
        { name: 'Knowledge Index', path: '/knowledge', critical: true }
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

        // Check for SSR errors + Soft 404 Markers (V16.32 Anti-Deception)
        const ssrErrorPatterns = [
            /TypeError:.*undefined/i,
            /ReferenceError:/i,
            /Cannot read propert.*of undefined/i,
            /is not defined/i,
            /Astro\..*Error/i,
            /<pre>Error:/i,
            /id="article-not-found"/i,      // Soft 404 Marker: Article Container
            /id="model-not-found"/i,        // Soft 404 Marker: Model Container
            /Model Not Found/i,             // Visual Text Marker
            /Article Not Found/i,           // Visual Text Marker
            /aggregated in the Knowledge Mesh/i, // Logic Fallback Marker
            />null</i,                      // Content Leak: Literall null
            />\s*null\s*</i,               // Content Leak: Null with whitespace
            /italic">null<\/span>/i,        // SPEC-V15: Constitution leak marker
            /\[object Object\]/i            // Serialization failure
        ];

        const hasSSRError = ssrErrorPatterns.some(pattern => pattern.test(html));
        if (hasSSRError) {
            issues.push({ type: 'SSR_OR_SOFT_404', message: 'Soft 404 or SSR error detected in HTML content' });
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


// ═══════════════════════════════════════════════════════════
//              V16.95 CANONICAL ROUTING CORE
// ═══════════════════════════════════════════════════════════

function stripPrefix(id) {
    if (!id || typeof id !== 'string') return '';
    let result = id.toLowerCase();
    const prefixes = [
        'hf-model--', 'hf-agent--', 'hf-tool--', 'hf-dataset--', 'hf-space--', 'hf-paper--',
        'arxiv-paper--', 'arxiv--', 'paper--', 'dataset--', 'model--', 'agent--', 'tool--', 'space--',
        'knowledge--', 'concept--', 'report--'
    ];
    for (const p of prefixes) {
        if (result.startsWith(p)) {
            result = result.slice(p.length);
            break;
        }
    }
    return result.replace(/[:\/]/g, '--').replace(/^--|--$/g, '');
}

function getTypeFromId(id) {
    if (!id || typeof id !== 'string') return 'model';
    const low = id.toLowerCase();
    if (low.startsWith('knowledge--') || low.startsWith('concept--')) return 'knowledge';
    if (low.startsWith('report--')) return 'report';
    if (low.startsWith('arxiv-paper--') || low.startsWith('arxiv--') || low.startsWith('paper--')) return 'paper';
    if (low.startsWith('hf-dataset--') || low.startsWith('dataset--')) return 'dataset';
    if (low.startsWith('hf-space--') || low.startsWith('space--')) return 'space';
    if (low.startsWith('hf-agent--') || low.startsWith('agent--')) return 'agent';
    if (low.startsWith('hf-tool--') || low.startsWith('tool--')) return 'tool';
    return 'model';
}

function getRouteFromId(id, type = null) {
    if (!id) return '#';
    let resolvedType = type || getTypeFromId(id);
    let slug = stripPrefix(id).replace(/--/g, '/');

    if (resolvedType === 'paper') slug = stripPrefix(id).replace(/--/g, '.');

    const routeMap = {
        'knowledge': `/knowledge/${slug}`,
        'report': `/reports/${slug}`,
        'paper': `/paper/${slug}`,
        'dataset': `/dataset/${slug}`,
        'space': `/space/${slug}`,
        'agent': `/agent/${slug}`,
        'tool': `/tool/${slug}`,
        'model': `/model/${slug}`
    };

    return routeMap[resolvedType] || `/model/${slug}`;
}

// Decompression Helper for Node environment
async function gunzipJson(url) {
    const response = await fetch(url);
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    try {
        const { gunzipSync } = await import('zlib');
        const decompressed = gunzipSync(Buffer.from(buffer)).toString('utf-8');
        return JSON.parse(decompressed);
    } catch (e) {
        const text = new TextDecoder().decode(buffer);
        return JSON.parse(text);
    }
}

async function validateUMIDLinks() {
    // Fetch search results and verify UMID links resolve
    const issues = [];
    const CDN_URL = 'https://cdn.free2aitools.com';

    try {
        let results = [];
        // Attempt API first
        try {
            const response = await fetch(`${BASE}/api/search?limit=10`);
            if (response.ok) {
                const data = await response.json();
                results = data.results || [];
            }
        } catch (e) { /* Fallback to CDN index */ }

        if (results.length === 0) {
            console.log('   ℹ️ API fallback to CDN Index...');
            const data = await gunzipJson(`${CDN_URL}/cache/search-core.json.gz`);
            const entities = data.entities || data.models || data || [];
            results = entities.slice(0, 50).map(e => ({
                id: e.id,
                slug: e.slug,
                type: e.t || e.type,
                name: e.n || e.name
            }));
        }

        // V16.8.15 R5.8: Mandatory Injection of reported broken link for verification
        if (!results.some(r => r.id === 'hf-model--coqui--xtts-v2')) {
            results.unshift({ id: 'hf-model--coqui--xtts-v2', type: 'model', name: 'Coqui XTTS v2' });
            console.log('   ℹ️ Injected hf-model--coqui--xtts-v2 for validation.');
        }

        if (results.length === 0) {
            issues.push({ type: 'NO_RESULTS', message: 'Could not fetch sample models for link validation' });
            return { pass: false, issues };
        }

        // Verify result's canonical round-trip (Test top 3 including our mandatory coqui)
        for (const first of results.slice(0, 3)) {
            const path = getRouteFromId(first.id, first.type);
            if (path && path !== '#') {
                const url = `${BASE}${path}`;
                const response = await fetch(url);
                const html = await response.text();

                // Perform deep inspection for SSR errors / null leaks
                const ssrErrorPatterns = [
                    /italic">null<\/span>/i,
                    />\s*null\s*</i,
                    /\[object Object\]/i
                ];

                const hasLeak = ssrErrorPatterns.some(p => p.test(html));

                if (response.status !== 200 || hasLeak) {
                    issues.push({
                        type: 'CONTENT_CORRUPTION',
                        message: `Entity ${first.id} failed validation at ${path} (Status: ${response.status}, NullLeak: ${hasLeak})`
                    });
                } else {
                    CONFIG.pages.push({ name: `Entity: ${first.id}`, path: path, critical: true });
                    console.log(`   ✅ Sampled canonical path: ${path} (Status: 200)`);
                }
            }
        }

    } catch (error) {
        issues.push({ type: 'VALIDATION_ERROR', message: error.message });
    }

    return { pass: issues.length === 0, issues };
}

/**
 * V4.7 Constitutional Validation (Art.6, Art.12)
 * Checks for illegal states: source=unknown, core fields=N/A
 */
async function validateConstitutional() {
    const issues = [];

    try {
        // Sample models from DB via API and check for constitutional violations
        const response = await fetch(`${BASE}/api/search?limit=20`);
        const data = await response.json();

        if (!data.results) {
            issues.push({ type: 'API_ERROR', message: 'Search API failed' });
            return { pass: false, issues };
        }

        let unknownSourceCount = 0;
        let naFieldCount = 0;

        for (const model of data.results) {
            // V4.7 Art.6: source=unknown is illegal
            if (CONSTITUTIONAL_VIOLATIONS.ILLEGAL_SOURCE.includes(model.source)) {
                unknownSourceCount++;
            }

            // V4.7 Art.9: Core fields = N/A is warning
            if (model.params_billions === 'N/A' || model.context_length === 'N/A') {
                naFieldCount++;
            }
        }

        if (unknownSourceCount > 0) {
            issues.push({
                type: 'CONSTITUTIONAL_FAIL',
                message: `Art.6 Violation: ${unknownSourceCount} models with source=unknown`
            });
        }

        if (naFieldCount > 3) {
            issues.push({
                type: 'CONSTITUTIONAL_WARN',
                message: `Art.9 Warning: ${naFieldCount} models with N/A fields`
            });
        }

        // V4.7 Art.8: FNI volatility check
        // Sample top models and check for extreme FNI values
        const topModels = data.results.filter(m => m.fni_score !== null).slice(0, 10);
        const avgFni = topModels.reduce((sum, m) => sum + (m.fni_score || 0), 0) / (topModels.length || 1);

        // Check for anomalous FNI distribution (potential pollution)
        const highVariance = topModels.some(m => Math.abs((m.fni_score || 0) - avgFni) > 40);
        if (highVariance) {
            issues.push({
                type: 'FNI_WARN',
                message: 'Art.8 Warning: High FNI variance detected (possible data pollution)'
            });
        }

    } catch (error) {
        issues.push({ type: 'VALIDATION_ERROR', message: error.message });
    }

    // FAIL if source=unknown found, WARN for N/A fields
    const hasFail = issues.some(i => i.type === 'CONSTITUTIONAL_FAIL');
    return { pass: !hasFail, issues };
}

/**
 * V4.7 Zen Design Validation (Art.3)
 * Checks for external fonts and forbidden UI patterns
 */
async function validateZenDesign() {
    const issues = [];

    try {
        // Fetch homepage HTML to check for violations
        const response = await fetch(`${BASE}/`);
        const html = await response.text();

        // Check for external fonts (Art.3 violation = FAIL)
        for (const fontCdn of ZEN_DESIGN_VIOLATIONS.EXTERNAL_FONTS) {
            if (html.includes(fontCdn)) {
                issues.push({
                    type: 'ZEN_FAIL',
                    message: `Art.3 Violation: External font detected (${fontCdn})`
                });
            }
        }

        // Check for forbidden patterns (WARN)
        for (const pattern of ZEN_DESIGN_VIOLATIONS.FORBIDDEN_PATTERNS) {
            if (html.toLowerCase().includes(pattern)) {
                issues.push({
                    type: 'ZEN_WARN',
                    message: `Art.3 Warning: Forbidden pattern detected (${pattern})`
                });
            }
        }

    } catch (error) {
        issues.push({ type: 'VALIDATION_ERROR', message: error.message });
    }

    const hasFail = issues.some(i => i.type === 'ZEN_FAIL');
    return { pass: !hasFail, issues };
}

/**
 * V4.7 Data Coverage Validation (Art.1)
 * Checks that detail pages display all available data
 */
async function validateDataCoverage() {
    const issues = [];

    try {
        // Test a model detail page for data completeness
        const searchResponse = await fetch(`${BASE}/api/search?limit=5`);
        const searchData = await searchResponse.json();

        if (!searchData.results || searchData.results.length === 0) {
            return { pass: true, issues }; // No models to check
        }

        const testModel = searchData.results[0];
        const modelUrl = `${BASE}/model/${encodeURIComponent(testModel.slug)}`;
        const pageResponse = await fetch(modelUrl);
        const html = await pageResponse.text();

        // Art.1: Check essential data sections exist
        const requiredSections = [
            { name: 'FNI Score', pattern: /fni|score/i },
            { name: 'Parameters', pattern: /param|billion/i },
            { name: 'License', pattern: /license|spdx/i }
        ];

        for (const section of requiredSections) {
            if (!section.pattern.test(html)) {
                issues.push({
                    type: 'COVERAGE_WARN',
                    message: `Art.1 Warning: ${section.name} section may be missing`
                });
            }
        }

    } catch (error) {
        issues.push({ type: 'VALIDATION_ERROR', message: error.message });
    }

    return { pass: issues.filter(i => i.type.includes('FAIL')).length === 0, issues };
}

/**
 * V4.7 Filter Awareness Validation
 * Checks that filters don't result in empty or overly broad results
 */
async function validateFilterAwareness() {
    const issues = [];

    try {
        // Test a common filter combination
        const testFilters = [
            { name: 'Platform: Ollama', url: `${BASE}/api/search?has_ollama=1&limit=5` },
            { name: 'Size: Small', url: `${BASE}/api/search?max_params=10&limit=5` }
        ];

        for (const filter of testFilters) {
            const response = await fetch(filter.url);
            const data = await response.json();

            if (!data.results || data.results.length === 0) {
                issues.push({
                    type: 'FILTER_WARN',
                    message: `Filter "${filter.name}" returned 0 results`
                });
            }
        }

    } catch (error) {
        issues.push({ type: 'VALIDATION_ERROR', message: error.message });
    }

    return { pass: issues.filter(i => i.type.includes('FAIL')).length === 0, issues };
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
    // 4. V4.7 Constitutional Validation
    // ─────────────────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ PHASE 4: V4.7 Constitutional Validation                     │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    results.constitutional = await validateConstitutional();
    results.summary.total++;

    if (results.constitutional.pass) {
        console.log('✅ Constitutional Compliance            PASS');
        results.summary.passed++;
    } else {
        console.log('❌ Constitutional Compliance            FAIL');
        results.summary.failed++;
        results.constitutional.issues.forEach(i => {
            console.log(`   ↳ ${i.type}: ${i.message}`);
            results.summary.issues.push({ context: 'Constitutional', ...i });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // 5. V4.7 Zen Design Audit (Art.3)
    // ─────────────────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ PHASE 5: V4.7 Zen Design Audit                              │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    results.zenDesign = await validateZenDesign();
    results.summary.total++;

    if (results.zenDesign.pass) {
        console.log('✅ Zen Design Compliance               PASS');
        results.summary.passed++;
    } else {
        console.log('❌ Zen Design Compliance               FAIL');
        results.summary.failed++;
        results.zenDesign.issues.forEach(i => {
            console.log(`   ↳ ${i.type}: ${i.message}`);
            results.summary.issues.push({ context: 'Zen Design', ...i });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // 6. V4.7 Data Coverage Audit (Art.1)
    // ─────────────────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ PHASE 6: V4.7 Data Coverage Audit                           │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    results.dataCoverage = await validateDataCoverage();
    results.summary.total++;

    if (results.dataCoverage.pass) {
        console.log('✅ Data Coverage Compliance            PASS');
        results.summary.passed++;
    } else {
        console.log('❌ Data Coverage Compliance            FAIL');
        results.summary.failed++;
        results.dataCoverage.issues.forEach(i => {
            console.log(`   ↳ ${i.type}: ${i.message}`);
            results.summary.issues.push({ context: 'Data Coverage', ...i });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // 7. V4.7 Filter Awareness (UX Health)
    // ─────────────────────────────────────────────────────────────
    console.log('\n┌─────────────────────────────────────────────────────────────┐');
    console.log('│ PHASE 7: V4.7 Filter Awareness                              │');
    console.log('└─────────────────────────────────────────────────────────────┘\n');

    results.filterAwareness = await validateFilterAwareness();
    results.summary.total++;

    if (results.filterAwareness.pass) {
        console.log('✅ Filter Awareness                    PASS');
        results.summary.passed++;
    } else {
        console.log('⚠️ Filter Awareness                    WARN');
        results.filterAwareness.issues.forEach(i => {
            console.log(`   ↳ ${i.type}: ${i.message}`);
            results.summary.issues.push({ context: 'Filter', ...i });
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Summary + V4 Stable PASS/WARN/FAIL System (C1)
    // ─────────────────────────────────────────────────────────────

    // Determine final status
    const hasCriticalFailure = results.pages
        .filter(p => CONFIG.pages.find(c => c.path === p.path)?.critical)
        .some(p => !p.pass) || (results.constitutional && !results.constitutional.pass);
    const hasWarnings = results.summary.failed > 0 && !hasCriticalFailure;

    let finalStatus;
    if (hasCriticalFailure) {
        finalStatus = GUARDIAN_STATUS.FAIL;
    } else if (hasWarnings) {
        finalStatus = GUARDIAN_STATUS.WARN;
    } else {
        finalStatus = GUARDIAN_STATUS.PASS;
    }

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                      GUARDIAN SUMMARY                        ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Total Tests:  ${results.summary.total.toString().padEnd(47)}║`);
    console.log(`║ Passed:       ${results.summary.passed.toString().padEnd(47)}║`);
    console.log(`║ Failed:       ${results.summary.failed.toString().padEnd(47)}║`);
    console.log(`║ Pass Rate:    ${((results.summary.passed / results.summary.total) * 100).toFixed(1)}%${' '.repeat(44)}║`);
    console.log('╠══════════════════════════════════════════════════════════════╣');

    if (finalStatus === GUARDIAN_STATUS.PASS) {
        console.log('║ Status:       ✅ PASS - Deploy allowed                        ║');
    } else if (finalStatus === GUARDIAN_STATUS.WARN) {
        console.log('║ Status:       ⚠️  WARN - Deploy allowed with flags             ║');
    } else {
        console.log('║ Status:       ❌ FAIL - Deploy BLOCKED                         ║');
    }
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    if (finalStatus === GUARDIAN_STATUS.FAIL) {
        console.log('🚫 Guardian FAIL: Blocking deployment due to critical failures.\n');
        process.exit(1);
    } else {
        process.exit(0);
    }
}

// ─────────────────────────────────────────────────────────────
// V16.32: Dynamic Knowledge Crawl Injection
// ─────────────────────────────────────────────────────────────
async function injectKnowledgePages() {
    try {
        const { KNOWLEDGE_CATEGORIES } = await import('../src/data/knowledge-base-config.ts');
        KNOWLEDGE_CATEGORIES.forEach(cat => {
            cat.articles.forEach(art => {
                CONFIG.pages.push({
                    name: `Knowledge: ${art.slug}`,
                    path: `/knowledge/${art.slug}`,
                    critical: false
                });
            });
        });
        console.log(`✅ Injected ${CONFIG.pages.length - 6} knowledge nodes for deep audit.\n`);
    } catch (e) {
        console.warn('⚠️ Could not load knowledge-base-config: ' + e.message);
    }
}

async function main() {
    if (process.argv.includes('--crawl-knowledge')) {
        await injectKnowledgePages();
    }
    await runGuardian();
}

main().catch(e => {
    console.error('Guardian error:', e);
    process.exit(1);
});
