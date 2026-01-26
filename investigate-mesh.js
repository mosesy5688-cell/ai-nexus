
import { fetchMeshRelations, stripPrefix, isMatch } from './src/utils/knowledge-cache-reader.js';

async function audit(id) {
    console.log(`\n--- Audit for: ${id} ---`);

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
            console.warn(`   [Warning] 0 relations matched.`);
            const res = await fetch(`https://cdn.free2aitools.com/cache/mesh/graph.json`);
            const data = await res.json();
            const keys = Object.keys(d.edges || {});
            const slug = stripPrefix(id);
            const matches = keys.filter(k => k.toLowerCase().includes(slug));
            console.log(`   [Audit] Raw matches in Graph:`, matches);
        } else {
            relations.forEach(r => {
                console.log(`      - ${r.target_id} (${r.relation_type}) [${r.target_type}]`);
            });
        }
    } catch (e) {
        console.error(`   [Error] Audit failed:`, e.message);
    }
}

async function run() {
    await audit('hf-model--google--imagen-3');
    await audit('hf-model--google--imagen-2');
    await audit('hf-model--google--gemini-pro');
}

run();
