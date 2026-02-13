
// Simulation of packet-loader.ts logic in Node environment (Verified)
// Usage: node scripts/debug-loader-repro.js

const R2_CACHE_URL = 'https://cdn.free2aitools.com';

async function fetchCompressedJSON(path) {
    const fullUrl = path.startsWith('http') ? path : `${R2_CACHE_URL}/${path}`;
    const candidates = fullUrl.endsWith('.gz') ? [fullUrl] : [`${fullUrl}.gz`, fullUrl];

    for (const url of candidates) {
        console.log(`[Fetch] Trying: ${url}`);
        try {
            const res = await fetch(url);
            if (!res.ok) {
                console.log(`[Fetch] 404/Error: ${url}`);
                continue;
            }

            // Simplified for Repro (Text Only, skipping unzip complexity for speed unless needed)
            // In real app we use arrayBuffer + unzip
            // Here we just check if it returns VALID JSON or GZIP signature
            const buffer = await res.arrayBuffer();
            console.log(`[Fetch] Success: ${url}, Bytes: ${buffer.byteLength}`);

            // Naive JSON parse check (assuming uncompressed for now or transparent Decompression)
            try {
                const text = new TextDecoder().decode(buffer);
                const json = JSON.parse(text);
                return { data: json, path: url };
            } catch (e) {
                console.log(`[Fetch] JSON Parse Failed (Likely Gzipped): ${url}`);
                // In a real repro we would unzip, but for path discovery validation, 
                // knowing we HIT the file and failed to parse is enough to prove EXISTENCE.
                return { data: { _raw: 'gzipped_content' }, path: url };
            }
        } catch (e) {
            console.log(`[Fetch] Net Error: ${e.message}`);
        }
    }
    return null;
}

// Logic from entity-cache-reader-core.js (Simplified)
function getR2PathCandidates(type, slug) {
    const candidates = [];
    const lowerSlug = slug.toLowerCase();

    // 1. Fused
    candidates.push(`cache/fused/${lowerSlug}.json`);
    candidates.push(`cache/fused/hf-model--${lowerSlug}.json`); // Simulating prefix injection

    // 2. Entities
    candidates.push(`cache/entities/${lowerSlug}.json`);
    candidates.push(`cache/entities/${type}/${lowerSlug}.json`);
    candidates.push(`cache/entities/hf-model--${lowerSlug}.json`);

    return candidates;
}

async function loadEntityStreams(type, slug) {
    console.log(`\n=== DEBUG LOAD: ${type}/${slug} ===`);
    const candidates = getR2PathCandidates(type, slug);

    const fusedCandidates = candidates.filter(c => c.includes('/fused/'));
    const entityCandidates = candidates.filter(c => c.includes('/entities/'));
    const meshCandidates = candidates.map(c => c.replace('/entities/', '/mesh/profiles/').replace('/fused/', '/mesh/profiles/'));

    const findFirst = async (list) => {
        for (const p of list) {
            const res = await fetchCompressedJSON(p);
            if (res) return res;
        }
        return null;
    }

    const [fusedResult, entityResult, meshResult] = await Promise.all([
        findFirst(fusedCandidates),
        findFirst(entityCandidates),
        findFirst(meshCandidates)
    ]);

    console.log('\n=== RESULTS ===');
    console.log('Fused:', fusedResult ? fusedResult.path : 'NULL');
    console.log('Entity:', entityResult ? entityResult.path : 'NULL');
    console.log('Mesh:', meshResult ? meshResult.path : 'NULL');

    const fusedPack = fusedResult?.data;
    // THE SUSPECT LOGIC:
    const entityPack = entityResult?.data || (fusedPack?.entity ? fusedPack.entity : (fusedPack?.id ? fusedPack : null));

    console.log('\n=== FINAL ENTITY PACK ===');
    console.log(entityPack ? 'FOUND' : 'MISSING');
    if (entityPack) {
        console.log('ID:', entityPack.id);
        console.log('Name:', entityPack.name);
        console.log('Keys:', Object.keys(entityPack).slice(0, 5));
    }
}

// EXECUTE
// Test case: A known model that might be failing 
// (Using 'meta-llama/llama-3-8b' as standard test)
(async () => {
    await loadEntityStreams('model', 'meta-llama/llama-3-8b');
})();
