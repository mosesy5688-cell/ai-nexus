import { describe, it, expect, afterEach, vi } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';
// @ts-ignore
import { getSourceFloor, evaluateFloorGate, DEFAULT_FLOORS } from '../../scripts/ingestion/harvest-floors.js';
// @ts-ignore
import { FetchError } from '../../scripts/ingestion/adapters/base-adapter.js';

// PR-H2a (fail loud): the KNOWN-LARGE-SOURCE FLOOR GATE lives ABOVE the
// adapters. The catch-and-return-empty HF adapters never set result.error, so a
// real outage would launder into a green "Complete | Total: 0". For a source in
// the floor map, a completed harvest (no adapter error) yielding below the floor
// must redden the job. Sources absent from the map are unaffected.

// A fake adapter that buffers `n` trivially-normalizable entities. harvestSingle
// streams the buffered array through processBatch -> results.total === n.
function bufferAdapter(n: number) {
    const items = Array.from({ length: n }, (_, i) => ({ id: `e${i}` }));
    return {
        entityTypes: ['model'],
        fetch: async () => items,
        normalize: (raw: any) => raw, // non-null -> counts toward results.total
    };
}

describe('harvest-floors — floor resolution + gate decision', () => {
    afterEach(() => {
        // Clear any env override set during a test.
        for (const k of Object.keys(process.env)) {
            if (k.startsWith('HARVEST_FLOOR_')) delete process.env[k];
        }
    });

    it('getSourceFloor returns the in-code default for a known-large source', () => {
        expect(getSourceFloor('arxiv')).toBe(DEFAULT_FLOORS.arxiv);
        expect(getSourceFloor('huggingface')).toBe(7000);
        expect(getSourceFloor('huggingface-papers')).toBe(200);
        expect(getSourceFloor('semanticscholar')).toBe(300);
    });

    it('getSourceFloor returns null for an un-mapped (small) source', () => {
        expect(getSourceFloor('ollama')).toBeNull();
        expect(getSourceFloor('civitai')).toBeNull();
    });

    it('getSourceFloor honors an env override (HARVEST_FLOOR_<SOURCE>)', () => {
        process.env.HARVEST_FLOOR_HUGGINGFACE_PAPERS = '999';
        expect(getSourceFloor('huggingface-papers')).toBe(999);
        process.env.HARVEST_FLOOR_ARXIV = '0';
        expect(getSourceFloor('arxiv')).toBe(0); // 0 is a valid (gate-disabling) floor
    });

    it('evaluateFloorGate does NOT fire when the adapter already errored (no double-report)', () => {
        const g = evaluateFloorGate({ sourceName: 'arxiv', count: 0, hadAdapterError: true });
        expect(g.violated).toBe(false);
    });

    it('evaluateFloorGate fires for a known-large source below floor (no adapter error)', () => {
        const g = evaluateFloorGate({ sourceName: 'github', count: 3, hadAdapterError: false });
        expect(g.violated).toBe(true);
        expect(g.floor).toBe(500);
    });

    it('evaluateFloorGate does not fire at/above floor', () => {
        expect(evaluateFloorGate({ sourceName: 'github', count: 500, hadAdapterError: false }).violated).toBe(false);
        expect(evaluateFloorGate({ sourceName: 'github', count: 9999, hadAdapterError: false }).violated).toBe(false);
    });
});

describe('harvest-single — floor gate trips the exit gate for near-zero known-large sources', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        for (const k of Object.keys(process.env)) {
            if (k.startsWith('HARVEST_FLOOR_')) delete process.env[k];
        }
    });

    it('known-large source BELOW floor (catch-and-return-empty outage) -> result.error set', async () => {
        // github floor = 500; a real outage that catch-returns [] yields 0.
        const result = await harvestSingle('github', {
            limit: 5, skipBridge: true, _adapter: bufferAdapter(0),
        });
        expect(result.error).toBeTruthy();
        expect(String(result.error)).toContain('floor violation');
        expect(result.count).toBe(0);
    });

    it('huggingface catch-and-return-empty outage -> floor gate sets result.error (latent laundering closed)', async () => {
        const result = await harvestSingle('huggingface', {
            limit: 5, skipBridge: true, _adapter: bufferAdapter(0),
        });
        expect(result.error).toBeTruthy();
        expect(String(result.error)).toContain('floor violation');
        expect(result.count).toBe(0);
    });

    it('known-large source AT/ABOVE floor -> NO result.error (stays success)', async () => {
        // Use an env override to keep the test cheap: floor 3, yield 3.
        process.env.HARVEST_FLOOR_GITHUB = '3';
        const result = await harvestSingle('github', {
            limit: 100, skipBridge: true, _adapter: bufferAdapter(3),
        });
        expect(result.error).toBeUndefined();
        expect(result.count).toBe(3);
    });

    it('un-floored (small) source yielding 0 -> NO result.error (small-source tolerance)', async () => {
        const result = await harvestSingle('ollama', {
            limit: 5, skipBridge: true, _adapter: bufferAdapter(0),
        });
        expect(result.error).toBeUndefined();
        expect(result.count).toBe(0);
    });

    it('adapter FetchError on a known-large source -> reports the adapter error (NOT a floor double-report)', async () => {
        const adapter = {
            entityTypes: ['model'],
            fetch: async () => { throw new FetchError('github', 'fetch', 'simulated outage'); },
            normalize: (raw: any) => raw,
        };
        const result = await harvestSingle('github', { limit: 5, skipBridge: true, _adapter: adapter });
        expect(result.error).toBeTruthy();
        // The error is the adapter's fetch failure, not the floor-violation message.
        expect(String(result.error)).not.toContain('floor violation');
    });
});
