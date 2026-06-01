/**
 * Per-op timeout firewall (V27.97).
 *
 * A single cold R2-VFS op (open handle / range-read driven SQL step) can stall
 * far past CF Worker's ~30s wall-clock limit, surfacing to Googlebot as a 524.
 * `withOpTimeout` races the op against a deadline so the REQUEST returns fast.
 *
 * CRITICAL — this does NOT cancel the underlying op. `Promise.race` only settles
 * with whichever side wins; the loser keeps running. That is exactly what we
 * want here: the in-flight SQLite op holds the promise-chain lock in
 * sqlite-engine.ts (withLock) and MUST be allowed to finish so it releases its
 * own lock via its `finally` and warms the connection cache. The next request's
 * withLock already `await prevLock`, so it self-serializes behind the survivor.
 * Force-releasing or resetting the lock/VFS on timeout would reintroduce the
 * wa-sqlite Asyncify re-entrancy bug (two interleaved ops on one WASM module =
 * memory corruption). The promise-chain lock is self-healing; leave it alone.
 */

export const VFS_OP_TIMEOUT = 'VFS_OP_TIMEOUT';

export class OpTimeoutError extends Error {
    readonly code = VFS_OP_TIMEOUT;
    constructor(label: string, ms: number) {
        super(`Op '${label}' exceeded ${ms}ms deadline`);
        this.name = 'OpTimeoutError';
    }
}

export function isOpTimeout(e: any): boolean {
    return !!e && e.code === VFS_OP_TIMEOUT;
}

/**
 * Resolve with the op result if it settles before `ms`, else reject with an
 * OpTimeoutError. The op promise is NOT cancelled and keeps running in the
 * background (see file header). The timer is always cleared so it cannot leak
 * past the request when the op wins.
 */
export function withOpTimeout<T>(op: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OpTimeoutError(label, ms)), ms);
    });
    return Promise.race([op, deadline]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T>;
}
