import { describe, it, expect, beforeAll } from 'vitest';

// Vitest-collected hermetic suite for the R5 fence + failed-never-synced fix inside
// the sole public writer r2-upload-s3.js. The uploader is an injected spy — no
// network, no disk. Converted 1:1 from scripts/factory/r2-upload-fence.test.mjs.
//
// CONFIG.PREFIX_FILTER is built from env at module import — set the broad `data/`
// prefix (as production does) BEFORE importing (in beforeAll, before the dynamic
// import), so the exclusion (not the prefix filter) is what drops R5 staging paths.
// dotenv does not override an already-set key; the import.meta.url entry guard keeps
// main() from running under Vitest.
let processQueue: any, toRemotePath: any, applySyncedHashes: any;
beforeAll(async () => {
    process.env.R2_PREFIX_FILTER = 'data/,meta/,cache/';
    // @ts-ignore — JS ESM module (no .d.ts); tested for its runtime contract.
    const mod: any = await import('../../scripts/factory/r2-upload-s3.js');
    processQueue = mod.processQueue; toRemotePath = mod.toRemotePath; applySyncedHashes = mod.applySyncedHashes;
});

function fileList(remotePaths: string[], size = 10) { return remotePaths.map((rp) => ({ path: `output/${rp}`, size })); }
function makeUploader(failFor: Set<string> = new Set()) {
    const calls: string[] = [];
    const uploadFile = async (_s3: any, _localPath: string, remotePath: string) => {
        calls.push(remotePath);
        if (failFor.has(remotePath)) return { success: false, path: remotePath, error: 'boom' };
        return { success: true, path: remotePath, skipped: false };
    };
    const uploadFileMultipart = async (_s3: any, _localPath: string, remotePath: string) => { calls.push(remotePath); return { success: true, path: remotePath, parts: 1 }; };
    return { uploadFile, uploadFileMultipart, calls };
}
const run = (files: any[], up: any, over: any = {}) => processQueue(null, files, over.uploadedSet || new Set(), over.checkpoint || { uploaded: [] }, over.etag || new Map(), { uploadFile: up.uploadFile, uploadFileMultipart: up.uploadFileMultipart });

async function fenceUnder(eventName: string) {
    const saved = process.env.GITHUB_EVENT_NAME;
    process.env.GITHUB_EVENT_NAME = eventName;
    try {
        const files = fileList([
            'data/meta-00.db', 'data/id-index.bin', 'meta/x.json',
            'data/blobs/abc123', 'data/cycles/run-1-a1-x/manifest.json', 'data/quarantine/run-1-a1-x/abc.json',
        ]);
        const up = makeUploader();
        const res = await run(files, up);
        for (const key of up.calls) expect(/^data\/(blobs|cycles|quarantine)\//.test(key)).toBe(false);
        expect(up.calls.includes('data/meta-00.db') && up.calls.includes('data/id-index.bin')).toBe(true);
        expect(res.failedPaths.size).toBe(0);
        expect(up.calls.filter((k: string) => /^data\/(blobs|cycles|quarantine)\//.test(k)).length).toBe(0);
    } finally { process.env.GITHUB_EVENT_NAME = saved; }
}

describe('R5 fence — legacy path never touches staging prefixes (cron + manual)', () => {
    it('(UF-A1 / fence) CRON simulation: zero new-prefix PUT via the legacy path', () => fenceUnder('schedule'));
    it('(UF-A2 / fence) MANUAL dispatch simulation: zero new-prefix PUT via the legacy path', () => fenceUnder('workflow_dispatch'));
});

describe('R5 legacy success path unchanged', () => {
    it('(UF-B1) upload order preserved; adding R5 paths does NOT change the normal-file sequence', async () => {
        const normal = ['data/meta-00.db', 'data/meta-01.db', 'meta/a.json', 'cache/b.json'];
        const baseUp = makeUploader();
        const baseRes = await run(fileList(normal), baseUp);
        expect(baseUp.calls).toStrictEqual(normal);
        expect(baseRes.success).toBe(4);
        expect(baseRes.fail).toBe(0);
        const withR5 = ['data/meta-00.db', 'data/blobs/zzz', 'data/meta-01.db', 'data/cycles/c/manifest.json', 'meta/a.json', 'cache/b.json'];
        const r5Up = makeUploader();
        await run(fileList(withR5), r5Up);
        expect(r5Up.calls).toStrictEqual(normal);
    });
});

describe('R5 failed upload never stamped synced', () => {
    it('(UF-C1) processQueue reports a failed upload in failedPaths (not successes)', async () => {
        const files = fileList(['data/meta-00.db', 'data/meta-01.db']);
        const up = makeUploader(new Set(['data/meta-01.db']));
        const res = await run(files, up);
        expect(res.failedPaths.has('data/meta-01.db')).toBe(true);
        expect(res.failedPaths.has('data/meta-00.db')).toBe(false);
        expect(res.fail).toBe(1);
    });
    it('(UF-C2 / RED-restore) applySyncedHashes skips failed paths only; empty failset would stamp it', () => {
        const filesToUpload = [
            { path: 'output/data/meta-00.db', localHash: 'h0' },
            { path: 'output/data/meta-01.db', localHash: 'h1' },
        ];
        const failed = new Set(['data/meta-01.db']);
        const m = applySyncedHashes({ hashes: {} }, filesToUpload, failed);
        expect(m.hashes['data/meta-00.db']).toBe('h0');
        expect(m.hashes['data/meta-01.db']).toBeUndefined();
        // RED: without the fix (empty failset), the failed file WOULD be stamped.
        const bad = applySyncedHashes({ hashes: {} }, filesToUpload, new Set());
        expect(bad.hashes['data/meta-01.db']).toBe('h1');
    });
});

describe('R5 path mapping', () => {
    it('(UF-D2) toRemotePath strips ./ and output/ (path -> remote key mapping intact)', () => {
        expect(toRemotePath('output/data/meta-00.db')).toBe('data/meta-00.db');
        expect(toRemotePath('./output/data/blobs/x')).toBe('data/blobs/x');
    });
});
