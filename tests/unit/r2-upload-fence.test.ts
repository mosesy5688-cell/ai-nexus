import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

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

describe('R5 fence — purge list + additive workflow placement', () => {
    const src = () => fs.readFileSync(path.resolve(process.cwd(), 'scripts/factory/r2-upload-s3.js'), 'utf8');
    const yml = () => fs.readFileSync(path.resolve(process.cwd(), '.github/workflows/factory-upload.yml'), 'utf8').replace(/\r\n/g, '\n');

    it('(UF-E1) BOTH the upload queue AND the purge/manifest list exclude every R5 prefix', () => {
        const s = src();
        expect(/if \(isR5StagingPath\(remotePath\)\) return false;/.test(s)).toBe(true);   // upload queue
        const purge = s.match(/const allManifestPaths = allFiles[\s\S]*?purgeListPath/);
        expect(purge).not.toBeNull();
        expect(/!isR5StagingPath\(p\)/.test(purge![0])).toBe(true);                        // purge list
    });
    it('(UF-E2) the two R5 steps are ADDITIVE and weaken NO current-main upload gate', () => {
        const y = yml();
        const rankingsGate = y.indexOf('verify-publication output/data output/data/shards_manifest.json');
        const capacity = y.indexOf('runner-capacity-preflight.mjs FINAL_UPLOAD');
        const upload = y.indexOf('run: node scripts/factory/r2-upload-s3.js');
        const stage = y.indexOf('run: node scripts/factory/lib/r5-staging.js');
        const verify = y.indexOf('run: node scripts/factory/acceptance-staged-cycle.js');
        // ORDER: pre-publication rankings gate -> capacity preflight -> SOLE public write -> R5 no-ops
        expect(rankingsGate).toBeGreaterThan(-1);
        expect(capacity).toBeGreaterThan(rankingsGate);
        expect(upload).toBeGreaterThan(capacity);
        expect(stage).toBeGreaterThan(upload);
        expect(verify).toBeGreaterThan(stage);
        // r2-upload-s3.js remains the SOLE once-referenced public write step
        expect((y.match(/run: node scripts\/factory\/r2-upload-s3\.js/g) || []).length).toBe(1);
        expect((y.match(/run: node scripts\/factory\/lib\/r5-staging\.js/g) || []).length).toBe(1);
        expect((y.match(/run: node scripts\/factory\/acceptance-staged-cycle\.js/g) || []).length).toBe(1);
    });
    it('(UF-E3) the R5 step block introduces NO enabling env, NO concurrency, NO pointer write', () => {
        const y = yml();
        const from = y.indexOf('run: node scripts/factory/r2-upload-s3.js');
        const raw = y.slice(from, y.indexOf('Save Upload Manifest to Cache', from));
        expect(raw.includes('r5-staging.js') && raw.includes('acceptance-staged-cycle.js')).toBe(true);
        // EXECUTABLE YAML only — the fence COMMENTS deliberately say "NO concurrency:" and
        // "NEVER writes data/current.json", so a raw text scan would match its own disclaimer.
        const exec = raw.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        expect(/stage_enabled/.test(exec)).toBe(false);      // nothing enables staging
        expect(/^\s*concurrency:/m.test(exec)).toBe(false);   // no publication-switching concurrency key
        expect(/current\.json/.test(exec)).toBe(false);       // no pointer write (Phase 3)
        expect(/^\s*STAGE_MODE\s*:/m.test(exec)).toBe(false); // no env override wired into the steps
        expect(/^\s*env:/m.test(exec)).toBe(false);           // the two R5 steps carry NO env block at all
        // and BOTH R5 steps are plain run: invocations that add no if:/needs: rewiring
        expect((exec.match(/^\s+- name: R5 Phase 2 /gm) || []).length).toBe(2);
    });
});

