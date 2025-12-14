// tests/qa-orchestrator.js
// V4.8.2 PRG Verification - Automated Test Suite
const BASE = process.env.BASE_URL || 'https://free2aitools.com';

const TESTS = [
    // Smoke Tests
    { name: 'Home Page', url: '/', expectStatus: 200 },
    { name: 'Explore Page', url: '/explore', expectStatus: 200 },
    { name: 'Leaderboard Page', url: '/leaderboard', expectStatus: 200 },
    { name: 'Ranking Page', url: '/ranking', expectStatus: 200 },
    { name: 'Reports Page', url: '/reports', expectStatus: 200 },

    // Model Detail Pages - Benchmark Slugs
    { name: 'Model: qwen-qwen2-5-72b', url: '/model/qwen-qwen2-5-72b', expectStatus: 200 },
    { name: 'Model: meta-llama-llama-3-3-70b', url: '/model/meta-llama-llama-3-3-70b', expectStatus: 200 },

    // API Endpoints
    { name: 'API: Model (bench slug)', url: '/api/model/qwen-qwen2-5-72b', expectStatus: 200, json: true, mustHave: ['model'] },
    { name: 'API: Search', url: '/api/search?q=llama&limit=3', expectStatus: 200, json: true, mustHave: ['results'] },
    { name: 'API: Trending', url: '/api/trending.json', expectStatus: 200, json: true },
    { name: 'API: Related Models', url: '/api/related-models', expectStatus: 200, json: true },

    // V4.8.2 L8 Cache Endpoints
    { name: 'Cache: neural_graph.json', url: '/api/cache/neural_graph.json', expectStatus: 200, json: true, mustHave: ['nodes', 'links'] },
    { name: 'Cache: trending.json', url: '/api/cache/trending.json', expectStatus: 200, json: true },
    { name: 'Cache: leaderboard.json', url: '/api/cache/leaderboard.json', expectStatus: 200, json: true },
    { name: 'Cache: category_stats.json', url: '/api/cache/category_stats.json', expectStatus: 200, json: true },
    { name: 'Cache: benchmarks.json', url: '/api/cache/benchmarks.json', expectStatus: 200, json: true },
    { name: 'Cache: entity_links.json', url: '/api/cache/entity_links.json', expectStatus: 200, json: true, mustHave: ['version', 'links'] },

    // Legacy Cache Endpoint
    { name: 'Cache (Legacy): benchmarks.json', url: '/cache/benchmarks.json', expectStatus: 200, json: true, mustHave: ['data', 'version'] },

    // DB Test
    { name: 'API: Test DB Connection', url: '/api/test-db-connection', expectStatus: 200, json: true, mustHave: ['success'] },
];


async function runTest(test) {
    const url = BASE + test.url;
    const start = Date.now();

    try {
        const response = await fetch(url);
        const duration = Date.now() - start;
        const statusOk = response.status === test.expectStatus;

        let body = null;
        let contentCheck = true;

        if (test.json) {
            try {
                body = await response.json();
                if (test.mustHave) {
                    for (const key of test.mustHave) {
                        if (body[key] === undefined) {
                            contentCheck = false;
                        }
                    }
                }
                if (test.mustHaveInFirst && Array.isArray(body.results) && body.results.length > 0) {
                    for (const key of test.mustHaveInFirst) {
                        if (body.results[0][key] === undefined) {
                            contentCheck = false;
                        }
                    }
                }
            } catch (e) {
                contentCheck = false;
                body = await response.text();
            }
        }

        const pass = statusOk && contentCheck;

        return {
            name: test.name,
            url: test.url,
            status: response.status,
            expectedStatus: test.expectStatus,
            duration,
            pass,
            error: pass ? null : (statusOk ? 'Content check failed' : 'Status mismatch')
        };
    } catch (e) {
        return {
            name: test.name,
            url: test.url,
            status: 'ERROR',
            expectedStatus: test.expectStatus,
            duration: Date.now() - start,
            pass: false,
            error: e.message
        };
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════');
    console.log('        V4.8.2 PRG Verification - QA Test Suite');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`Base URL: ${BASE}`);
    console.log(`Tests: ${TESTS.length}`);
    console.log(`Started: ${new Date().toISOString()}`);
    console.log('───────────────────────────────────────────────────────────\n');

    const results = [];
    let passed = 0;
    let failed = 0;

    for (const test of TESTS) {
        const result = await runTest(test);
        results.push(result);

        const icon = result.pass ? '✅' : '❌';
        const statusStr = `${result.status}/${result.expectedStatus}`;
        console.log(`${icon} ${result.name.padEnd(35)} ${statusStr.padEnd(10)} ${result.duration}ms`);

        if (!result.pass) {
            console.log(`   ↳ Error: ${result.error}`);
            failed++;
        } else {
            passed++;
        }
    }

    console.log('\n───────────────────────────────────────────────────────────');
    console.log('                     TEST SUMMARY');
    console.log('───────────────────────────────────────────────────────────');
    console.log(`Total: ${TESTS.length} | Passed: ${passed} | Failed: ${failed}`);
    console.log(`Pass Rate: ${((passed / TESTS.length) * 100).toFixed(1)}%`);
    console.log(`Completed: ${new Date().toISOString()}`);
    console.log('═══════════════════════════════════════════════════════════\n');

    // Return results for report generation
    return {
        summary: {
            total: TESTS.length,
            passed,
            failed,
            passRate: ((passed / TESTS.length) * 100).toFixed(1)
        },
        results
    };
}

main().then(data => {
    process.exit(data.summary.failed > 0 ? 1 : 0);
}).catch(e => {
    console.error('Test runner error:', e);
    process.exit(1);
});
