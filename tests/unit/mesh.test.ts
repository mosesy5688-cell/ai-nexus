// tests/unit/mesh.test.js
import { describe, it, expect, vi } from 'vitest';
import { getMeshProfile } from '../../src/utils/mesh-orchestrator.js';

describe('Mesh Orchestrator', () => {
    it('should orchestrate mesh profile without throwing (typo fix verification)', async () => {
        const mockR2 = {
            get: vi.fn().mockResolvedValue({
                json: async () => ({
                    edges: {},
                    nodes: {},
                    articles: []
                })
            })
        };

        const mockLocals = {
            runtime: {
                env: {
                    R2_ASSETS: mockR2
                }
            }
        };

        const profile = await getMeshProfile(mockLocals, 'knowledge--mmlu', null, 'knowledge');
        expect(profile).toBeDefined();
        expect(profile.tiers).toBeDefined();
        expect(profile.tiers.explanation).toBeDefined();
        expect(mockR2.get).toHaveBeenCalledWith('cache/mesh/graph.json');
    });
});
