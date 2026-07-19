// D-2026-0718-356 -- backup-dir ATOMIC commit. HERMETIC, no network.
// Drives the REAL backupDirectoryToR2 (r2-handoff.js) AND the REAL CLI production path
// (r2-workflow-cli.js backup-dir -> r2-bridge.js -> r2-handoff.js) against an in-memory R2
// injected at the r2-helpers boundary (vi.mock). Proves _manifest.json is a COMMIT RECORD
// written LAST -- it can never claim an object R2 does not actually have.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

vi.mock('../../scripts/factory/lib/r2-helpers.js', () => ({
    createR2Client: () => (globalThis as any).__R2_CLIENT ?? null,
    fetchR2Etags: async () => (globalThis as any).__R2_ETAGS ?? new Map(),
}));
import { backupDirectoryToR2 } from '../../scripts/factory/lib/r2-handoff.js';

const CLI = path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js');
const PREFIX = 'state/_handoff/atomic/R1/attempt-1/';

type Bucket = { store: Map<string, Buffer>; puts: string[]; client: any };
// In-memory R2. failPut(key) => that PUT rejects (simulates a partial/failed upload or a
// manifest-PUT failure); every other op behaves like R2. LIST returns md5 as the ETag.
function makeBucket(failPut: (key: string) => boolean = () => false): Bucket {
    const store = new Map<string, Buffer>();
    const puts: string[] = [];
    const client = {
        async send(cmd: any) {
            const n = cmd?.constructor?.name; const i = cmd?.input || {};
            if (n === 'PutObjectCommand') {
                puts.push(i.Key);
                if (failPut(i.Key)) { const e: any = new Error(`PUT denied ${i.Key}`); e.$metadata = { httpStatusCode: 500 }; throw e; }
                store.set(i.Key, Buffer.from(i.Body)); return { $metadata: {} };
            }
            if (n === 'GetObjectCommand') {
                const b = store.get(i.Key);
                if (!b) { const e: any = new Error('NoSuchKey'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; throw e; }
                return { Body: (async function* () { yield b; })(), ContentLength: b.length };
            }
            if (n === 'ListObjectsV2Command') {
                const p = i.Prefix || '';
                return { Contents: [...store.keys()].filter((k) => k.startsWith(p)).sort().map((Key) => ({ Key, ETag: md5(store.get(Key)!) })), NextContinuationToken: undefined };
            }
            throw new Error(`unhandled ${n}`);
        },
    };
    return { store, puts, client };
}
// .bin/.db clear the 256B non-.zst floor; .zst carries the zstd magic + >=16B.
function bin(tag: string, size = 512): Buffer { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (tag.charCodeAt(i % tag.length) + i * 7) & 0xff; return b; }
function zst(tag: string, size = 48): Buffer { const b = Buffer.alloc(size); b[0] = 0x28; b[1] = 0xb5; b[2] = 0x2f; b[3] = 0xfd; for (let i = 4; i < size; i++) b[i] = (tag.charCodeAt(i % tag.length) + i * 3) & 0xff; return b; }
function md5(buf: Buffer) { return crypto.createHash('md5').update(buf).digest('hex'); }
const roots: string[] = [];
function tmp(tag: string): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), `r2atom-${tag}-`)); roots.push(d); return d; }
function w(dir: string, rel: string, buf: Buffer): Buffer { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, buf); return buf; }
function use(b: Bucket, etags: Map<string, string> = new Map()) { (globalThis as any).__R2_CLIENT = b.client; (globalThis as any).__R2_ETAGS = etags; }
const MANI = `${PREFIX}_manifest.json`;

