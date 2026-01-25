
import { getMeshProfile } from '../src/utils/mesh-orchestrator.js';
import { stripPrefix, getRouteFromId } from '../src/utils/mesh-routing-core.js';

// Mocking Astro.locals
const mockLocals = {
    runtime: {
        env: {
            R2_ASSETS: {
                get: async (key) => {
                    if (key === 'cache/mesh/graph.json') {
                        return {
                            json: async () => ({
                                nodes: {
                                    'hf-model--llama': { n: 'Llama', t: 'model' },
                                    'sciphi-ai/r2r': { n: 'R2R Framework', t: 'agent' },
                                    'knowledge--rag': { n: 'RAG', t: 'knowledge' }
                                },
                                edges: {
                                    'hf-model--llama': [
                                        { target: 'sciphi-ai/r2r', type: 'USED_BY' },
                                        { target: 'knowledge--rag', type: 'EXPLAINS' }
                                    ]
                                },
                                _v: '16.2'
                            })
                        };
                    }
                    if (key === 'cache/knowledge/index.json') {
                        return {
                            json: async () => ({
                                articles: [{ slug: 'rag' }]
                            })
                        };
                    }
                    return null;
                }
            }
        }
    }
};

async function testType(id, type) {
    console.log(`\n>>> Testing Type: ${type} (ID: ${id})`);
    try {
        const profile = await getMeshProfile(mockLocals, id, null, type);
        let count = 0;
        Object.entries(profile.tiers).forEach(([key, tier]) => {
            console.log(`  Tier [${key}]: ${tier.nodes.length} nodes`);
            tier.nodes.forEach(n => {
                count++;
                console.log(`    - ${n.icon} ${n.name} (${n.type}) -> ${getRouteFromId(n.id, n.type)}`);
            });
        });
        if (count === 0) console.warn("  ⚠️ Warning: No relations found for this entity.");
    } catch (err) {
        console.error(`  💥 ERROR for ${type}:`, err.message);
        throw err;
    }
}

async function runAll() {
    console.log("--- Comprehensive Mesh Multi-Type Test ---");
    await testType('hf-model--llama', 'model');
    await testType('agent--lavague', 'agent');
    await testType('dataset--mnist', 'dataset');
    await testType('tool--ncnn', 'tool');
    await testType('paper--arxiv--123', 'paper');
    await testType('space--demo', 'space');
    await testType('knowledge--rag', 'knowledge');
    console.log("\n✅ All 7 scenarios executed without 500/Crash.");
}

runAll().catch(err => {
    console.error(err);
    process.exit(1);
});
