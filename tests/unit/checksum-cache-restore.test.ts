// tests/unit/checksum-cache-restore.test.ts — D-364/D-366/D-370 entity-checksum cache
// restore-validation: double-reconcile + combined cache preserved + OWNER_LOCAL_ONLY_LOAD
// (no R2 re-materialization) + 3rd pre-carrier reconcile + structured stage trace. REAL
// validator/reconciler/loader, REAL zstd frames, REAL candidate enum, REAL processEntity.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { zstdCompress } from '../../scripts/factory/lib/zstd-helper.js';
import {
    isValidEntityChecksumArtifact, reconcileEntityChecksumCache, loadEntityChecksums,
    loadWithFallback, CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED,
} from '../../scripts/factory/lib/cache-manager.js';
import { processEntity } from '../../scripts/factory/lib/processor-core.js';

// R2 mock: cache-core tryR2 gets a client serving an 11B poison. A LOCAL-ONLY load never
// reaches it; the old loadWithFallback path re-materializes it (root cause anchor).
const h = vi.hoisted(() => {
    const state: { getCalls: number; poison: Uint8Array | null } = { getCalls: 0, poison: null };
    const client = { send: async () => { state.getCalls++; return { Body: { transformToByteArray: async () => state.poison }, ContentLength: state.poison ? state.poison.length : 0 }; } };
    return { state, client };
});
vi.mock('../../scripts/factory/lib/r2-helpers.js', async (orig) => ({ ...(await (orig as () => Promise<Record<string, unknown>>)()), createR2Client: () => h.client }));

