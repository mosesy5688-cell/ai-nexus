// tests/unit/r2-upload-synced-stamp-success-set.test.ts — PR-alpha gate-1
// "failed-never-synced" (D-2026-0816-443 SS A.c / D-2026-0816-445 SS B, P8).
//
// DEFECT: scripts/factory/r2-upload-s3.js stamped EVERY queued file's localHash into
// last-upload-manifest.json after processQueue returned, including files whose upload
// FAILED. On the next cycle the Layer-2 MD5 comparison matches, the file is "Locally
// skipped", and the stale/missing public-CDN object is NEVER re-uploaded — with zero
// signal. Partial success recorded as full success (D-1/D-2 family, cf. FINDING-REST-1).
//
// Hermetic: no network, no credentials, no R2. Uses the REAL production functions
// (stampSyncedHashes / isLocallySynced) and the REAL JS upload engine (r2-helpers.js).
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { stampSyncedHashes, isLocallySynced } from '../../scripts/factory/r2-upload-s3.js';
import { uploadFile, uploadFileMultipart } from '../../scripts/factory/lib/r2-helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RUST = path.join(REPO, 'rust', 'r2-engine', 'src');

type QueuedFile = { path: string; size: number; localHash: string };

// One successful + one failed upload, in the exact shape main() builds filesToUpload.
const OK_LOCAL = 'output/data/ok.json';
const OK_REMOTE = 'data/ok.json';
const BAD_LOCAL = 'output/data/broken.json';
const BAD_REMOTE = 'data/broken.json';
const OK_HASH = 'a'.repeat(32);
const BAD_HASH = 'b'.repeat(32);
const BAD_HASH_NEXT = 'c'.repeat(32);

const fixture = (): QueuedFile[] => ([
    { path: OK_LOCAL, size: 10, localHash: OK_HASH },
    { path: BAD_LOCAL, size: 20, localHash: BAD_HASH },
]);
// processQueue's exit for that fixture: one PutObject failure.
const FAILED_PATHS = [BAD_REMOTE];

/** The pre-fix production loop, preserved verbatim as the defect's executable record. */
function legacyStampAll(manifestHashes: Record<string, string>, filesToUpload: QueuedFile[]) {
    for (const file of filesToUpload) {
        const remotePath = file.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^output\//, '');
        manifestHashes[remotePath] = file.localHash;
    }
}

/** main()'s Layer-2 filter, driven through the REAL exported predicate. */
function nextCycleQueue(manifestHashes: Record<string, string>, etags: Set<string>, files: QueuedFile[]) {
    const queue: string[] = [];
    const locallySkipped: string[] = [];
    for (const file of files) {
        const remotePath = file.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^output\//, '');
        if (isLocallySynced(manifestHashes, remotePath, file.localHash, etags)) locallySkipped.push(remotePath);
        else queue.push(remotePath);
    }
    return { queue, locallySkipped };
}

