
import { exec } from 'child_process';
import https from 'https';
import util from 'util';

const execAsync = util.promisify(exec);
const BASE_URL = 'https://free2aitools.com';

async function fetchJson(path) {
    return new Promise((resolve) => {
        const url = `${BASE_URL}${path}`;
        https.get(url, (res) => {
            if (res.statusCode !== 200) return resolve({ error: res.statusCode });
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { resolve({ error: 'Invalid JSON' }); }
            });
        }).on('error', e => resolve({ error: e.message }));
    });
}

async function verifyOrphans() {
    console.log('🔍 [Orphan Check] Sampling 20 random objects from R2...');
    try {
        const { stdout } = await execAsync('npx wrangler r2 object list ai-nexus-assets --prefix=cache/models/ --limit=20');
        const objects = JSON.parse(stdout);

        if (!objects || objects.length === 0) {
            console.error('⚠️ Warning: R2 list returned empty. Cannot verify orphans.');
            return 0; // Skip validation if empty (might be dev env)
        }

        console.log(`info: Fetched ${objects.length} objects from R2.`);

        // Fetch Index
        const index = await fetchJson('/cache/meta/entity_index.json');
        if (index.error) throw new Error('Could not fetch Entity Index for comparison');

        const indexSlugs = new Set(index.map(i => i.slug));

        let invalid = 0;
        for (const obj of objects) {
            const key = obj.key; // "cache/models/slug.json"
            const slug = key.replace('cache/models/', '').replace('.json', '');

            if (!indexSlugs.has(slug)) {
                console.error(`❌ ORPHAN DETECTED: File exists in R2 but NOT in Index: ${slug}`);
                invalid++;
            } else {
                process.stdout.write('.');
            }
        }
        console.log('');

        if (invalid > 0) {
            console.error(`🚨 DETECTED ${invalid} ORPHANED FILES.`);
            return invalid;
        }
        console.log('✅ Orphan Check PASSED (Sample clean).');
        return 0;

    } catch (e) {
        console.error('❌ Error comparing R2 vs Index:', e.message);
        return 1;
    }
}

async function verifyIndexIntegrity() {
    console.log('🔍 [Integrity Check] Verifying Index -> Cache reachability...');
    const index = await fetchJson('/cache/meta/entity_index.json');
    if (index.error) {
        console.error('❌ Failed to fetch index.');
        return 1;
    }

    // Sample 20 from Index
    const sample = index.sort(() => 0.5 - Math.random()).slice(0, 20);
    let failures = 0;

    for (const item of sample) {
        const res = await fetchJson(`/cache/models/${item.slug}.json`);
        if (res.error) {
            console.error(`❌ BROKEN LINK: Index says ${item.slug} exists, but fetched ${res.error}`);
            failures++;
        } else {
            process.stdout.write('.');
        }
    }
    console.log('');

    if (failures > 0) {
        console.error(`🚨 DETECTED ${failures} BROKEN LINKS.`);
        return failures;
    }
    console.log('✅ Integrity Check PASSED (Index -> Cache valid).');
    return 0;
}

async function run() {
    console.log('🚀 Starting Materialization Integrity Scan...');
    const orphans = await verifyOrphans();
    const broken = await verifyIndexIntegrity();

    if (orphans + broken > 0) {
        console.error(`\n🛑 INTEGRITY SCAN FAILED. Orphans: ${orphans}, Broken: ${broken}`);
        process.exit(1);
    }
    console.log('\n🟢 INTEGRITY SCAN PASSED.');
}

run();
