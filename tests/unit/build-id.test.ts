import { describe, it, expect } from 'vitest';
// @ts-ignore — JS ESM helper (no .d.ts); tested for its runtime contract.
import { deriveBuildId } from '../../scripts/factory/lib/build-id.js';

// B4 build-id source: ONE value per bake, never per-writer / never runtime-random
// on the read side. deriveBuildId() is the single capture pack-db.js threads to
// both id-index-generator.js and pack-finalizer.js. R5 MF-3 folded GITHUB_RUN_ATTEMPT
// into the format so a GitHub "Re-run jobs" (same run_id, new attempt) mints a
// DISTINCT build_id -> distinct write-once cycle prefix -> no collision.
// (This replaces scripts/factory/build-id.test.mjs 1:1 and updates the pinned format.)

describe('deriveBuildId — bake coherence token source (R5 run_attempt format)', () => {
    it('CI build_id embeds run_id + run_attempt + short sha', () => {
        expect(deriveBuildId({ GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'abcdef1234567890' }))
            .toBe('run-12345-a1-abcdef123456');
    });

    it('(MF-3) same run_id + DIFFERENT run_attempt => DISTINCT build_id (no write-once collision)', () => {
        const sha = 'aaaaaaaaaaaa1111';
        const a1 = deriveBuildId({ GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha });
        const a2 = deriveBuildId({ GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: sha });
        expect(a1).not.toBe(a2);
        expect(a1).toBe('run-100-a1-aaaaaaaaaaaa');
        expect(a2).toBe('run-100-a2-aaaaaaaaaaaa');
    });

    it('missing GITHUB_RUN_ATTEMPT defaults to a1 (never a bare run-<id>)', () => {
        expect(deriveBuildId({ GITHUB_RUN_ID: '55', GITHUB_SHA: 'ffffffffffff2222' })).toBe('run-55-a1-ffffffffffff');
        // run-id only (no sha) sibling
        expect(deriveBuildId({ GITHUB_RUN_ID: '42', GITHUB_SHA: '' })).toBe('run-42-a1');
        expect(deriveBuildId({ GITHUB_RUN_ID: '42' })).toBe('run-42-a1');
    });

    it('two DISTINCT run_ids still differ (cron-vs-cron uniqueness preserved)', () => {
        const sha = 'a'.repeat(16);
        expect(deriveBuildId({ GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha }))
            .not.toBe(deriveBuildId({ GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: sha }));
    });

    it('is STABLE for a fixed bake env (same value for both writers / capture-once)', () => {
        const env = { GITHUB_RUN_ID: '999', GITHUB_RUN_ATTEMPT: '3', GITHUB_SHA: 'deadbeefcafebabe' };
        expect(deriveBuildId(env)).toBe(deriveBuildId(env));
    });

    it('local (no CI env) falls back to a single local-<epoch> token', () => {
        expect(deriveBuildId({})).toMatch(/^local-\d+$/);
    });

    it('(RED-restore) run_attempt is load-bearing — the pre-R5 format DID collide', () => {
        const legacy = (env: any) => `run-${env.GITHUB_RUN_ID}-${(env.GITHUB_SHA || '').slice(0, 12)}`;
        const e1 = { GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'a'.repeat(16) };
        const e2 = { GITHUB_RUN_ID: '100', GITHUB_RUN_ATTEMPT: '2', GITHUB_SHA: 'a'.repeat(16) };
        expect(legacy(e1)).toBe(legacy(e2));            // the bug (RED)
        expect(deriveBuildId(e1)).not.toBe(deriveBuildId(e2)); // the fix (GREEN)
    });
});