describe('PR-alpha: the synced stamp covers the success set only', () => {
    it('RED-before: the legacy unconditional loop stamps a FAILED upload as synced', () => {
        const hashes: Record<string, string> = {};
        legacyStampAll(hashes, fixture());
        // The defect, verbatim: the failed upload is recorded as synced.
        expect(hashes[BAD_REMOTE]).toBe(BAD_HASH);
        expect(Object.hasOwn(hashes, BAD_REMOTE)).toBe(true);
    });

    it('RED-before consequence: the stamped failure is never re-attempted (silent, permanent)', () => {
        const hashes: Record<string, string> = {};
        legacyStampAll(hashes, fixture());
        // Next cycle: unchanged bytes, and R2 has a STALE object under that key.
        const etags = new Set([OK_REMOTE, BAD_REMOTE]);
        const { queue, locallySkipped } = nextCycleQueue(hashes, etags, fixture());
        expect(locallySkipped).toContain(BAD_REMOTE);   // "Locally skipped" forever
        expect(queue).not.toContain(BAD_REMOTE);        // never re-uploaded
    });

    // MUTATION PIN — restoring the unconditional stamping loop in
    // scripts/factory/r2-upload-s3.js MUST turn THIS test red.
    it('MUTATION PIN: a failed upload is NOT stamped into the synced manifest', () => {
        const hashes: Record<string, string> = {};
        const stats = stampSyncedHashes(hashes, fixture(), FAILED_PATHS);
        expect(Object.hasOwn(hashes, BAD_REMOTE)).toBe(false);
        expect(hashes[BAD_REMOTE]).toBeUndefined();
        expect(stats.withheld).toBe(1);
    });

    it('KEEP symmetry: the SUCCESSFUL upload is still stamped normally (no over-correction)', () => {
        const hashes: Record<string, string> = {};
        const stats = stampSyncedHashes(hashes, fixture(), FAILED_PATHS);
        expect(hashes[OK_REMOTE]).toBe(OK_HASH);
        expect(stats.stamped).toBe(1);
        expect(Object.keys(hashes)).toEqual([OK_REMOTE]);
    });

    it('KEEP symmetry: with zero failures every queued file is stamped, exactly as before', () => {
        const hashes: Record<string, string> = {};
        const stats = stampSyncedHashes(hashes, fixture(), []);
        expect(hashes[OK_REMOTE]).toBe(OK_HASH);
        expect(hashes[BAD_REMOTE]).toBe(BAD_HASH);
        expect(stats).toEqual({ stamped: 2, withheld: 0 });
    });

    it('KEEP symmetry: an existing manifest entry for an unrelated key is preserved', () => {
        const hashes: Record<string, string> = { 'data/untouched.json': 'z'.repeat(32) };
        stampSyncedHashes(hashes, fixture(), FAILED_PATHS);
        expect(hashes['data/untouched.json']).toBe('z'.repeat(32));
    });

    // MUTATION PIN — the production consequence of the fix. Models the DANGEROUS case:
    // R2 already holds a STALE object under the failed key, so the etag map has it and
    // only the withheld stamp can force the re-upload.
    it('MUTATION PIN two-run: run 2 RE-ATTEMPTS the withheld file over a stale R2 object', () => {
        // Run 1 — one failure, stamped through the fixed path.
        const hashes: Record<string, string> = {};
        stampSyncedHashes(hashes, fixture(), FAILED_PATHS);
        // Run 2 — same bytes on disk; R2 holds the succeeded object AND a stale one.
        const etags = new Set([OK_REMOTE, BAD_REMOTE]);
        const { queue, locallySkipped } = nextCycleQueue(hashes, etags, fixture());
        expect(queue).toContain(BAD_REMOTE);            // the fix: re-attempted
        expect(locallySkipped).not.toContain(BAD_REMOTE);
        expect(locallySkipped).toContain(OK_REMOTE);    // preservation: still skipped
        expect(queue).not.toContain(OK_REMOTE);
    });

    it('two-run: a never-before-published failed key is also re-attempted', () => {
        const hashes: Record<string, string> = {};
        stampSyncedHashes(hashes, fixture(), FAILED_PATHS);
        const { queue } = nextCycleQueue(hashes, new Set([OK_REMOTE]), fixture());
        expect(queue).toContain(BAD_REMOTE);
    });

    it('two-run: once run 2 succeeds, the file IS stamped and run 3 skips it', () => {
        const hashes: Record<string, string> = {};
        stampSyncedHashes(hashes, fixture(), FAILED_PATHS);
        // Run 2 succeeds; content changed since run 1, so the hash differs.
        const run2 = [{ path: BAD_LOCAL, size: 20, localHash: BAD_HASH_NEXT }];
        stampSyncedHashes(hashes, run2, []);
        expect(hashes[BAD_REMOTE]).toBe(BAD_HASH_NEXT);
        const etags = new Set([OK_REMOTE, BAD_REMOTE]);
        expect(nextCycleQueue(hashes, etags, run2).locallySkipped).toContain(BAD_REMOTE);
    });

    it('a stale stamp from an EARLIER cycle is not resurrected by a later failure', () => {
        // The withheld path must also not silently keep an older, wrong hash alive.
        const hashes: Record<string, string> = { [BAD_REMOTE]: 'd'.repeat(32) };
        stampSyncedHashes(hashes, fixture(), FAILED_PATHS);
        // The failed file keeps its OLD entry (untouched), which no longer matches the
        // current localHash -> isLocallySynced is false -> it is re-queued next cycle.
        expect(hashes[BAD_REMOTE]).toBe('d'.repeat(32));
        const etags = new Set([OK_REMOTE, BAD_REMOTE]);
        expect(nextCycleQueue(hashes, etags, fixture()).queue).toContain(BAD_REMOTE);
    });
});

