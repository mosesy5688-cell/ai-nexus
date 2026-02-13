
const fetch = require('node-fetch'); // Assuming node-fetch is available or using native fetch in Node 18+

// Replicated logic from constants.ts and mesh-routing-core.js
const R2_CACHE_URL = 'https://cdn.free2aitools.com';

function stripPrefix(id) {
    if (!id) return '';
    let result = id.toLowerCase();
    const prefixes = ['hf-model--', 'google--', 'arxiv--']; // Simplified for test
    for (const p of prefixes) {
        if (result.startsWith(p)) result = result.slice(p.length);
    }
    return result.replace(/[:\/]/g, '--').replace(/^--|--$/g, '');
}

async function testFetch(slug) {
    const lowerSlug = slug.toLowerCase().replace(/\//g, '--');
    const url = `${R2_CACHE_URL}/cache/fused/${lowerSlug}.json`;
    const gzipUrl = `${url}.gz`;

    console.log(`Checking: ${url}`);

    try {
        const res = await fetch(url);
        console.log(`JSON Status: ${res.status}`);

        const resGz = await fetch(gzipUrl);
        console.log(`GZIP Status: ${resGz.status}`);

        if (res.ok) console.log('JSON Found ✅');
        else if (resGz.ok) console.log('GZIP Found ✅');
        else console.log('❌ Not Found');

    } catch (e) {
        console.error('Fetch Error:', e.message);
    }
}

// Test known entities
testFetch('google/gemma-2-9b');
testFetch('arxiv/2310.06825'); // Paper
