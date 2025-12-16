
import https from 'https';

const MANIFEST_URL = 'https://free2aitools.com/cache/meta/build_manifest.json';
const MIN_INDEX = 10;
const MIN_RANKING = 0;

async function fetchManifest() {
    return new Promise((resolve) => {
        https.get(MANIFEST_URL, (res) => {
            if (res.statusCode !== 200) {
                console.error(`❌ Failed to fetch manifest: HTTP ${res.statusCode}`);
                process.exit(1);
            }
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) {
                    console.error('❌ Invalid Manifest JSON');
                    process.exit(1);
                }
            });
        }).on('error', e => {
            console.error('❌ Network Error:', e.message);
            process.exit(1);
        });
    });
}

async function check() {
    console.log('🛡️ Checking RELEASE GATES...');
    const manifest = await fetchManifest();

    console.log(`   Build Timestamp: ${manifest.generated_at}`);
    console.log(`   Version: ${manifest.version}`);

    let failed = false;

    // Gate 1: Entity Count
    const count = manifest.entities.total || 0;
    if (count < MIN_INDEX) {
        console.error(`❌ GATE FAIL: Index Count ${count} < ${MIN_INDEX}`);
        failed = true;
    } else {
        console.log(`✅ Index Count: ${count} (Pass)`);
    }

    // Gate 2: Rankings
    const rankings = manifest.rankings || {};
    let validRankings = 0;

    for (const [cat, size] of Object.entries(rankings)) {
        if (size >= MIN_RANKING) {
            console.log(`✅ Ranking [${cat}]: ${size} items (Pass)`);
            validRankings++;
        } else {
            console.warn(`⚠️ Ranking [${cat}]: ${size} items (Low Density)`);
        }
    }

    if (validRankings === 0) {
        console.error(`❌ GATE FAIL: No valid ranking categories (> ${MIN_RANKING} items) found.`);
        failed = true;
    }

    if (failed) {
        console.error('\n🛑 RELEASE GATES LOCKED. DO NOT PROMOTE.');
        process.exit(1);
    } else {
        console.log('\n🟢 RELEASE GATES OPEN. System Ready for Launch.');
        process.exit(0);
    }
}

check();