describe('dual-engine key domain: result.path is the REMOTE path in BOTH engines', () => {
    // The exclusion set (failedPaths) and the stamping set (manifest keys) must share
    // one key domain, or the exclusion silently misses and the defect returns.
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'pralpha-'));
    const local = path.join(tmp, 'local-name.json');
    writeFileSync(local, '{"k":1}');
    const remote = 'data/remote-name.json';

    it('JS engine: uploadFile SUCCESS returns path = remotePath, not localPath', async () => {
        const s3 = { send: async () => ({}) };
        const r = await uploadFile(s3, 'bucket', local, remote, undefined);
        expect(r).toMatchObject({ success: true, path: remote, skipped: false });
        expect(r.path).not.toBe(local);
    });

    it('JS engine: uploadFile FAILURE returns path = remotePath (the exclusion-set key)', async () => {
        const s3 = { send: async () => { throw new Error('PutObject boom'); } };
        // retryCount=3 == MAX_RETRIES -> terminal on the first attempt (no 7s backoff).
        const r = await uploadFile(s3, 'bucket', local, remote, undefined, 3);
        expect(r.success).toBe(false);
        expect(r.path).toBe(remote);
        expect(r.path).not.toBe(local);
    });

    it('JS engine: uploadFile MD5-SKIP returns path = remotePath', async () => {
        const etag = '9b8a5b8b73c2b0e2b0f4d6d9f0f4b0d3';
        const crypto = await import('crypto');
        const real = crypto.createHash('md5').update(readFileSync(local)).digest('hex');
        expect(real).not.toBe(etag);
        const r = await uploadFile({ send: async () => ({}) }, 'bucket', local, remote, real);
        expect(r).toMatchObject({ success: true, path: remote, skipped: true });
    });

    it('JS engine: uploadFileMultipart returns path = remotePath', async () => {
        const r = await uploadFileMultipart({ send: async () => ({}) }, 'bucket', local, remote);
        expect(r.path).toBe(remote);
        expect(r.path).not.toBe(local);
    });

    // Rust side (the default engine — r2-bridge.js routes to it unless R2_FORCE_JS=true).
    // A .node addon cannot be built inside this unit test, so the invariant is pinned
    // against the Rust source of truth: every UploadResult.path is remote_path.
    const rustFiles = ['operations.rs', 'batch.rs', 'multipart.rs'];
    it.each(rustFiles)('Rust engine: %s builds UploadResult.path from remote_path only', (f) => {
        const src = readFileSync(path.join(RUST, f), 'utf-8');
        const assigns = src.split('\n')
            .map((l, i) => ({ n: i + 1, t: l.trim() }))
            .filter(x => /^path:\s/.test(x.t));
        expect(assigns.length).toBeGreaterThan(0);
        for (const a of assigns) {
            expect(a.t, `${f}:${a.n} must key on remote_path`).toMatch(/^path:\s*remote_path\b/);
            expect(a.t).not.toMatch(/local_path/);
        }
    });

    it('#NEG anti-vacuity: the Rust scan would catch a local_path regression', () => {
        const poisoned = 'let r = UploadResult {\n        path: local_path.to_string(),\n    };';
        const assigns = poisoned.split('\n').map(l => l.trim()).filter(t => /^path:\s/.test(t));
        expect(assigns.length).toBe(1);
        expect(assigns[0]).not.toMatch(/^path:\s*remote_path\b/);
    });
});