beforeEach(() => { process.env.R2_FORCE_JS = 'true'; });
afterEach(() => {
    delete (globalThis as any).__R2_CLIENT; delete (globalThis as any).__R2_ETAGS;
    for (const d of roots.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
    for (const n of cliTmps.splice(0)) { try { fs.rmSync(path.join(path.dirname(CLI), n), { force: true }); } catch { /* */ } }
    vi.restoreAllMocks();
});

describe('backupDirectoryToR2 — manifest is a COMMIT RECORD written LAST (D-356)', () => {
    it('single-file upload failure => op FAILS, NO _manifest.json (pre-fix RED: it pushed the failed key then wrote the manifest anyway)', async () => {
        const dir = tmp('sf'); w(dir, 'a.bin', bin('a')); w(dir, 'b.bin', bin('b'));
        const b = makeBucket((k) => k.endsWith('b.bin')); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(r.success).toBe(false); expect(r.failed).toBe(1); expect(r.reason).toBe('partial_upload');
        expect(b.store.has(MANI)).toBe(false); // atomic: no partial manifest => no phantom claim
    });

    it('concurrent Promise rejections (two PUTs fail in one batch) => op FAILS, verified excludes both, NO manifest', async () => {
        const dir = tmp('cc'); for (const n of ['a', 'b', 'c', 'd']) w(dir, `${n}.bin`, bin(n));
        const b = makeBucket((k) => k.endsWith('b.bin') || k.endsWith('d.bin')); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, { concurrency: 5 });
        expect(r.success).toBe(false); expect(r.failed).toBe(2); expect(r.verified).toBe(2);
        expect(b.store.has(`${PREFIX}a.bin`)).toBe(true); // sibling durable — but is an orphan, never authority
        expect(b.store.has(MANI)).toBe(false);
    });

    it('manifest PUT failure (all 3 retries) => success:false, committed:false, data present but NOT committed', async () => {
        const dir = tmp('mf'); w(dir, 'a.bin', bin('a'));
        const b = makeBucket((k) => k.endsWith('_manifest.json')); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(r.success).toBe(false); expect(r.committed).toBe(false); expect(r.reason).toBe('manifest_write_failed');
        expect(r.verified).toBe(1); expect(b.store.has(`${PREFIX}a.bin`)).toBe(true); expect(b.store.has(MANI)).toBe(false);
    }, 15000);

    it('WRONG skip: remote etag != local md5 => re-uploads (NEVER counted a verified skip)', async () => {
        const dir = tmp('ws'); const data = w(dir, 'a.bin', bin('a'));
        const b = makeBucket(); use(b, new Map([[`${PREFIX}a.bin`, 'deadbeefdeadbeefdeadbeefdeadbeef']]));
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(r.success).toBe(true); expect(r.skipped).toBe(0); expect(r.count).toBe(1);
        expect(b.puts).toContain(`${PREFIX}a.bin`); // proof of re-upload, not a false skip
        expect(md5(b.store.get(`${PREFIX}a.bin`)!)).toBe(md5(data)); // remote byte identity restored
    });

    it('WRONG skip whose re-upload also fails => op FAILS (an identity mismatch can never become a false skip-success)', async () => {
        const dir = tmp('wsf'); w(dir, 'a.bin', bin('a'));
        const b = makeBucket((k) => k.endsWith('a.bin')); use(b, new Map([[`${PREFIX}a.bin`, 'deadbeefdeadbeefdeadbeefdeadbeef']]));
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(r.success).toBe(false); expect(r.failed).toBe(1); expect(b.store.has(MANI)).toBe(false);
    });

    it('FULL verified-skip: every etag matches md5 => success, ZERO data PUTs, manifest committed (pre-fix RED: all-skip returned success:false)', async () => {
        const dir = tmp('vs'); const da = w(dir, 'a.bin', bin('a')); const db = w(dir, 'b.bin', bin('b'));
        const b = makeBucket(); use(b, new Map([[`${PREFIX}a.bin`, md5(da)], [`${PREFIX}b.bin`, md5(db)]]));
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(r.success).toBe(true); expect(r.skipped).toBe(2); expect(r.count).toBe(0); expect(r.committed).toBe(true);
        expect(b.puts.filter((k) => !k.endsWith('_manifest.json'))).toEqual([]); // identity-proven, so nothing re-uploaded
        expect(JSON.parse(b.store.get(MANI)!.toString()).files.sort()).toEqual(['a.bin', 'b.bin']);
    });

    it('EMPTY input => fail-closed (success:false, empty:true), NO manifest (pre-fix RED: empty returned no-op without failing)', async () => {
        const dir = tmp('em'); fs.mkdirSync(path.join(dir, 'sub'), { recursive: true }); // dir exists, zero files
        const b = makeBucket(); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(r.success).toBe(false); expect(r.empty).toBe(true); expect(r.expected).toBe(0); expect(b.store.has(MANI)).toBe(false);
    });

    it('term_index/z* PUT fails (the run-29658868705 symptom) => op FAILS, NO manifest can claim the absent z* object', async () => {
        const dir = tmp('ti');
        w(dir, 'term_index/_manifest.json.zst', zst('tim')); w(dir, 'term_index/za/za_0.json.zst', zst('za')); w(dir, 'term_index/zb/zb_0.json.zst', zst('zb'));
        const b = makeBucket((k) => k.includes('/zb/')); use(b);
        const r: any = await backupDirectoryToR2(path.join(dir, 'term_index'), `${PREFIX}term_index/`, {});
        expect(r.success).toBe(false); expect(r.failed).toBe(1);
        expect(b.store.has(`${PREFIX}term_index/_manifest.json`)).toBe(false); // no false manifest => later restore never fail-closes on a phantom z*
    });

    it('happy path => verified===expected && failed===0 && committed===true; every manifested key really exists in R2', async () => {
        const dir = tmp('ok'); w(dir, 'a.bin', bin('a')); w(dir, 'sub/c.json.zst', zst('c'));
        const b = makeBucket(); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(r.success && r.verified === r.expected && r.failed === 0 && r.committed).toBe(true);
        const m = JSON.parse(b.store.get(MANI)!.toString());
        expect(m.files.sort()).toEqual(['a.bin', 'sub/c.json.zst']);
        for (const f of m.files) expect(b.store.has(PREFIX + f)).toBe(true);
    });
});

