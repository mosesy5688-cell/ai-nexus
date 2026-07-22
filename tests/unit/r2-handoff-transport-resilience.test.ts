// D-380/D-382 transport resilience: a HERMETIC in-memory R2 (vi.mock of r2-helpers) drives the REAL
// r2-workflow-cli -> r2-bridge -> r2-handoff retry/classify/manifest/strict/single-client code through the
// gated exported main(). Per-key per-attempt ERROR INJECTION + a createR2Client COUNTER prove retry,
// classification, and one-client-per-dir-op. process.exit is captured for the CLI --strict / backup-dir paths.
// D-382 anti-vacuity: REAL object counts (4016/4015/1500), and every transport-OPERATION scenario is asserted
// through the CLI seam + captured logs + resulting local files, NOT by calling the handoff functions directly.
// The pure classifyR2Error() table is the only permitted direct unit test (D-382 §2).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto';
import { classifyR2Error } from '../../scripts/factory/lib/r2-handoff.js';
vi.mock('../../scripts/factory/lib/r2-helpers.js', () => ({
    createR2Client: () => (globalThis as any).__R2_FACTORY?.() ?? null,
    fetchR2Etags: async () => (globalThis as any).__R2_ETAGS ?? new Map(),
}));

const CLI = path.resolve(__dirname, '../../scripts/factory/r2-workflow-cli.js');
const P = 'state/_handoff/tr/R1/attempt-1/';
function md5(b: Buffer) { return crypto.createHash('md5').update(b).digest('hex'); }
function bin(tag: string, size = 512): Buffer { const b = Buffer.alloc(size); for (let i = 0; i < size; i++) b[i] = (tag.charCodeAt(i % tag.length) + i * 7) & 0xff; return b; }
// classified-error factory: name/code/http drive classifyR2Error; flags model transport behaviors.
function er(o: any = {}): any {
    const e: any = new Error(o.msg ?? o.name ?? 'inj');
    if (o.name) e.name = o.name;
    if (o.code) e.code = o.code;
    if (o.http) e.$metadata = { httpStatusCode: o.http, attempts: 2, totalRetryDelay: 10 };
    if (o.stream) { e.code = o.code || 'ECONNRESET'; e.__stream = true; }
    if (o.trunc) e.__trunc = true;
    if (o.shortFrac) e.__shortFrac = o.shortFrac;
    if (o.landed) e.__landed = true;
    return e;
}
type R2 = ReturnType<typeof makeR2>;
function makeR2({ pageSize = 1000 } = {}) {
    const store = new Map<string, Buffer>(); const puts: string[] = []; const gets: string[] = []; const lists: string[] = [];
    const inject = new Map<string, any[]>(); let cc = 0;
    const take = (k: string, key: string) => { const q = inject.get(k + ' ' + key); return q && q.length ? q.shift() : null; };
    const client = { async send(cmd: any) {
        const n = cmd?.constructor?.name; const i = cmd?.input || {};
        if (n === 'PutObjectCommand') { puts.push(i.Key); const j = take('PUT', i.Key); if (j) { if (j.__landed) store.set(i.Key, Buffer.from(i.Body)); throw j; } store.set(i.Key, Buffer.from(i.Body)); return { $metadata: {} }; }
        if (n === 'GetObjectCommand') { gets.push(i.Key); const j = take('GET', i.Key); const b = store.get(i.Key);
            if (j && j.__stream) { const bb = b ?? Buffer.alloc(16); return { Body: (async function* () { yield bb.slice(0, 1); throw j; })(), ContentLength: bb.length }; }
            if (j && j.__trunc) { const bb = b ?? Buffer.alloc(16); return { Body: (async function* () { yield bb.slice(0, 1); })(), ContentLength: bb.length }; }
            if (j && j.__shortFrac) { const bb = b ?? Buffer.alloc(16); const cut = Math.floor(bb.length * j.__shortFrac); return { Body: (async function* () { yield bb.slice(0, cut); })(), ContentLength: bb.length }; }
            if (j) throw j;
            if (!b) throw er({ name: 'NoSuchKey', http: 404 });
            return { Body: (async function* () { yield b; })(), ContentLength: b.length }; }
        if (n === 'ListObjectsV2Command') { lists.push(i.Prefix || ''); const j = take('LIST', i.Prefix || ''); if (j) throw j;
            const p = i.Prefix || ''; const all = [...store.keys()].filter((k) => k.startsWith(p)).sort();
            const s = i.ContinuationToken ? parseInt(i.ContinuationToken, 10) : 0; const page = all.slice(s, s + (i.MaxKeys || pageSize)); const nx = s + page.length;
            return { Contents: page.map((Key) => ({ Key, ETag: md5(store.get(Key)!) })), NextContinuationToken: nx < all.length ? String(nx) : undefined }; }
        throw new Error('unhandled ' + n);
    } };
    return { store, puts, gets, lists, inject, cc: () => cc, factory: () => (cc++, client), client };
}
const roots: string[] = [];
function tmp(t: string) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `r2tr-${t}-`)); roots.push(d); return d; }
function w(dir: string, rel: string, b: Buffer) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); }
// Explicit small seed: named members + a valid-object manifest (unless manifest=false).
function seed(r: R2, prefix: string, files: Record<string, Buffer>, manifest = true) { for (const [rel, b] of Object.entries(files)) r.store.set(prefix + rel, b); if (manifest) { const fk = Object.keys(files); r.store.set(prefix + '_manifest.json', Buffer.from(JSON.stringify({ files: fk, timestamp: 't', count: fk.length }))); } }
// SCALE seed: n synthetic members (+ manifest) directly into the store; returns the ordered key list.
function seedScale(r: R2, prefix: string, n: number, manifest = true) { const b = bin('s', 8); const files: string[] = []; for (let i = 0; i < n; i++) { const rel = 'f' + i + '.bin'; files.push(rel); r.store.set(prefix + rel, b); } if (manifest) r.store.set(prefix + '_manifest.json', Buffer.from(JSON.stringify({ files, timestamp: 't', count: n }))); return files; }
function inj(r: R2, kind: string, key: string, ...errs: any[]) { r.inject.set(kind + ' ' + key, errs); }
function use(r: R2) { (globalThis as any).__R2_FACTORY = r.factory; (globalThis as any).__R2_ETAGS = new Map(); }
const S = (n: number) => Array(n).fill(er({ code: 'ECONNRESET' })); // n socket errors (exceed the 4-attempt cap)
function cliResult(res: { logs: string[] }): any { const line = res.logs.find((l) => l.startsWith('[R2-CLI-RESULT]')); return line ? JSON.parse(line.slice(line.indexOf('{'))) : null; }

