import { describe, it, expect } from 'vitest';
import { withOpTimeout, isOpTimeout, OpTimeoutError } from './op-timeout.js';

// V27.97: prove the per-op timeout firewall (B) rejects the REQUEST at the
// deadline WITHOUT cancelling the loser, and that a promise-chain lock
// (the wa-sqlite Asyncify guard in sqlite-engine.ts) self-heals after the slow
// loser finishes — i.e. NO force-release is needed and the next op through the
// same lock still completes with no corruption/hang.

describe('withOpTimeout firewall', () => {
    it('rejects with a tagged transient error at the deadline', async () => {
        const slow = new Promise<string>(r => setTimeout(() => r('slow'), 8000));
        const t0 = Date.now();
        let caught: any = null;
        try {
            await withOpTimeout(slow, 50, 'mock:slow-read');
        } catch (e) {
            caught = e;
        }
        const elapsed = Date.now() - t0;
        expect(caught).toBeInstanceOf(OpTimeoutError);
        expect(isOpTimeout(caught)).toBe(true);
        // Aborts at ~deadline, NOT after the 8s op.
        expect(elapsed).toBeLessThan(2000);
    });

    it('resolves normally when the op beats the deadline', async () => {
        const fast = Promise.resolve('ok');
        await expect(withOpTimeout(fast, 5000, 'mock:fast')).resolves.toBe('ok');
    });

    it('lock self-heals: slow op times out the request but the lock is released by the loser, so the next op through the SAME lock completes', async () => {
        // Mirror sqlite-engine.ts withLock: a promise-chain lock that releases in
        // its own finally. We deliberately do NOT force-release on timeout.
        let lock: Promise<void> = Promise.resolve();
        const order: string[] = [];
        async function withLock<T>(fn: () => Promise<T>): Promise<T> {
            const prev = lock;
            let release!: () => void;
            lock = new Promise(res => (release = res));
            await prev;
            try {
                return await fn();
            } finally {
                release();
            }
        }

        // Op A: slow (simulates a stalled cold R2-VFS read holding the lock).
        const opA = withLock(async () => {
            await new Promise(r => setTimeout(r, 400));
            order.push('A-finished');
            return 'A';
        });

        // The REQUEST races opA against a 50ms deadline and aborts fast.
        let timedOut = false;
        try {
            await withOpTimeout(opA, 50, 'mock:A');
        } catch (e) {
            timedOut = isOpTimeout(e);
        }
        expect(timedOut).toBe(true);
        // A is still running in the background (loser was NOT cancelled).
        expect(order).not.toContain('A-finished');

        // Op B: a normal fast request through the SAME lock. It self-serializes
        // behind A (await prev) and MUST complete once A releases — no hang, no
        // corruption, no force-release.
        const b = await withOpTimeout(
            withLock(async () => {
                order.push('B-finished');
                return 'B';
            }),
            5000, 'mock:B');

        expect(b).toBe('B');
        // A released its lock before B ran -> the chain healed itself.
        expect(order).toEqual(['A-finished', 'B-finished']);
        // Let A's settled promise be observed so no unhandled rejection lingers.
        await opA;
    });
});