// Real production path: r2-workflow-cli.js reads process.argv at load and calls main(). It carries
// a `#!` shebang (a parse error on dynamic import), so stage a shebang-stripped copy BESIDE it
// (temp_ prefix => CES-skipped; deleted in afterEach) and import THAT through vitest's transform so
// the vi.mock(r2-helpers) still applies down the REAL CLI -> r2-bridge -> r2-handoff chain.
const cliTmps: string[] = []; let cliN = 0;
function stageCli(): string {
    const src = fs.readFileSync(CLI, 'utf8').replace(/^#![^\n]*\r?\n/, '');
    const name = `temp_r2cli_${process.pid}_${cliN++}.mjs`;
    fs.writeFileSync(path.join(path.dirname(CLI), name), src); cliTmps.push(name);
    return `../../scripts/factory/${name}`;
}
async function runCli(argv: string[]): Promise<{ code: number; logs: string[]; errs: string[] }> {
    vi.resetModules();
    const logs: string[] = []; const errs: string[] = []; let code: number | undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { if (code === undefined) code = c ?? 0; return undefined as never; }) as any);
    const origArgv = process.argv; process.argv = [process.execPath, CLI, ...argv];
    try {
        await import(stageCli());
        await vi.waitFor(() => { if (code === undefined && !logs.some((l) => /backup-dir OK/.test(l))) throw new Error('pending'); }, { timeout: 5000, interval: 10 });
    } finally { process.argv = origArgv; logSpy.mockRestore(); errSpy.mockRestore(); exitSpy.mockRestore(); }
    return { code: code ?? 0, logs, errs };
}

describe('real CLI production path — r2-workflow-cli.js backup-dir exit-code propagation (D-356 #4)', () => {
    it('partial upload => CLI exits NON-ZERO (pre-fix RED: backup-dir always exited 0)', async () => {
        const dir = tmp('cli-fail'); w(dir, 'a.bin', bin('a')); w(dir, 'b.bin', bin('b'));
        const b = makeBucket((k) => k.endsWith('b.bin')); use(b);
        const r = await runCli(['backup-dir', dir, PREFIX]);
        expect(r.code).toBe(1); expect(b.store.has(MANI)).toBe(false);
    });

    it('complete upload => CLI exits ZERO and commits the manifest', async () => {
        const dir = tmp('cli-ok'); w(dir, 'a.bin', bin('a'));
        const b = makeBucket(); use(b);
        const r = await runCli(['backup-dir', dir, PREFIX]);
        expect(r.code).toBe(0); expect(b.store.has(`${PREFIX}a.bin`)).toBe(true); expect(b.store.has(MANI)).toBe(true);
    });
});
