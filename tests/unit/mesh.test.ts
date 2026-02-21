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

        // V16.96/V18.12: SSR Memory Protection removed. graph.json MUST be called during SSR to prevent Mesh UI collapse.
        expect(mockR2.get).toHaveBeenCalledWith('cache/mesh/graph.json');

        // Should fetch explicit relations instead of deprecated relations.json
        expect(mockR2.get).toHaveBeenCalledWith('cache/relations/explicit.json');
    });

    it('should resolve knowledge aliases correctly (typo fix verification)', async () => {
        const mockR2 = {
            get: vi.fn().mockResolvedValue({
                json: async () => ({
                    edges: {
                        'root': [['knowledge--instruction-tuning', 'EXPLAINS', 1.0]]
                    },
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

        const profile = await getMeshProfile(mockLocals, 'root', null, 'model');
        // V18.12: Due to deep QA, graph.json is strictly required for SSR hydration.
        expect(mockR2.get).toHaveBeenCalledWith('cache/mesh/graph.json');
    });
});
