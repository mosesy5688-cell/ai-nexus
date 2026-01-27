
import { fetchMeshRelations } from './src/utils/knowledge-cache-reader.js';
import { getMeshProfile } from './src/utils/mesh-orchestrator.js';

async function testImagen() {
    console.log('\n--- Simulating Imagen-3 Perfection Check ---');

    // Mock entity data (Google Imagen-3)
    const entity = {
        id: 'google--imagen-3',
        title: 'Imagen 3',
        author: 'Google',
        fni_score: 95,
        params_billions: 50, // Hypothetical
        type: 'model'
    };

    const locals = {
        runtime: {
            env: {
                R2_ASSETS: {
                    get: async (key) => {
                        console.log(`   [R2 Mock] Fetching: ${key}`);
                        const res = await fetch('https://cdn.free2aitools.com/' + key);
                        if (!res.ok) return null;
                        const data = await res.json();
                        return { json: async () => data };
                    }
                }
            }
        }
    };

    try {
        const relations = await fetchMeshRelations(locals, entity.id);
        console.log(`   [Mesh] Raw Relations Found: ${relations.length}`);

        const profile = getMeshProfile(entity, 'model', relations, locals);

        console.log('   [Result] Tiers Summary:');
        Object.entries(profile.tiers).forEach(([key, tier]) => {
            if (tier.nodes.length > 0) {
                console.log(`      - ${key}: ${tier.nodes.length} nodes`);
                tier.nodes.slice(0, 5).forEach(n => console.log(`         -> ${n.id} (${n.relation})`));
            }
        });

        const nodeIds = profile.tiers.explanation.nodes.map(n => n.id);
        if (nodeIds.includes('knowledge--image-generation') || nodeIds.includes('knowledge--transformer')) {
            console.log('\n✅ SUCCESS: Enrichment triggered. Sparse data covered by Heuristics.');
        } else {
            console.warn('\n❌ FAILURE: Still missing key ecosystem nodes.');
        }
    } catch (e) {
        console.error('   [Error] Check failed:', e.message);
    }
}

testImagen();
