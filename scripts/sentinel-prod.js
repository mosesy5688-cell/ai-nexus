/**
 * ------------------------------------------------------------------
 * L9 GUARDIAN - GLOBAL HEALTH SENTINEL (V16.8 Consolidated)
 * ------------------------------------------------------------------
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// Resolve paths
const __filename = new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1');
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const TARGET_URL = (process.argv[2] || 'https://free2aitools.com').replace(/\/$/, '');
const IS_EXPORT = process.argv.includes('--export');

const HEADERS = {
    'User-Agent': 'Free2AITools-Sentinel/2.0 (ConsolidatedHealth; +http://free2aitools.com)',
    'Accept': 'text/html,application/json'
};

function computeTotalHash(manifest) {
    if (!manifest.batches) return null;
    const batchHashes = manifest.batches
        .sort((a, b) => (a.index || 0) - (b.index || 0))
        .map(b => b.hash || '')
        .join('');
    return `sha256:${crypto.createHash('sha256').update(batchHashes).digest('hex')}`;
}

async function checkBackendIntegrity() {
    process.stdout.write('   [TIER 0] Backend Integrity Check... ');
    const results = { name: 'Manifest Integrity', status: 'PASS', details: [] };

    try {
        const manifestPath = path.join(ROOT_DIR, 'data', 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            console.log('⚪ SKIP (No local manifest)');
            results.status = 'SKIP';
            return results;
        }

        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

        // Flexible status check: Pass if batches exist, even if "status" field is missing (Legacy support)
        if (manifest.status && manifest.status !== 'complete') {
            throw new Error(`Incomplete status: ${manifest.status}`);
        }
        if (!manifest.batches && !manifest.total_entities) {
            throw new Error('Manifest lacks required data fields (batches/entities)');
        }

        const computed = computeTotalHash(manifest);
        if (manifest.checksum?.total_hash && manifest.checksum.total_hash !== computed) {
            throw new Error('Hash mismatch! Data corruption detected.');
        }

        console.log('✅ OK');
        results.details.push(`Entities: ${manifest.output?.total_entities || manifest.total_entities || 0}`);
    } catch (err) {
        console.log('❌ FAIL');
        results.status = 'FAIL';
        results.error = err.message;
    }

    return results;
}

async function checkInfrastructure() {
    process.stdout.write('   [TIER 1] Infrastructure & V6 Stats... ');
    const results = { name: 'Infra & V6 Stats', status: 'PASS', details: [] };

    try {
        const statsUrl = `${TARGET_URL}/cache/category_stats.json`;
        const statsRes = await fetch(statsUrl, { headers: HEADERS });
        if (!statsRes.ok) throw new Error(`Stats fetch failed (${statsRes.status})`);

        // Get stats last modified as a freshness baseline
        const statsLastMod = new Date(statsRes.headers.get('last-modified') || Date.now());

        // 2. Pagination Cap Check (Art 2.4 - No p51)
        const categories = ['text-generation', 'vision-multimedia', 'infrastructure-ops', 'knowledge-retrieval'];
        for (const cat of categories) {
            const p51Url = `${TARGET_URL}/cache/rankings/${cat}/p51.json`;
            const p51Res = await fetch(p51Url, { method: 'HEAD', headers: HEADERS });

            if (p51Res.status === 200) {
                const p51LastMod = new Date(p51Res.headers.get('last-modified') || 0);
                const isStale = (statsLastMod - p51LastMod) > 1000 * 60 * 60; // Older than 1 hour relative to stats

                if (isStale) {
                    console.warn(`   ⚠️  Stale artifact detected: ${cat}/p51.json (LastModified: ${p51LastMod.toISOString()}). Ignoring.`);
                } else {
                    results.status = 'FAIL';
                    results.error = `Pagination CAP violated: ${cat}/p51.json is FRESH (Art 2.4 Violation). LastModified: ${p51LastMod.toISOString()}.`;
                    console.log('❌ FAIL');
                    return results;
                }
            }
        }

        console.log('✅ OK');
    } catch (err) {
        console.log('❌ FAIL');
        results.status = 'FAIL';
        results.error = err.message;
    }

    return results;
}

const PAGES = [
    { url: '/', name: 'Home', text: 'Free AI Tools', critical: true },
    { url: '/ranking', name: 'Rankings', text: 'AI Ecosystem Rankings', critical: true },
    { url: '/cache/trending.json', name: 'Trending JSON', minSize: 100, critical: true },
    { url: '/cache/search-core.json', name: 'Search Index', minSize: 1000, critical: true }
];

async function runAudit() {
    process.stdout.write(`\n🛡️  GLOBAL HEALTH SENTINEL - Running for: ${TARGET_URL}\n`);

    const finalReport = {
        timestamp: new Date().toISOString(),
        target: TARGET_URL,
        results: [],
        healthy: true
    };

    const integrity = await checkBackendIntegrity();
    finalReport.results.push(integrity);

    const infra = await checkInfrastructure();
    finalReport.results.push(infra);

    console.log('   [TIER 2] Frontend Smoke Tests:');
    for (const page of PAGES) {
        process.stdout.write(`      - ${page.name.padEnd(20)} `);
        try {
            const url = `${TARGET_URL}${page.url}`;
            let res = await fetch(url, { headers: HEADERS });

            // V18.2.7: .gz Fallback for health check
            if (!res.ok && !url.endsWith('.gz')) {
                const gzRes = await fetch(url + '.gz', { headers: HEADERS });
                if (gzRes.ok) res = gzRes;
            }

            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const content = await res.text();
            if (page.text && !content.includes(page.text)) throw new Error(`Text missing: "${page.text}"`);
            if (page.minSize && content.length < page.minSize) throw new Error(`Payload too small: ${content.length}b < ${page.minSize}b`);

            console.log('✅ OK');
            finalReport.results.push({ name: page.name, status: 'PASS' });
        } catch (err) {
            console.log(`❌ FAIL (${err.message})`);
            finalReport.results.push({ name: page.name, status: 'FAIL', error: err.message });
            if (page.critical) finalReport.healthy = false;
        }
    }

    if (integrity.status === 'FAIL' || infra.status === 'FAIL') finalReport.healthy = false;

    if (!finalReport.healthy) {
        console.log('\n🚨 FAILURES DETECTED:');
        finalReport.results.filter(r => r.status === 'FAIL').forEach(r => {
            console.log(`   - ${r.name}: ${r.error}`);
        });
    }

    if (IS_EXPORT) {
        fs.writeFileSync('health-report.json', JSON.stringify(finalReport, null, 2));
    }

    console.log(`\nOVERALL STATUS: ${finalReport.healthy ? '🎉 HEALTHY' : '🔥 DEGRADED'}\n`);
    process.exit(finalReport.healthy ? 0 : 1);
}

runAudit();