// Real production CLI path: stage a shebang-stripped copy BESIDE r2-workflow-cli.js (temp_ => CES-skipped), import
// it so vi.mocks apply CLI -> bridge -> handoff, and drive the now-gated exported main() in-process.
const cliTmps: string[] = []; let cliN = 0;
function stageCli() { const src = fs.readFileSync(CLI, 'utf8').replace(/^#![^\n]*\r?\n/, ''); const nm = `temp_r2tr_${process.pid}_${cliN++}.mjs`; fs.writeFileSync(path.join(path.dirname(CLI), nm), src); cliTmps.push(nm); return `../../scripts/factory/${nm}`; }
async function runCli(argv: string[]) {
    vi.resetModules(); const logs: string[] = []; const errs: string[] = []; let code: number | undefined;
    const ls = vi.spyOn(console, 'log').mockImplementation((...a: any[]) => { logs.push(a.map(String).join(' ')); });
    const es = vi.spyOn(console, 'error').mockImplementation((...a: any[]) => { errs.push(a.map(String).join(' ')); });
    const xs = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { if (code === undefined) code = c ?? 0; return undefined as never; }) as any);
    const oa = process.argv; process.argv = [process.execPath, CLI, ...argv];
    try { const m: any = await import(stageCli()); await m.main(); } finally { process.argv = oa; ls.mockRestore(); es.mockRestore(); xs.mockRestore(); }
    return { code: code ?? 0, logs, errs };
}

beforeEach(() => { process.env.R2_FORCE_JS = 'true'; });
afterEach(() => { delete (globalThis as any).__R2_FACTORY; delete (globalThis as any).__R2_ETAGS; for (const d of roots.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ } } for (const n of cliTmps.splice(0)) { try { fs.rmSync(path.join(path.dirname(CLI), n), { force: true }); } catch { /* */ } } vi.restoreAllMocks(); });

