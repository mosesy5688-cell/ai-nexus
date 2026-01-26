
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
            const matches = keys.filter(k => k.toLowerCase().includes('llama-3') && k.includes('70b'));
            console.log(`   [Audit] Candidate keys in graph.json:`, matches);

            if (matches.length > 0) {
                const testMatch = matches[0];
                console.log(`   [Audit] Testing isMatch('${testMatch}', '${id}'):`, isMatch(testMatch, id));
            }
        } else {
            relations.slice(0, 10).forEach(r => {
                console.log(`      - ${r.target_id} (${r.relation_type}) [Type: ${r.target_type}]`);
            });
        }
    } catch (e) {
        console.error(`   [Error] Ingestion failed:`, e.message);
    }
}

async function run() {
    await testIngestion('hf-model--meta-llama--llama-3-70b-instruct');
    // Also test a known working one for baseline
    await testIngestion('kaggle--athina-ai--rag-cookbooks');
}

run();