// Founder D-352 F-1 REPAIR: `backup-dir output/data/ state/vfs-data/` is a BROAD PUT into
// a PERMANENT R2 prefix, so an R5 staging class under output/data/ would accumulate there
// forever. A FAIL-CLOSED guard must run first, in the same step, and abort on blobs /
// cycles / quarantine — present, EMPTY, or a SYMLINK.
describe('R5 F-1 backup fence — state/vfs-data backup fails closed', () => {
    const YML = path.resolve(process.cwd(), '.github/workflows/factory-upload.yml');
    const BACKUP_CMD = 'node scripts/factory/r2-workflow-cli.js backup-dir output/data/ state/vfs-data/';
    const FORBIDDEN = ['blobs', 'cycles', 'quarantine'];

    /** De-indent the `run: |` body of the "Backup VFS Data to R2" step (text-sliced, no
     *  YAML dependency; CRLF normalised first because this repo checks out CRLF). */
    function backupStepRun(): string {
        const y = fs.readFileSync(YML, 'utf8').replace(/\r\n/g, '\n');
        const name = y.indexOf('- name: Backup VFS Data to R2');
        const runAt = y.indexOf('run: |', name);
        expect(name).toBeGreaterThan(-1); expect(runAt).toBeGreaterThan(-1);
        const lines = y.slice(y.indexOf('\n', runAt) + 1).split('\n');
        const indent = /^\s*/.exec(lines[0])![0].length;
        const out: string[] = [];
        for (const l of lines) {
            if (l.trim() !== '' && /^\s*/.exec(l)![0].length < indent) break;
            out.push(l.slice(indent));
        }
        return out.join('\n');
    }

    /** Run the step body in a sandbox with the real R2 calls replaced by markers.
     *  `bodyOverride` (already de-indented) is used ONLY by the RED-restore probe. */
    function runStep(setup: (root: string) => void, bodyOverride?: string) {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5-fence-'));
        try {
            fs.mkdirSync(path.join(root, 'output', 'data'), { recursive: true });
            setup(root);
            const body = (bodyOverride ?? backupStepRun())
                .replace(BACKUP_CMD, 'echo REACHED_VFS_DATA_BACKUP')
                .replace('node scripts/factory/r2-workflow-cli.js backup-dir output/meta/ state/vfs-meta/ || true', 'echo REACHED_META_BACKUP');
            fs.writeFileSync(path.join(root, 'step.sh'), body, { encoding: 'utf8' });
            const r = spawnSync('bash', ['-eo', 'pipefail', 'step.sh'], { cwd: root, encoding: 'utf8' });
            // fail-closed: a missing shell must NOT read as a passing guard
            expect(r.error, `bash is required to execute the guard: ${r.error}`).toBeUndefined();
            return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
        } finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } }
    }

    it('(UF-F1) the guard sits INSIDE the backup step, BEFORE the state/vfs-data command', () => {
        const body = backupStepRun();
        const guard = body.indexOf('for forbidden in'); const backup = body.indexOf(BACKUP_CMD);
        expect(guard).toBeGreaterThan(-1); expect(backup).toBeGreaterThan(-1);
        expect(guard).toBeLessThan(backup);                       // ordering is load-bearing
        for (const f of FORBIDDEN) expect(body).toContain(`output/data/${f}`);
        expect(body).toContain('[ -e "$forbidden" ] || [ -L "$forbidden" ]');   // empty dir AND symlink
        expect(body).toContain('::error::[R5-BACKUP-FENCE] forbidden path present:');
        expect(body).toContain('exit 1');
        const code = body.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
        expect(/\|\| true/.test(code.slice(0, code.indexOf(BACKUP_CMD)))).toBe(false); // nothing softened
        expect(/continue-on-error/.test(body)).toBe(false);
        // exactly ONE state/vfs-data backup site, so "before it" is unambiguous
        const y = fs.readFileSync(YML, 'utf8').replace(/\r\n/g, '\n');
        expect((y.match(/backup-dir output\/data\/ state\/vfs-data\//g) || []).length).toBe(1);
    });

    for (const f of FORBIDDEN) {
        it(`(UF-F2-${f}) an EMPTY output/data/${f} directory INDEPENDENTLY exits non-zero and blocks the backup`, () => {
            const r = runStep((root) => fs.mkdirSync(path.join(root, 'output', 'data', f)));
            expect(r.status).not.toBe(0);
            expect(r.out).toContain(`::error::[R5-BACKUP-FENCE] forbidden path present: output/data/${f}`);
            expect(r.out).not.toContain('REACHED_VFS_DATA_BACKUP'); expect(r.out).not.toContain('REACHED_META_BACKUP');
        });

        it(`(UF-F3-${f}) a SYMLINK at output/data/${f} also exits non-zero (dangling included)`, () => {
            const r = runStep((root) => {
                fs.mkdirSync(path.join(root, 'elsewhere'));
                fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'output', 'data', f), 'junction');
            });
            expect(r.status).not.toBe(0); expect(r.out).not.toContain('REACHED_VFS_DATA_BACKUP');
            expect(r.out).toContain(`::error::[R5-BACKUP-FENCE] forbidden path present: output/data/${f}`);
        });
    }

    it('(UF-F4) an ORDINARY output/data set (no forbidden paths) still reaches the existing backup command', () => {
        const r = runStep((root) => {
            fs.writeFileSync(path.join(root, 'output', 'data', 'meta-00.db'), 'x');
            fs.writeFileSync(path.join(root, 'output', 'data', 'shards_manifest.json'), '{}');
            fs.mkdirSync(path.join(root, 'output', 'data', 'term_index'));
        });
        expect(r.status).toBe(0); expect(r.out).toContain('REACHED_VFS_DATA_BACKUP'); expect(r.out).not.toContain('::error::');
    });

    it('(UF-F5 / RED-restore) with the guard deleted the SAME forbidden tree would reach the backup', () => {
        const body = backupStepRun();
        const from = body.indexOf('for forbidden in'); const to = body.indexOf('done', from) + 'done\n'.length;
        // reconstruct the step WITHOUT the guard loop and prove the fence is what stops it
        const unguarded = body.slice(0, from) + body.slice(to);
        expect(from).toBeGreaterThan(-1); expect(unguarded).not.toContain('for forbidden in'); expect(unguarded).toContain(BACKUP_CMD);
        const r = runStep((root) => fs.mkdirSync(path.join(root, 'output', 'data', 'blobs')), unguarded);
        expect(r.status).toBe(0); expect(r.out).toContain('REACHED_VFS_DATA_BACKUP');   // RED without the guard
    });
});

describe('R5 path mapping', () => {
    it('(UF-D2) toRemotePath strips ./ and output/ (path -> remote key mapping intact)', () => {
        expect(toRemotePath('output/data/meta-00.db')).toBe('data/meta-00.db');
        expect(toRemotePath('./output/data/blobs/x')).toBe('data/blobs/x');
    });
});
