import { describe, it, expect } from 'vitest';
// @ts-ignore — JS ESM helper (no .d.ts); tested for its runtime contract.
import { deriveBuildId } from '../../scripts/factory/lib/build-id.js';

// B4 build-id source: ONE value per bake, never per-writer / never runtime-random
// on the read side. deriveBuildId() is the single capture pack-db.js threads to
// both id-index-generator.js and pack-finalizer.js. These assert it is stable for
// a given bake env and distinguishes two re-bakes of the SAME commit.

describe('deriveBuildId — bake coherence token source', () => {
    it('prefers GITHUB_RUN_ID (the per-bake CI run id) + short sha', () => {
        const id = deriveBuildId({ GITHUB_RUN_ID: '12345', GITHUB_SHA: 'abcdef1234567890' });
        expect(id).toBe('run-12345-abcdef123456');
    });

    it('two re-bakes of the SAME commit get DISTINCT ids (run-id differs)', () => {
        // The whole point: a cron re-run of unchanged main has the same SHA but a
        // new run-id, so the two bakes are distinguishable (a bare SHA could not).
        const sha = 'abcdef1234567890';
        const a = deriveBuildId({ GITHUB_RUN_ID: '12345', GITHUB_SHA: sha });
        const b = deriveBuildId({ GITHUB_RUN_ID: '12346', GITHUB_SHA: sha });
        expect(a).not.toBe(b);
    });

    it('is STABLE for a fixed bake env (same value for both writers)', () => {
        const env = { GITHUB_RUN_ID: '999', GITHUB_SHA: 'deadbeefcafebabe' };
        expect(deriveBuildId(env)).toBe(deriveBuildId(env)); // captured once == itself
    });

    it('run-id only (no sha) still yields a stable token', () => {
        expect(deriveBuildId({ GITHUB_RUN_ID: '42', GITHUB_SHA: '' })).toBe('run-42');
    });

    it('local (no CI env) falls back to a single local-<epoch> token (non-empty)', () => {
        const id = deriveBuildId({});
        expect(id).toMatch(/^local-\d+$/);
    });
});
