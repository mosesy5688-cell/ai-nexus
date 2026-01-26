
import { fetchMeshRelations, stripPrefix, isMatch } from './src/utils/knowledge-cache-reader.js';

async function testIngestion(id) {
    console.log(`\n--- Testing Ingestion for: ${id} ---`);

    // Mock locals for SSR simulation
    const locals = {
        runtime: {
            env: {
                R2_ASSETS: {
                    get: async (key) => {
                        const res = await fetch(`https://cdn.free2aitools.com/${key}`);
                        if (!res.ok) return null;
                        const data = await res.json();
                        return { json: async () => data };
                    }
                }
            }
        }
    };

    try {
        const relations = await fetchMeshRelations(locals, id);
        console.log(`   [Result] Found ${relations.length} relations.`);

        if (relations.length === 0) {
            console.warn(`   [Warning] 0 relations for ${id}.`);
            const res = await fetch(`https://cdn.free2aitools.com/cache/mesh/graph.json`);
            const data = await res.json();
            const keys = Object.keys(data.edges || {});
            const matches = keys.filter(k => k.toLowerCase().includes('llama-3-8b'));

            if (matches.length > 0) {
                const testMatch = matches[0];
                const aNorm = stripPrefix(testMatch);
                const bNorm = stripPrefix(id);
                const aClean = aNorm.replace(/[^a-z0-9]/g, '');
                const bClean = bNorm.replace(/[^a-z0-9]/g, '');

                console.log(`   [Audit] Source: ${testMatch} -> Norm: ${aNorm} -> Clean: ${aClean}`);
                console.log(`   [Audit] Target: ${id} -> Norm: ${bNorm} -> Clean: ${bClean}`);
                console.log(`   [Audit] aClean.includes(bClean):`, aClean.includes(bClean));
                console.log(`   [Audit] bClean.includes(aClean):`, bClean.includes(aClean));
            }
        }
    } catch (e) {
        console.error(`   [Error] Ingestion failed:`, e.message);
    }
}

async function run() {
    await testIngestion('hf-model--meta-llama--llama-3-8b');
    await testIngestion('hf-dataset--ashishbadal18--32000-songs-ragas-mental-health-classification');
}

run();
