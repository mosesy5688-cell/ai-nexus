// tests/unit/mesh-test.js
import { getMeshProfile } from '../../src/utils/mesh-orchestrator.js';
import assert from 'assert';

// Mock data
const mockLocals = {
    runtime: {
        env: {
            R2_ASSETS: {
                get: async (key) => {
                    console.log(`Mock R2 get: ${key}`);
                    return {
                        json: async () => ({
                            edges: {},
                            nodes: {},
                            articles: []
                        })
                    };
                }
            }
        }
    }
};

async function testMeshProfile() {
    console.log('Starting mesh profile test...');
    try {
        const profile = await getMeshProfile(mockLocals, 'knowledge--mmlu', null, 'knowledge');
        assert(profile.tiers, 'Tiers should exist');
        assert(profile.tiers.explanation, 'Explanation tier should exist');
        console.log('✅ Mesh Profile orchestration succeeded (typo fix verified).');
    } catch (e) {
        console.error('❌ Mesh Profile test failed:', e);
        process.exit(1);
    }
}

testMeshProfile();