describe('classifyR2Error table (direct unit — D-380 §A)', () => {
    it('retryable: timeout/socket/408/429/5xx/opaque-empty; terminal: 401/403/404/other-4xx/parse', () => {
        const RB = (o: any) => classifyR2Error(er(o)).retryable;
        expect([RB({ name: 'TimeoutError' }), RB({ code: 'ECONNRESET' }), RB({ code: 'ETIMEDOUT' }), RB({ code: 'EPIPE' }), RB({ code: 'EAI_AGAIN' }), RB({ http: 408 }), RB({ http: 429 }), RB({ http: 500 }), RB({ http: 503 }), RB({ msg: '' })]).toEqual(Array(10).fill(true));
        expect([RB({ http: 401 }), RB({ http: 403 }), RB({ name: 'NoSuchKey', http: 404 }), RB({ http: 400 }), RB({ http: 409 })]).toEqual(Array(5).fill(false));
        expect(classifyR2Error(new SyntaxError('bad json')).terminal).toBe('parse');
        expect(classifyR2Error(er({ http: 404 })).terminal).toBe('not_found'); expect(classifyR2Error(er({ http: 403 })).terminal).toBe('auth');
    });
});

describe('restore transport ops via REAL CLI seam (D-380 §C/§E · D-382 §1/§2/§3)', () => {
    it('(scale 4016/4016) full manifest restore: all members restored, ONE client, gets=N+1, exit 0', async () => {
        const r = makeR2(); use(r); const N = 4016; seedScale(r, P, N);
        const d = tmp('full'); const res = await runCli(['restore-dir', P, d]); const out = cliResult(res);
        expect([out.success, out.restored, out.expected, out.missing.length, out.source]).toEqual([true, N, N, 0, 'manifest']);
        expect(res.code).toBe(0); expect(r.cc()).toBe(1); expect(r.gets.length).toBe(N + 1);
        expect(fs.existsSync(path.join(d, 'f0.bin'))).toBe(true); expect(fs.existsSync(path.join(d, 'f' + (N - 1) + '.bin'))).toBe(true);
    }, 90000);
    it('(scale 4015/4016) ONE tail-key GET retry-exhausted => success:false restored=N-1 missing=[tail]; the SAME short restore --strict CLI exits 1', async () => {
        const r = makeR2(); use(r); const N = 4016; seedScale(r, P, N); const tail = 'f' + (N - 1) + '.bin';
        inj(r, 'GET', P + tail, ...S(4));
        const d1 = tmp('short'); const res1 = await runCli(['restore-dir', P, d1]); const out = cliResult(res1);
        expect([out.success, out.restored, out.expected, out.missing]).toEqual([false, N - 1, N, [tail]]);
        expect(res1.code).toBe(0); expect(fs.existsSync(path.join(d1, tail))).toBe(false); expect(fs.existsSync(path.join(d1, 'f0.bin'))).toBe(true);
        inj(r, 'GET', P + tail, ...S(4)); // re-arm the exhausting GET for the strict re-run
        const res2 = await runCli(['restore-dir', P, tmp('short2'), '--strict']);
        expect(res2.code).toBe(1); expect(res2.errs.join('\n')).toMatch(/restore-dir incomplete \(strict mode\)/);
    }, 120000);
    it('(scale >1001, 2 pages) NON-strict confirmed-absent manifest => paginated ContinuationToken LIST restores the FULL set', async () => {
        const r = makeR2(); use(r); const N = 1500; seedScale(r, P, N, false);
        const d = tmp('list'); const res = await runCli(['restore-dir', P, d]); const out = cliResult(res);
        expect([out.success, out.restored, out.source]).toEqual([true, N, 'list-fallback']);
        expect(r.lists.length).toBe(2); expect(res.code).toBe(0); expect(r.cc()).toBe(1);
    }, 90000);
    it('(Gap 3) a 95%-short Body GET is a truncation => retried then FULL success (RED at *0.9 head: the 95% body is accepted, no retry)', async () => {
        const r = makeR2(); use(r); const KEY = 't.bin'; seed(r, P, { 'a.bin': bin('a', 512), [KEY]: bin('t', 512) });
        inj(r, 'GET', P + KEY, er({ shortFrac: 0.95 })); // 486/512B premature EOF: >=0.9*len (old accepts) but <len (new retries)
        const d = tmp('trunc'); const res = await runCli(['restore-dir', P, d]); const out = cliResult(res);
        expect([out.success, out.restored]).toEqual([true, 2]);
        expect(r.gets.filter((k) => k === P + KEY).length).toBe(2); // 1 short read + 1 full-body retry
        expect(md5(fs.readFileSync(path.join(d, KEY)))).toBe(md5(bin('t', 512))); // FULL bytes on disk, not the 95% short body
    }, 15000);
    it('(§3) GET 404 and 403 are terminal — the transport is called EXACTLY ONCE per key (no retry)', async () => {
        for (const injected of [er({ name: 'NoSuchKey', http: 404 }), er({ http: 403 })]) {
            const r = makeR2(); use(r); seed(r, P, { 'a.bin': bin('a'), 'q.bin': bin('q') }); inj(r, 'GET', P + 'q.bin', injected);
            const res = await runCli(['restore-dir', P, tmp('term')]); const out = cliResult(res);
            expect(out.success).toBe(false); expect(r.gets.filter((k) => k === P + 'q.bin').length).toBe(1);
        }
    });
    it('(§3) OPAQUE empty-message GET => retryable & retried; the redacted attempt log covers op/key/attempt/name/code/http/SDK-metadata-fallback/class', async () => {
        const r = makeR2(); use(r); seed(r, P, { 'a.bin': bin('a') }); inj(r, 'GET', P + 'a.bin', er({ msg: '' }));
        const res = await runCli(['restore-dir', P, tmp('opaque')]); const out = cliResult(res);
        expect([out.success, out.restored]).toEqual([true, 1]);
        const line = res.errs.find((l) => l.includes(P + 'a.bin') && /attempt 1\/4/.test(l));
        expect(line).toBeTruthy();
        expect(line).toMatch(new RegExp('^\\[R2-HANDOFF\\] GET ' + P.replace(/\//g, '\\/') + 'a\\.bin attempt 1\\/4 ')); // operation + key + application attempt
        expect(line).toMatch(/ name=\S+ code=\S+ http=\S+ /); // error name + code + HTTP status
        expect(line).toMatch(/ sdkAttempts=\? sdkDelay=\? /); // SDK $metadata.attempts/totalRetryDelay FALLBACK (opaque error carries no $metadata)
        expect(line).toMatch(/ class=opaque_transport\/retryable$/); // terminal classification
        expect(classifyR2Error(er({ msg: '' }))).toMatchObject({ retryable: true, terminal: 'opaque_transport' });
    }, 15000);
    it('(§3) GET 408/429/5xx/Body-stream-interrupt each retried-then-success; SDK metadata surfaced (non-fallback) in the redacted log', async () => {
        const r = makeR2(); use(r); seed(r, P, { 'a.bin': bin('a', 16), 'b.bin': bin('b', 16), 'c.bin': bin('c', 16), 'd.bin': bin('d', 16) });
        inj(r, 'GET', P + 'a.bin', er({ http: 408 })); inj(r, 'GET', P + 'b.bin', er({ http: 429 })); inj(r, 'GET', P + 'c.bin', er({ http: 503 })); inj(r, 'GET', P + 'd.bin', er({ stream: true }));
        const res = await runCli(['restore-dir', P, tmp('transient')]); const out = cliResult(res);
        expect([out.success, out.restored]).toEqual([true, 4]);
        const l503 = res.errs.find((l) => l.includes(P + 'c.bin') && /http=503/.test(l));
        expect(l503).toMatch(/ sdkAttempts=2 sdkDelay=10 /); // $metadata present => actual SDK values, not the '?' fallback
    }, 15000);
    it('(Gap 4a) null / non-object / array manifest => STRUCTURED manifest_invalid expected=0 (never throws); --strict CLI exits 1', async () => {
        for (const body of ['null', '"a string"', '12345', '[]', '[1,2,3]']) {
            const r = makeR2(); use(r); r.store.set(P + 'a.bin', bin('a')); r.store.set(P + '_manifest.json', Buffer.from(body));
            const res = await runCli(['restore-dir', P, tmp('nullm'), '--strict']); const out = cliResult(res);
            expect([out.success, out.manifestFound, out.reason, out.expected]).toEqual([false, true, 'manifest_invalid', 0]);
            expect(res.code).toBe(1); // strict fail-closed
        }
    });
    it('(Gap 4b) NON-strict LIST retry-exhausted => STRUCTURED list_failed (never throws out of the CLI); fail-closed', async () => {
        const r = makeR2(); use(r); seedScale(r, P, 3, false); inj(r, 'LIST', P, ...S(4));
        const res = await runCli(['restore-dir', P, tmp('listfail')]); const out = cliResult(res); // resolves (no throw) => structured fail-closed
        expect([out.success, out.manifestFound, out.source, out.reason]).toEqual([false, false, 'list-fallback', 'list_failed']);
        expect(res.errs.join('\n')).toMatch(/LIST fallback failed/);
    }, 15000);
    it('(§E) --strict + confirmed-absent manifest => fail-closed, NO LIST bypass, exit 1', async () => {
        const r = makeR2(); use(r); seed(r, P, { 'a.bin': bin('a') }, false);
        const res = await runCli(['restore-dir', P, tmp('strictabs'), '--strict']); const out = cliResult(res);
        expect([out.success, out.manifestFound, out.reason]).toEqual([false, false, 'manifest_required_strict']);
        expect(r.lists.length).toBe(0); expect(res.code).toBe(1);
    });
    it('(§E) manifest GET retry-EXHAUSTED (5xx x4) => manifest_get_failed, NOT treated as absent (no LIST)', async () => {
        const r = makeR2(); use(r); seed(r, P, { 'a.bin': bin('a') }); inj(r, 'GET', P + '_manifest.json', er({ http: 500 }), er({ http: 500 }), er({ http: 500 }), er({ http: 500 }));
        const res = await runCli(['restore-dir', P, tmp('mexh')]); const out = cliResult(res);
        expect([out.success, out.reason]).toEqual([false, 'manifest_get_failed']); expect(r.lists.length).toBe(0);
    }, 15000);
    it('(§E) manifest present + an ORPHAN not listed => orphan NOT restored (no LIST supplementation)', async () => {
        const r = makeR2(); use(r); seed(r, P, { 'a.bin': bin('a') }); r.store.set(P + 'orphan.bin', bin('o'));
        const d = tmp('orphan'); const res = await runCli(['restore-dir', P, d]); const out = cliResult(res);
        expect([out.success, out.restored]).toEqual([true, 1]); expect(fs.existsSync(path.join(d, 'orphan.bin'))).toBe(false); expect(r.lists.length).toBe(0);
    });
    it('(§E) invalid manifest members (count-mismatch / dup / abs-path / .. traversal) each fail-closed manifest_invalid', async () => {
        for (const bad of [{ files: ['a.bin'], count: 2 }, { files: ['a.bin', 'a.bin'], count: 2 }, { files: ['/etc/x'], count: 1 }, { files: ['../esc'], count: 1 }]) {
            const r = makeR2(); use(r); r.store.set(P + '_manifest.json', Buffer.from(JSON.stringify(bad))); r.store.set(P + 'a.bin', bin('a'));
            const res = await runCli(['restore-dir', P, tmp('badmem')]); const out = cliResult(res);
            expect([out.success, out.reason]).toEqual([false, 'manifest_invalid']);
        }
    });
});

describe('backup transport ops via REAL CLI seam (D-380 §D/§F · D-382 §1/§2)', () => {
    // .bin members are >=256B so they clear the non-.zst eligibility floor (else policy-excluded).
    const mkdir = (t: string, n: number) => { const d = tmp(t); for (let k = 0; k < n; k++) w(d, 'f' + k + '.bin', bin('f' + (k % 9), 300)); return d; };
    it('(scale 4015/4015) full backup => committed, ONE client, PUTs=N+1, manifest PUT strictly LAST, exit 0', async () => {
        const r = makeR2(); use(r); const N = 4015; const d = mkdir('bfull', N);
        const res = await runCli(['backup-dir', d, P]);
        expect(res.code).toBe(0); expect(r.cc()).toBe(1); expect(r.puts.length).toBe(N + 1);
        expect(r.puts[r.puts.length - 1]).toBe(P + '_manifest.json'); expect(r.store.has(P + '_manifest.json')).toBe(true);
        expect(res.logs.join('\n')).toMatch(new RegExp('backup-dir OK:.*' + N + '/' + N + ' verified'));
        expect(JSON.parse(r.store.get(P + '_manifest.json')!.toString()).count).toBe(N);
    }, 120000);
    it('(scale 4014/4015) ONE tail-key PUT retry-exhausted => partial, NO manifest, CLI backup-dir exits NON-ZERO; the key is NOT in the (absent) manifest', async () => {
        const r = makeR2(); use(r); const N = 4015; const d = mkdir('bpart', N); const tail = 'f' + (N - 1) + '.bin';
        inj(r, 'PUT', P + tail, ...S(4));
        const res = await runCli(['backup-dir', d, P]);
        expect(res.code).toBe(1); expect(r.store.has(P + '_manifest.json')).toBe(false);
        expect(res.errs.join('\n')).toMatch(/backup-dir NOT committed \(partial_upload\)/);
    }, 120000);
});
