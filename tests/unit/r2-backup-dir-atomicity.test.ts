// D-356 backup-dir ATOMIC commit + D-359 three-state POLICY_EXCLUDED. HERMETIC, no network. Drives the REAL
// backupDirectoryToR2 + CLI path against an in-memory R2; proves _manifest.json is a COMMIT RECORD written LAST from ELIGIBLE verified members only (non-.zst min-size exclusions omitted; a corrupt .zst fails loud).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
vi.mock('../../scripts/factory/lib/r2-helpers.js', () => ({
    createR2Client: () => (globalThis as any).__R2_CLIENT ?? null,
    fetchR2Etags: async () => (globalThis as any).__R2_ETAGS ?? new Map(),
}));
// D-359: a controllable seam over the SHARED eligibility predicate. Inert (delegates to the REAL guard)
// unless a test sets __ELIG_OVERRIDE — used ONLY to force the up-front-eligible / uploader-blocked divergence.
vi.mock('../../scripts/factory/lib/upload-eligibility.js', async (orig) => {
    const a: any = await (orig as any)();
    return { ...a, isUploadEligible: (n: string, d: Buffer, o?: any) => (globalThis as any).__ELIG_OVERRIDE?.(n, d, o, a.isUploadEligible) ?? a.isUploadEligible(n, d, o) };
});
import { backupDirectoryToR2, restoreDirectoryFromR2 } from '../../scripts/factory/lib/r2-handoff.js';

const CLI = path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js');
const PREFIX = 'state/_handoff/atomic/R1/attempt-1/';

type Bucket = { store: Map<string, Buffer>; puts: string[]; client: any };
// In-memory R2. failPut(key) => that PUT rejects (partial/manifest-PUT failure); every other op behaves like R2; LIST returns md5 as the ETag.
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
    delete (globalThis as any).__R2_CLIENT; delete (globalThis as any).__R2_ETAGS; delete (globalThis as any).__ELIG_OVERRIDE;
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

// Sub-256B non-.zst JSON is BLOCKED by the shared isUploadEligible guard (min 256B) -- the harvest-state-<source>.json / enrichment-params-backfill.json family that fail-closed every cycle pre-D359.
function smallJson(obj: object): Buffer { const b = Buffer.from(JSON.stringify(obj)); if (b.length >= 256) throw new Error('fixture must be <256B'); return b; }

