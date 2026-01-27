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
        const node = profile.nodeRegistry.get('fine-tuning');
        expect(node).toBeDefined();
        expect(node.id).toBe('knowledge--fine-tuning');
        expect(node.norm).toBe('fine-tuning');
    });
});
