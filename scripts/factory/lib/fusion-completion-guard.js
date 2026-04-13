/**
 * Fusion Completion Guard — §18.22.4 silent early-exit defense.
 *
 * Field incident: Master Fusion exited cleanly after fusing 86/448 shards
 * with no error, no banner, exit code interpreted as 0 by GHA — silently
 * dropping 80% of entities downstream. Root cause was a native-level abort
 * (likely Rust NAPI panic in downloadBufferFromR2FFI) that bypasses Node's
 * 'exit' event entirely.
 *
 * Three layered defenses, in increasing order of reliability:
 *   1. process.on('exit') guard — works for normal exits, NOT native aborts
 *   2. Post-loop assertion — works if the loop exits "normally" but short
 *   3. Sentinel file — the ONLY mechanism that survives native crashes,
 *      verified by a separate GHA step (see factory-upload.yml).
 */
import fs from 'fs/promises';
import path from 'path';

export function installExitGuard(getState) {
    const handler = (code) => {
        const { processed, expected } = getState();
        if (processed < expected && (code === 0 || code === undefined)) {
            console.error(`[FUSION] CRITICAL: process exited after fusing only ${processed}/${expected} shards. Forcing exit code 1 to fail the workflow step.`);
            process.exitCode = 1;
        }
    };
    process.on('exit', handler);
    return handler;
}

export function assertCompletion(processed, expected) {
    if (processed < expected) {
        throw new Error(`[FUSION] CRITICAL: fused only ${processed}/${expected} shards. Refusing to write a partial fusion that would silently drop ${expected - processed} shards' worth of entities.`);
    }
}

export async function writeSentinel(outDir, payload) {
    await fs.writeFile(path.join(outDir, '.complete'), JSON.stringify({
        ...payload,
        completedAt: new Date().toISOString()
    }));
}