describe('backupDirectoryToR2 — D-359 three-state: POLICY_EXCLUDED (min-size/zstd) is neither failure nor verified', () => {
    it('(1) a small POLICY_EXCLUDED file + a larger eligible file => manifest contains ONLY the eligible file', async () => {
        const dir = tmp('pe1'); w(dir, 'harvest-state-hf.json', smallJson({ s: 'hf' })); w(dir, 'huggingface_master.ndjson', bin('m', 600)); const b = makeBucket(); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect([r.success, r.policyExcluded, r.eligibleExpected, r.verified]).toEqual([true, 1, 1, 1]);
        expect(JSON.parse(b.store.get(MANI)!.toString()).files).toEqual(['huggingface_master.ndjson']); expect(b.store.has(`${PREFIX}harvest-state-hf.json`)).toBe(false);
    });
    it('(2) ALL files policy-excluded => eligible_expected===0 => fail-closed, NO manifest', async () => {
        const dir = tmp('pe2'); w(dir, 'harvest-state-hf.json', smallJson({ a: 1 })); w(dir, 'enrichment-params-backfill.json', smallJson({ b: 2 })); const b = makeBucket(); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect([r.success, r.eligibleExpected, r.policyExcluded, r.reason]).toEqual([false, 0, 2, 'no_eligible_files']); expect(b.store.has(MANI)).toBe(false);
    });
    it('(3) D-380 eligibility is computed ONCE/file (up-front vs uploader divergence structurally eliminated) => an ELIGIBLE file whose PUT is refused is FAILED, never policy-excluded', async () => {
        let calls = 0; (globalThis as any).__ELIG_OVERRIDE = (n: string, d: Buffer, o: any, real: any) => { calls++; return real(n, d, o); };
        const dir = tmp('pe3'); w(dir, 'a.bin', bin('a')); const b = makeBucket((k) => k.endsWith('a.bin')); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect(calls).toBe(1); // ONCE per file: no second uploader re-check can diverge from the up-front decision
        expect([r.success, r.failed, r.policyExcluded]).toEqual([false, 1, 0]); expect(b.store.has(MANI)).toBe(false);
    });
    it('(4) an eligible file that fails with an UNKNOWN (non-integrity) reason => FAILED, never excluded (reason guard)', async () => {
        const dir = tmp('pe4'); w(dir, 'a.bin', bin('a')); const b = makeBucket((k) => k.endsWith('a.bin')); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect([r.success, r.failed, r.policyExcluded]).toEqual([false, 1, 0]); expect(b.store.has(MANI)).toBe(false);
    });
    it('(5) a normal upload failure => op FAILS, NO manifest (no member silently reclassified as excluded)', async () => {
        const dir = tmp('pe5'); w(dir, 'a.bin', bin('a')); w(dir, 'b.bin', bin('b')); const b = makeBucket((k) => k.endsWith('b.bin')); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect([r.success, r.failed, r.policyExcluded]).toEqual([false, 1, 0]); expect(b.store.has(MANI)).toBe(false);
    });
    it('(6) manifest PUT failure => success:false, committed:false (=> CLI non-zero via r2-workflow-cli)', async () => {
        const dir = tmp('pe6'); w(dir, 'harvest-state-hf.json', smallJson({ x: 1 })); w(dir, 'a.bin', bin('a')); const b = makeBucket((k) => k.endsWith('_manifest.json')); use(b);
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect([r.success, r.committed, r.reason, r.policyExcluded, r.eligibleExpected, r.verified]).toEqual([false, false, 'manifest_write_failed', 1, 1, 1]); expect(b.store.has(MANI)).toBe(false);
    }, 15000);
    it('(7) identity-skip vs policy-exclusion strictly separated: skip IS in manifest+verified; exclusion is in NEITHER', async () => {
        const dir = tmp('pe7'); const da = w(dir, 'a.bin', bin('a')); w(dir, 'harvest-state-hf.json', smallJson({ s: 1 })); const b = makeBucket(); use(b, new Map([[`${PREFIX}a.bin`, md5(da)]]));
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect([r.success, r.skipped, r.policyExcluded, r.verified, r.eligibleExpected, r.count]).toEqual([true, 1, 1, 1, 1, 0]);
        const m = JSON.parse(b.store.get(MANI)!.toString()); expect(m.files).toEqual(['a.bin']); expect(m.files).not.toContain('harvest-state-hf.json');
    });
    it('(8) REAL Harvest path: sub-256B state JSON + normal artifacts => backup(eligible only) => restore==manifested; excluded absent, no error', async () => {
        const src = tmp('pe8s'); w(src, 'harvest-state-huggingface.json', smallJson({ s: 'hf', id: 42 })); w(src, 'harvest-state-github.json', smallJson({ s: 'gh' })); w(src, 'enrichment-params-backfill.json', smallJson({ bf: 1 }));
        const artA = w(src, 'huggingface_master.ndjson', bin('hf', 800)); const artB = w(src, 'github_master.ndjson', bin('gh', 700)); const b = makeBucket(); use(b);
        const bk: any = await backupDirectoryToR2(src, PREFIX, {});
        expect([bk.success, bk.policyExcluded, bk.eligibleExpected, bk.verified]).toEqual([true, 3, 2, 2]);
        expect(JSON.parse(b.store.get(MANI)!.toString()).files.sort()).toEqual(['github_master.ndjson', 'huggingface_master.ndjson']);
        const dst = tmp('pe8d'); const rs: any = await restoreDirectoryFromR2(PREFIX, dst, {}); expect([rs.success, rs.count]).toEqual([true, 2]);
        expect(md5(fs.readFileSync(path.join(dst, 'huggingface_master.ndjson')))).toBe(md5(artA)); expect(md5(fs.readFileSync(path.join(dst, 'github_master.ndjson')))).toBe(md5(artB));
        for (const f of ['harvest-state-huggingface.json', 'harvest-state-github.json', 'enrichment-params-backfill.json']) expect(fs.existsSync(path.join(dst, f))).toBe(false);
    });
    it('(9) mutation proof: "all blocked => success" AND "policy-excluded counts as verified" both go RED', async () => {
        const ad = tmp('pe9a'); w(ad, 'harvest-state-hf.json', smallJson({ a: 1 })); const ba = makeBucket(); use(ba); // Mutant A: all-excluded gate MUST fail-closed
        const ra: any = await backupDirectoryToR2(ad, PREFIX, {}); expect([ra.success, ra.eligibleExpected]).toEqual([false, 0]); expect(ba.store.has(MANI)).toBe(false);
        const mix = tmp('pe9b'); w(mix, 'harvest-state-hf.json', smallJson({ a: 1 })); w(mix, 'a.bin', bin('a')); const bb = makeBucket(); use(bb); // Mutant B: excluded MUST NOT count as verified/manifested
        const rb: any = await backupDirectoryToR2(mix, PREFIX, {}); expect([rb.success, rb.verified, rb.policyExcluded]).toEqual([true, 1, 1]);
        expect(JSON.parse(bb.store.get(MANI)!.toString()).files).toEqual(['a.bin']);
    });
    it('(10) a below-16B / magic-missing .zst (corruption) => op FAILS LOUD (throw=failed), NOT policy-excluded, NO manifest (D-356 fail-closed kept)', async () => {
        const dir = tmp('pe10'); w(dir, 'corrupt.json.zst', zst('c', 8)); const b = makeBucket(); use(b); // zstd magic present but 8B < 16B floor => ineligible
        const r: any = await backupDirectoryToR2(dir, PREFIX, {});
        expect([r.success, r.policyExcluded, r.failed >= 1, b.store.has(MANI)]).toEqual([false, 0, true, false]);
    });
});

// Real production path: r2-workflow-cli.js reads process.argv at load + calls main() and carries a `#!` shebang
// (dynamic-import parse error), so stage a shebang-stripped copy BESIDE it (temp_ => CES-skipped; deleted in afterEach) and import THAT so vi.mocks apply down CLI -> bridge -> handoff.
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
        const mod: any = await import(stageCli()); await mod.main(); // D-380: main() gated (no auto-run) + exported
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
