import { getMeshProfile } from './src/utils/mesh-orchestrator.js';

async function debug() {
    const locals = {
        runtime: {
            env: {
                R2_ASSETS: {
                    get: async (key) => {
                        console.log(`[R2 SHIM] fetching ${key}`);
                        try {
                            const res = await fetch(`https://cdn.free2aitools.com/${key}`);
                            if (!res.ok) return null;
                            const text = await res.text();
                            return {
                                json: async () => JSON.parse(text),
                                text: async () => text
                            };
                        } catch (e) {
                            return null;
                        }
                    }
                }
            }
        }
    };

    const rootId = 'athina-ai--rag-cookbooks';
    const type = 'agent';

    console.log('--- Debugging getMeshProfile ---');
    try {
        const profile = await getMeshProfile(locals, rootId, null, type);
        console.log('Tiers results:');
        Object.entries(profile.tiers).forEach(([key, tier]) => {
            console.log(`  ${key}: ${tier.nodes.length} nodes`);
        });

        const hasRelations = Object.values(profile.tiers).some(t => t.nodes.length > 0);
        console.log('hasRelations:', hasRelations);
    } catch (e) {
        console.error('Error in getMeshProfile:', e);
    }
}

debug();