const FILE = 'entity-checksums.json.zst';
const TASK = 'task-checksums.json.zst';
const HEX_A = '0123456789abcdef'.repeat(4);
const HEX_B = 'fedcba9876543210'.repeat(4);
const PAD = ' \t\n'.repeat(80);                // mixed WS: frame >= 16B, valid JSON tail
const ZMAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]);
const frame = (s: string) => zstdCompress(Buffer.from(s + PAD));
const CORRUPT = Buffer.concat([ZMAGIC, Buffer.from('garbage-body-000000000000')]);
let dir: string, cachePath: string, taskPath: string;
const savedEnv: Record<string, string | undefined> = {};
async function writeArtifact(buf: Buffer) { await fsPromises.writeFile(cachePath, buf); }
async function present(p: string) { try { await fsPromises.lstat(p); return true; } catch { return false; } }
async function candidates(): Promise<string[]> { // mirrors r2-handoff backup-dir walk
    const out: string[] = [];
    const walk = async (d: string, pre: string) => {
        for (const e of await fsPromises.readdir(d, { withFileTypes: true })) {
            const rel = pre ? `${pre}/${e.name}` : e.name;
            if (e.isDirectory()) await walk(path.join(d, e.name), rel); else out.push(rel);
        }
    };
    await walk(dir, '');
    return out;
}
beforeAll(async () => { h.state.poison = new Uint8Array(await zstdCompress(Buffer.from('{}'))); }); // ~11B poison
beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ckcache-'));
    cachePath = path.join(dir, FILE); taskPath = path.join(dir, TASK);
    process.env.CACHE_DIR = dir; h.state.getCalls = 0;
    for (const k of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID', 'CLOUDFLARE_ACCOUNT_ID', 'CF_ACCOUNT_ID', 'FORCE_R2_RESTORE']) {
        savedEnv[k] = process.env[k]; delete process.env[k];
    }
});
afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of Object.keys(savedEnv)) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    await fsPromises.rm(dir, { recursive: true, force: true });
});
describe('isValidEntityChecksumArtifact — exhaustive reason codes', () => {
    const rows: Array<{ n: string; make: () => Buffer | Promise<Buffer>; reason: string }> = [
        { n: 'T1 11B header-only', make: () => Buffer.alloc(11), reason: 'too_small' },
        { n: 'T2 bad magic', make: () => Buffer.from('X'.repeat(40)), reason: 'bad_magic' },
        { n: 'T2 undecompressable', make: () => CORRUPT, reason: 'undecompressable' },
        { n: 'T3 empty object', make: () => frame('{}'), reason: 'empty_set' },
        { n: 'T4 array', make: () => frame('[1,2,3]'), reason: 'not_object' },
        { n: 'T4 primitive', make: () => frame('42'), reason: 'not_object' },
        { n: 'T4 null', make: () => frame('null'), reason: 'not_object' },
        { n: 'S1 empty key', make: () => frame(JSON.stringify({ '': HEX_A })), reason: 'invalid_entry' },
        { n: 'S1 63-hex value', make: () => frame(JSON.stringify({ x: HEX_A.slice(0, 63) })), reason: 'invalid_entry' },
        { n: 'S1 uppercase value', make: () => frame(JSON.stringify({ x: HEX_A.toUpperCase() })), reason: 'invalid_entry' },
        { n: 'S1 non-hex value', make: () => frame(JSON.stringify({ x: 'g' + HEX_A.slice(1) })), reason: 'invalid_entry' },
        { n: 'S1 non-string value', make: () => frame(JSON.stringify({ x: 123 })), reason: 'invalid_entry' },
    ];
    for (const r of rows) it(`${r.n} -> invalid(${r.reason})`, async () => {
        await writeArtifact(await r.make());
        expect(await isValidEntityChecksumArtifact(cachePath)).toEqual({ valid: false, reason: r.reason });
    });
    it('T5/T6 valid non-empty map -> ok', async () => {
        await writeArtifact(await frame(JSON.stringify({ 'hf-model--a/b': HEX_A, 'gh-tool--c/d': HEX_B })));
        expect(await isValidEntityChecksumArtifact(cachePath)).toEqual({ valid: true, reason: 'ok' });
    });
    it('absent path -> missing', async () => {
        expect(await isValidEntityChecksumArtifact(cachePath)).toEqual({ valid: false, reason: 'missing' });
    });
});
describe('reconcileEntityChecksumCache — LOCAL invalidation, fail-closed', () => {
    it('T1/T2/T3/T4 invalid -> removed -> honest cache-miss + absent from candidate set (T9)', async () => {
        for (const make of [() => Buffer.alloc(11), () => CORRUPT, () => frame('{}'), () => frame('[1,2,3]')]) {
            await writeArtifact(await make());
            expect((await reconcileEntityChecksumCache()).status).toBe('invalidated');
            expect(await present(cachePath)).toBe(false);
            expect(await loadEntityChecksums()).toEqual({});
            expect(await candidates()).not.toContain(FILE);
        }
    });
    it('T5 stale-but-nonempty valid -> kept -> in candidate set + load returns map', async () => {
        const map = { 'hf-model--stale/x': HEX_A };
        await writeArtifact(await frame(JSON.stringify(map)));
        expect((await reconcileEntityChecksumCache()).status).toBe('kept');
        expect(await candidates()).toContain(FILE);
        expect(await loadEntityChecksums()).toEqual(map);
    });
    it('T6 valid fresh -> kept; T7 miss -> absent/{}; T8 no fabrication after invalidation', async () => {
        await writeArtifact(await frame(JSON.stringify({ 'hf-model--a/b': HEX_A })));
        expect((await reconcileEntityChecksumCache()).status).toBe('kept');
        await fsPromises.rm(cachePath);
        expect((await reconcileEntityChecksumCache()).status).toBe('absent');
        expect(await loadEntityChecksums()).toEqual({});
        await writeArtifact(Buffer.alloc(11));
        await reconcileEntityChecksumCache();
        expect(await present(cachePath)).toBe(false);
    });
});
describe('D-366 entity-only + fail-closed (A-E, S3)', () => {
    it('A invalid entity + valid task -> entity removed; task bytes UNCHANGED + still a candidate', async () => {
        const taskBytes = await frame(JSON.stringify({ 'task:1': HEX_A }));
        await fsPromises.writeFile(taskPath, taskBytes);
        await writeArtifact(Buffer.alloc(11));
        expect((await reconcileEntityChecksumCache()).status).toBe('invalidated');
        expect(await present(cachePath)).toBe(false);
        expect(await fsPromises.readFile(taskPath)).toEqual(taskBytes);
        const c = await candidates(); expect(c).toContain(TASK); expect(c).not.toContain(FILE);
    });
    it('B invalid entity + missing task -> cache-miss, task not fabricated', async () => {
        await writeArtifact(Buffer.alloc(11));
        await reconcileEntityChecksumCache();
        expect(await present(cachePath)).toBe(false);
        expect(await present(taskPath)).toBe(false);
        expect(await loadEntityChecksums()).toEqual({});
    });
    it('C valid entity + task -> both kept', async () => {
        const taskBytes = await frame(JSON.stringify({ 'task:1': HEX_A }));
        await fsPromises.writeFile(taskPath, taskBytes);
        await writeArtifact(await frame(JSON.stringify({ 'hf-model--a/b': HEX_A })));
        expect((await reconcileEntityChecksumCache()).status).toBe('kept');
        expect(await fsPromises.readFile(taskPath)).toEqual(taskBytes);
    });
    it('D re-manufactured invalid after 1st reconcile -> a later reconcile removes it again', async () => {
        await writeArtifact(await frame(JSON.stringify({ 'hf-model--a/b': HEX_A })));
        expect((await reconcileEntityChecksumCache()).status).toBe('kept');
        await writeArtifact(Buffer.alloc(11));
        expect((await reconcileEntityChecksumCache()).status).toBe('invalidated');
        expect(await present(cachePath)).toBe(false);
    });
    it('E unlink unverifiable -> fail-closed; S3 non-regular -> refused fail-closed', async () => {
        await writeArtifact(Buffer.alloc(11));
        const spy = vi.spyOn(fsPromises, 'unlink').mockResolvedValue(undefined as unknown as void);
        await expect(reconcileEntityChecksumCache()).rejects.toThrow(CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED);
        expect(spy).toHaveBeenCalled();
        expect(await present(cachePath)).toBe(true);
        spy.mockRestore();
        await fsPromises.rm(cachePath); await fsPromises.mkdir(cachePath);
        expect(await isValidEntityChecksumArtifact(cachePath)).toEqual({ valid: false, reason: 'not_regular_file' });
        await expect(reconcileEntityChecksumCache()).rejects.toThrow(CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED);
        expect(await present(cachePath)).toBe(true);
    });
});
describe('D-370 OWNER_LOCAL_ONLY_LOAD — no R2 re-materialization', () => {
    it('missing local + R2 poison available: no GET, no re-materialize -> {}', async () => {
        expect(await present(cachePath)).toBe(false);
        expect(await loadEntityChecksums()).toEqual({});
        expect(h.state.getCalls).toBe(0);
        expect(await present(cachePath)).toBe(false);
    });
    it('ROOT-CAUSE anchor: the old loadWithFallback R2 path DOES re-materialize the 11B poison', async () => {
        expect(await loadWithFallback(FILE, {})).toEqual({});
        expect(h.state.getCalls).toBeGreaterThan(0);
        expect(await present(cachePath)).toBe(true); // poison written to local (cache-core.js:83)
    });
    it('valid local loads normally (no R2); invalid-post-reconcile not re-materialized', async () => {
        const map = { 'hf-model--a/b': HEX_A };
        await writeArtifact(await frame(JSON.stringify(map)));
        expect(await loadEntityChecksums()).toEqual(map);
        await writeArtifact(Buffer.alloc(11));
        await reconcileEntityChecksumCache();
        expect(await loadEntityChecksums()).toEqual({});
        expect(await present(cachePath)).toBe(false);
        expect(h.state.getCalls).toBe(0);
    });
    it('OWNER_LOCAL_ONLY source guard: loadEntityChecksums does NOT delegate to loadWithFallback', () => {
        const cm = readFileSync(path.resolve(__dirname, '../../scripts/factory/lib/cache-manager.js'), 'utf8');
        const body = cm.slice(cm.indexOf('export async function loadEntityChecksums'), cm.indexOf('export async function saveEntityChecksums'));
        expect(body).not.toContain('loadWithFallback');
        expect(body).toContain('isValidEntityChecksumArtifact');
    });
    it('structured trace carries stage/status/reason/size but NO keys/ids/content', async () => {
        const KEY = 'hf-model--secret--entity';
        await writeArtifact(await frame(JSON.stringify({ [KEY]: HEX_A })));
        const logs: string[] = [];
        vi.spyOn(console, 'log').mockImplementation(((...a: unknown[]) => { logs.push(a.join(' ')); }) as unknown as typeof console.log);
        await reconcileEntityChecksumCache({ stage: 'post_owner_load_pre_carrier' });
        const trace = logs.find(l => l.includes('CHECKSUM-CACHE-TRACE')) || '';
        expect(trace).toContain('stage=post_owner_load_pre_carrier');
        expect(trace).toContain('status=kept');
        expect(trace).toMatch(/size=\d+/);
        expect(trace).not.toContain(KEY);
        expect(trace).not.toContain(HEX_A);
    });
});
describe('T10 shared .zst gate files untouched', () => {
    const r2 = readFileSync(path.resolve(__dirname, '../../scripts/factory/lib/r2-handoff.js'), 'utf8');
    const elig = readFileSync(path.resolve(__dirname, '../../scripts/factory/lib/upload-eligibility.js'), 'utf8');
    it('r2-handoff.js + upload-eligibility.js keep the gate, no checksum-cache edits', () => {
        expect(r2).toContain('isUploadEligible'); expect(elig).toContain('0xFD2FB528');
        for (const src of [r2, elig]) { expect(src).not.toContain('reconcileEntityChecksumCache'); expect(src).not.toContain('entity-checksums'); }
    });
});
describe('T12 data-parity: only _updated varies with checksum state', () => {
    const entity = { id: 'hf-model--foo/bar', slug: 'foo-bar', name: 'Foo', type: 'model', source: 'huggingface', body_content: 'hello world content', tags: ['nlp'] };
    it('valid/stale/empty/missing -> identical emitted entity+fields except _updated', async () => {
        const base = await processEntity({ ...entity }, {}, {}, {}, {});
        const matchHash = base._checksum;
        for (const m of [{}, { [base.id]: matchHash }, { [base.id]: HEX_A }]) { // missing, fresh(cache-HIT), stale
            const o = await processEntity({ ...entity }, {}, m, {}, {});
            expect(o.success).toBe(true); expect(o._checksum).toBe(matchHash);
            const a: Record<string, unknown> = { ...o.enriched }; const b: Record<string, unknown> = { ...base.enriched };
            delete a._updated; delete b._updated; expect(a).toEqual(b);
        }
    });
});
describe('D-370 workflow contract: triple reconcile + preserved combined cache (RED if reverted)', () => {
    const wf = readFileSync(path.resolve(__dirname, '../../.github/workflows/factory-harvest.yml'), 'utf8').replace(/\r\n/g, '\n');
    const stepBlock = (n: string) => { const s = wf.indexOf(`- name: ${n}`); if (s < 0) return ''; const x = wf.slice(s + 1).indexOf('\n      - name:'); return x < 0 ? wf.slice(s) : wf.slice(s, s + 1 + x); };
    const at = (n: string) => wf.indexOf(`- name: ${n}`);
    const first = at('Validate Restored Checksums Cache'), pre = at('Reconcile Checksums Pre-Carrier'), last = at('Reconcile Checksums Before Post-Save');
    it('combined cache baseline preserved; no should_save / valid-only save', () => {
        const b = stepBlock('Restore Checksums');
        expect(b).toContain('uses: actions/cache@v5'); expect(b).not.toContain('uses: actions/cache/restore@v5');
        expect(b).toContain('cache/entity-checksums.json.zst'); expect(b).toContain('cache/task-checksums.json.zst');
        expect(b).toContain('key: checksums-${{ github.run_id }}');
        expect(wf).not.toContain('should_save'); expect(wf).not.toContain('--assert-valid-for-save');
    });
    it('three staged reconciles, correctly ordered, none continue-on-error', () => {
        expect(first).toBeGreaterThan(-1); expect(pre).toBeGreaterThan(-1); expect(last).toBeGreaterThan(-1);
        expect(first).toBeLessThan(at('Merge Batches'));
        expect(pre).toBeGreaterThan(at('Merge Batches'));
        expect(pre).toBeLessThan(at('Save Entity Data to Cache'));
        expect(pre).toBeLessThan(at('Backup Harvest Cycle to R2'));
        expect(pre).toBeLessThan(at('Backup FNI/Accum/Checksums to R2'));
        expect(last).toBeGreaterThan(at('Save Entity Data to Cache'));
        for (const [nm, stg] of [['Validate Restored Checksums Cache', 'post_restore'], ['Reconcile Checksums Pre-Carrier', 'post_owner_load_pre_carrier'], ['Reconcile Checksums Before Post-Save', 'pre_post_save']] as const) {
            const b = stepBlock(nm); expect(b).toContain(`validate-checksum-cache.js --stage ${stg}`); expect(b).not.toContain('continue-on-error');
        }
        expect((wf.match(/validate-checksum-cache\.js/g) || []).length).toBe(3);
    });
});
