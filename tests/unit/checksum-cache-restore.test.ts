// tests/unit/checksum-cache-restore.test.ts
// D-364/D-365/D-366: entity-checksum cache restore-validation via ENTITY_ONLY_DOUBLE_
// RECONCILE, combined cache preserved. REAL validator/reconciler + REAL zstd frames +
// REAL loader + REAL processEntity + REAL candidate enum. task-checksums NEVER touched.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsPromises from 'fs/promises';
import { readFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { zstdCompress } from '../../scripts/factory/lib/zstd-helper.js';
import {
    isValidEntityChecksumArtifact,
    reconcileEntityChecksumCache,
    loadEntityChecksums,
    CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED,
} from '../../scripts/factory/lib/cache-manager.js';
import { processEntity } from '../../scripts/factory/lib/processor-core.js';

const FILE = 'entity-checksums.json.zst';
const TASK = 'task-checksums.json.zst';
const HEX_A = '0123456789abcdef'.repeat(4);   // 64 lowercase hex (varied, RLE-resistant)
const HEX_B = 'fedcba9876543210'.repeat(4);   // 64 lowercase hex
const PAD = ' \t\n'.repeat(80);               // mixed WS: forces frame >= 16B; valid JSON tail
const ZMAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD]); // zstd magic (LE 0xFD2FB528)

const frame = (s: string) => zstdCompress(Buffer.from(s + PAD)); // real zstd frame, size-safe
const CORRUPT = Buffer.concat([ZMAGIC, Buffer.from('garbage-body-000000000000')]); // magic-ok, undecompressable

let dir: string;
let cachePath: string;
let taskPath: string;
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

beforeEach(async () => {
    dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'ckcache-'));
    cachePath = path.join(dir, FILE);
    taskPath = path.join(dir, TASK);
    process.env.CACHE_DIR = dir;
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
        const makes = [() => Buffer.alloc(11), () => CORRUPT, () => frame('{}'), () => frame('[1,2,3]')];
        for (const make of makes) {
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
    it('T6 valid fresh non-empty -> kept', async () => {
        await writeArtifact(await frame(JSON.stringify({ 'hf-model--a/b': HEX_A, 'gh-tool--c/d': HEX_B })));
        expect((await reconcileEntityChecksumCache()).status).toBe('kept');
        expect(await present(cachePath)).toBe(true);
    });
    it('T7 cache miss (no file) -> no-op -> {}', async () => {
        expect((await reconcileEntityChecksumCache()).status).toBe('absent');
        expect(await loadEntityChecksums()).toEqual({});
    });
    it('T8 regeneration deferred -> no fabricated file after invalidation', async () => {
        await writeArtifact(Buffer.alloc(11));
        await reconcileEntityChecksumCache();
        expect(await present(cachePath)).toBe(false);
        expect(await loadEntityChecksums()).toEqual({});
    });
});

describe('D-366 entity-only double-reconcile + fail-closed (A-E, S3)', () => {
    it('A invalid entity + valid task -> entity removed; task bytes UNCHANGED + still a save candidate', async () => {
        const taskBytes = await frame(JSON.stringify({ 'task:1': HEX_A }));
        await fsPromises.writeFile(taskPath, taskBytes);
        await writeArtifact(Buffer.alloc(11));
        expect((await reconcileEntityChecksumCache()).status).toBe('invalidated');
        expect(await present(cachePath)).toBe(false);
        expect(await fsPromises.readFile(taskPath)).toEqual(taskBytes); // never read/deleted/modified
        const c = await candidates();
        expect(c).toContain(TASK);       // still in the combined-save candidate path
        expect(c).not.toContain(FILE);
    });
    it('B invalid entity + missing task -> cache-miss, no fabricated file', async () => {
        await writeArtifact(Buffer.alloc(11));
        await reconcileEntityChecksumCache();
        expect(await present(cachePath)).toBe(false);
        expect(await present(taskPath)).toBe(false); // task not fabricated
        expect(await loadEntityChecksums()).toEqual({});
    });
    it('C valid entity + task -> both kept', async () => {
        const taskBytes = await frame(JSON.stringify({ 'task:1': HEX_A }));
        await fsPromises.writeFile(taskPath, taskBytes);
        await writeArtifact(await frame(JSON.stringify({ 'hf-model--a/b': HEX_A })));
        expect((await reconcileEntityChecksumCache()).status).toBe('kept');
        expect(await present(cachePath)).toBe(true);
        expect(await fsPromises.readFile(taskPath)).toEqual(taskBytes);
    });
    it('D entity re-manufactured invalid AFTER 1st reconcile -> 2nd reconcile (same CLI) removes it again', async () => {
        await writeArtifact(await frame(JSON.stringify({ 'hf-model--a/b': HEX_A })));
        expect((await reconcileEntityChecksumCache()).status).toBe('kept');   // 1st (boundary)
        await writeArtifact(Buffer.alloc(11));                                 // a later writer corrupts it
        expect((await reconcileEntityChecksumCache()).status).toBe('invalidated'); // 2nd (pre post-save)
        expect(await present(cachePath)).toBe(false);
    });
    it('E 2nd reconcile unlink unverifiable -> CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED (job fails, post-save skipped)', async () => {
        await writeArtifact(Buffer.alloc(11));
        const spy = vi.spyOn(fsPromises, 'unlink').mockResolvedValue(undefined as unknown as void); // "succeeds", leaves file
        await expect(reconcileEntityChecksumCache()).rejects.toThrow(CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED);
        expect(spy).toHaveBeenCalled();
        expect(await present(cachePath)).toBe(true); // NOT reported removed
    });
    it('S3 non-regular target (directory) -> refused + fail-closed, never unlinked', async () => {
        await fsPromises.mkdir(cachePath);
        expect(await isValidEntityChecksumArtifact(cachePath)).toEqual({ valid: false, reason: 'not_regular_file' });
        await expect(reconcileEntityChecksumCache()).rejects.toThrow(CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED);
        expect(await present(cachePath)).toBe(true);
    });
});
describe('T10 shared .zst gate files are untouched', () => {
    const r2 = readFileSync(path.resolve(__dirname, '../../scripts/factory/lib/r2-handoff.js'), 'utf8');
    const elig = readFileSync(path.resolve(__dirname, '../../scripts/factory/lib/upload-eligibility.js'), 'utf8');
    it('r2-handoff.js + upload-eligibility.js retain the gate and carry no checksum-cache edits', () => {
        expect(r2).toContain('isUploadEligible');
        expect(r2).toContain('integrity_check_failed');
        expect(elig).toContain('0xFD2FB528'); // the real zstd .zst magic gate
        for (const src of [r2, elig]) {
            expect(src).not.toContain('reconcileEntityChecksumCache');
            expect(src).not.toContain('entity-checksums');
            expect(src).not.toContain(CHECKSUM_CACHE_LOCAL_INVALIDATION_FAILED);
        }
    });
});
describe('T12 data-parity: only _updated varies with checksum state', () => {
    const entity = { id: 'hf-model--foo/bar', slug: 'foo-bar', name: 'Foo', type: 'model', source: 'huggingface', body_content: 'hello world content', tags: ['nlp'] };
    it('valid/stale/empty/missing -> identical emitted entity+fields except _updated', async () => {
        const base = await processEntity({ ...entity }, {}, {}, {}, {}); // empty/missing -> changed
        const matchHash = base._checksum;
        const maps = [{}, { [base.id]: matchHash }, { [base.id]: HEX_A }]; // base.id = normalizeId lookup id: missing, fresh(cache-HIT isChanged=false), stale(nonempty->changed)
        for (const m of maps) {
            const o = await processEntity({ ...entity }, {}, m, {}, {});
            expect(o.success).toBe(true);
            expect(o._checksum).toBe(matchHash); // checksum stable regardless of cache state
            const a: Record<string, unknown> = { ...o.enriched }; const b: Record<string, unknown> = { ...base.enriched };
            delete a._updated; delete b._updated;
            expect(a).toEqual(b);
        }
    });
});

