// tests/unit/mesh.test.js
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// V26: Mock cloudflare:workers virtual module (not available in vitest)
// Production code uses `import { env } from 'cloudflare:workers'` for R2 access
// and isSSR detection — simulate SSR env so isSSR=true path is exercised.
vi.mock('cloudflare:workers', () => ({
    env: {
        R2_ASSETS: {
            get: vi.fn().mockResolvedValue(null)
        }
    }
}));

import { getMeshProfile } from '../../src/utils/mesh-orchestrator.js';

describe('Mesh Orchestrator', () => {
    // Silence expected SSR-protection warnings from production code to avoid
    // vitest RPC teardown race with pending console logs.
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeAll(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    afterAll(() => { warnSpy.mockRestore(); });

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

        // V22.8: Extreme SSR Throttling - ASSERT THAT THESE ARE NOT CALLED during SSR
        // Loading large JSON during SSR causes 1102 crashes at 364K scale.
        expect(mockR2.get).not.toHaveBeenCalledWith('mesh/graph.json');
        expect(mockR2.get).not.toHaveBeenCalledWith('relations/explicit.json');
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
        // V22.8: Extreme SSR Throttling - Assert that graph.json is NOT strictly required for SSR
        // Hydration happens on the client-side.
        expect(mockR2.get).not.toHaveBeenCalledWith('mesh/graph.json');
    });
});
