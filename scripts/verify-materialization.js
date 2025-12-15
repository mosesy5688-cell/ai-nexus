const https = require('https');

const BASE_URL = 'https://free2aitools.com';

async function fetchJson(path) {
    return new Promise((resolve, reject) => {
        const url = `${BASE_URL}${path}`;
        const req = https.get(url, (res) => {
            if (res.statusCode !== 200) {
                resolve({ error: `Status ${res.statusCode}`, url });
                return;
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve({ error: 'Invalid JSON', url });
                }
            });
        });
        req.on('error', (e) => resolve({ error: e.message, url }));
        req.end();
    });
}

async function verify() {
    console.log(`🔍 Verifying Content Materialization on ${BASE_URL}...`);
    let errors = 0;

    // 1. Verify Entity Index
    console.log(' [1/3] Checking Entity Index...');
    const index = await fetchJson('/cache/meta/entity_index.json');
    if (index.error) {
        console.error(`  ❌ FAIL: Could not fetch index (${index.error})`);
        errors++;
    } else if (!Array.isArray(index) || index.length < 10) {
        console.error(`  ❌ FAIL: Index empty or too small (${index.length || 0} items)`);
        errors++;
    } else {
        console.log(`  ✅ PASS: Index contains ${index.length} items`);
    }

    // 2. Verify Rankings
    console.log(' [2/3] Checking Text Gen Ranking...');
    const ranking = await fetchJson('/cache/rankings/text-generation.json');
    if (ranking.error) {
        console.error(`  ❌ FAIL: Could not fetch ranking (${ranking.error})`);
        errors++;
    } else if (!ranking.items || ranking.items.length === 0) {
        console.error(`  ❌ FAIL: Ranking items empty`);
        errors++;
    } else {
        console.log(`  ✅ PASS: Ranking contains ${ranking.items.length} items (Generated: ${ranking.generated_at})`);
    }

    // 3. Verify Single Entity (Sample)
    // Try to find a slug from index or use hardcoded popular one
    const slug = index[0]?.slug || 'meta-llama--llama-3-8b';
    console.log(` [3/3] Checking Entity: ${slug}...`);
    const entity = await fetchJson(`/cache/models/${slug}.json`);
    if (entity.error) {
        console.error(`  ❌ FAIL: Could not fetch entity (${entity.error})`);
        errors++;
    } else if (!entity.contract_version) {
        console.error(`  ❌ FAIL: Entity missing contract_version (CEO Iron Rule)`);
        errors++;
    } else {
        console.log(`  ✅ PASS: Entity verified (Version: ${entity.contract_version})`);
    }

    if (errors > 0) {
        console.error(`\n🚨 MATERIALIZATION VERIFICATION FAILED (${errors} errors)`);
        process.exit(1);
    } else {
        console.log('\n✅ ALL SYSTEMS GO: Content is Real.');
        process.exit(0);
    }
}

verify();