describe('D-366 workflow contract (F/G/H/I) — RED if reverted', () => {
    const wf = readFileSync(path.resolve(__dirname, '../../.github/workflows/factory-harvest.yml'), 'utf8').replace(/\r\n/g, '\n');
    const stepBlock = (name: string) => {
        const s = wf.indexOf(`- name: ${name}`);
        if (s < 0) return '';
        const n = wf.slice(s + 1).indexOf('\n      - name:');
        return n < 0 ? wf.slice(s) : wf.slice(s, s + 1 + n);
    };
    const CLI = 'node scripts/factory/validate-checksum-cache.js';
    const first = wf.indexOf('- name: Validate Restored Checksums Cache');
    const second = wf.indexOf('- name: Reconcile Checksums Before Post-Save');

    it('I Restore Checksums preserves the COMBINED cache baseline (matches 3528bbb9c)', () => {
        const b = stepBlock('Restore Checksums');
        expect(b).toContain('uses: actions/cache@v5');
        expect(b).not.toContain('uses: actions/cache/restore@v5');
        expect(b).toContain('cache/entity-checksums.json.zst');
        expect(b).toContain('cache/task-checksums.json.zst');
        expect(b).toContain('key: checksums-${{ github.run_id }}');
        expect(b).toContain('restore-keys:');
    });
    it('H no should_save / valid-only-save survives (task-INDEPENDENCE preserved)', () => {
        expect(wf).not.toContain('should_save');
        expect(wf).not.toContain('--assert-valid-for-save');
        expect(wf).not.toContain('- name: Save Validated Checksums Cache');
    });
    it('F first reconcile runs before Merge Batches + both R2 backups, not continue-on-error', () => {
        expect(first).toBeGreaterThan(-1);
        expect(first).toBeLessThan(wf.indexOf('- name: Merge Batches'));
        expect(first).toBeLessThan(wf.indexOf('- name: Backup Harvest Cycle to R2'));
        expect(first).toBeLessThan(wf.indexOf('- name: Backup FNI/Accum/Checksums to R2'));
        const b = stepBlock('Validate Restored Checksums Cache');
        expect(b).toContain(CLI);
        expect(b).not.toContain('continue-on-error');
    });
    it('G second reconcile runs after Merge Batches + Save Entity Data to Cache, last, not continue-on-error', () => {
        expect(second).toBeGreaterThan(wf.indexOf('- name: Merge Batches'));
        expect(second).toBeGreaterThan(wf.indexOf('- name: Save Entity Data to Cache'));
        expect(second).toBeGreaterThan(first);
        const b = stepBlock('Reconcile Checksums Before Post-Save');
        expect(b).toContain(CLI);
        expect(b).not.toContain('continue-on-error');
    });
    it('both reconciles invoke the SAME entity-only CLI (>= 2 invocations)', () => {
        expect((wf.match(/node scripts\/factory\/validate-checksum-cache\.js/g) || []).length).toBeGreaterThanOrEqual(2);
    });
});
