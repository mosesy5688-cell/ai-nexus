/**
 * R2 Physical Integrity Audit V1.0
 * 
 * Verifies if the IDs listed in the graph actually exist as JSON shards in R2.
 */

import zlib from 'node:zlib';

const CDN_URL = 'https://cdn.free2aitools.com';
const SAMPLE_SIZE = 1000;

async function runAudit() {
    console.log(`[R2-AUDIT] Starting physical integrity audit (Sample size: ${SAMPLE_SIZE})...`);

    // 1. Fetch Graph
    console.log(' - Fetching production graph...');
    const res = await fetch(`${CDN_URL}/cache/mesh/graph.json.gz`);
    if (!res.ok) {
        console.error('FAILED to fetch graph.json.gz');
        return;
    }

    const buffer = await res.arrayBuffer();
    const uint8 = new Uint8Array(buffer);
    const isActuallyGzip = uint8.length > 2 && uint8[0] === 0x1f && uint8[1] === 0x8b;

    let graphData;
    if (isActuallyGzip) {
        graphData = JSON.parse(zlib.gunzipSync(Buffer.from(buffer)).toString());
    } else {
        graphData = JSON.parse(new TextDecoder().decode(buffer));
    }
    const nodes = graphData.nodes || [];
    console.log(` - Graph loaded: ${nodes.length} nodes found.`);

    // 2. Sampling
    const sample = [];
    const step = Math.max(1, Math.floor(nodes.length / SAMPLE_SIZE));
    for (let i = 0; i < nodes.length; i += step) {
        sample.push(nodes[i]);
        if (sample.length >= SAMPLE_SIZE) break;
    }
    console.log(` - Sampled ${sample.length} nodes for verification.`);

    // 3. Verifying (Parallelised within limits)
    let passed = 0;
    let failed = 0;
    const failures = [];

    const CHUNK_SIZE = 50;
    for (let i = 0; i < sample.length; i += CHUNK_SIZE) {
        const chunk = sample.slice(i, i + CHUNK_SIZE);
        await Promise.all(chunk.map(async (node) => {
            const id = node.id;
            const type = node.type || 'model';
            // Try common R2 candidate paths
            const paths = [
                `cache/entities/${type}/${id}.json.gz`,
                `cache/entities/${id}.json.gz`,
                `cache/fused/${id}.json.gz`
            ];

            let found = false;
            for (const path of paths) {
                try {
                    const headRes = await fetch(`${CDN_URL}/${path}`, { method: 'HEAD' });
                    if (headRes.ok) {
                        found = true;
                        break;
                    }
                } catch (e) { }
            }

            if (found) {
                passed++;
            } else {
                failed++;
                failures.push(id);
                process.stdout.write('F');
            }
            if ((passed + failed) % 10 === 0) process.stdout.write('.');
        }));
    }

    console.log('\n\n[AUDIT COMPLETE]');
    console.log(` - Total Sampled: ${sample.length}`);
    console.log(` - Physical Files Found: ${passed}`);
    console.log(` - Missing Shards (404): ${failed}`);
    console.log(` - Integrity Score: ${((passed / sample.length) * 100).toFixed(2)}%`);

    if (failed > 0) {
        console.log('\nTop 10 Missing Shards:');
        failures.slice(0, 10).forEach(f => console.log(` - ${f}`));
    }

    if (passed / sample.length < 0.95) {
        console.log('\n[CRITICAL] Integrity score below 95%! Evidence of significant data pollution or R2 sync failure.');
    }
}

runAudit().catch(console.error);
