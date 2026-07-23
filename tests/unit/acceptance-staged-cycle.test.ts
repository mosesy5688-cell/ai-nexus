import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// @ts-ignore — JS ESM module (no .d.ts); tested for its runtime contract.
import { REQUIRED_SINGLETONS, metaShardLogicals, assertManifestCensus, verifyCycleExhaustive } from '../../scripts/factory/acceptance-staged-cycle.js';

// Vitest-collected hermetic suite for R5 exhaustive VERIFY + manifest census +
// poison quarantine (acceptance-staged-cycle.js). All R2 I/O is injected (DI).
// Converted 1:1 from scripts/factory/acceptance-staged-cycle.test.mjs.

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function harness(metaShards: number, opts: any = {}) {
    const bytesByLogical: any = {}; const blobs: any = {};
    const put = (logical: string, body: Buffer) => { bytesByLogical[logical] = body; blobs[logical] = sha(body); };
    for (let i = 0; i < metaShards; i += 1) put(`meta-${String(i).padStart(2, '0')}.db`, Buffer.from('M' + i));
    for (const s of REQUIRED_SINGLETONS) put(s, Buffer.from('S:' + s));
    if (opts.extraBlobs) for (const [l, b] of Object.entries(opts.extraBlobs)) put(l, b as Buffer);
    const manifest: any = { build_id: opts.buildId || 'run-1-a1-x', partitions: { meta_shards: metaShards, ...(opts.partitions || {}) }, blobs };
    if (opts.drop) for (const d of opts.drop) delete manifest.blobs[d];
    const store = new Map();
    for (const [logical, body] of Object.entries(bytesByLogical)) store.set(`data/blobs/${blobs[logical]}`, body);
    const dl = { calls: [] as string[] };
    const downloadBlob = async (key: string) => {
        dl.calls.push(key);
        if (opts.absent && opts.absent.has(key)) return null;
        if (opts.error && opts.error.has(key)) { const e: any = new Error('server'); e.code = 'HTTP_503'; throw e; }
        if (opts.poison && opts.poison.has(key)) return Buffer.from('POISONED-BYTES-' + key);
        return store.get(key);
    };
    const quarantine = { store: new Map(), calls: [] as string[] };
    const putQuarantine = async (key: string, body: Buffer) => {
        quarantine.calls.push(key);
        if (quarantine.store.has(key)) return { ok: false, precondition_failed: true }; // create-only, write-once
        quarantine.store.set(key, body); return { ok: true };
    };
    return { manifest, blobs, store, downloadBlob, putQuarantine, quarantine, dl };
}
const blobKey = (h: any, logical: string) => `data/blobs/${h.blobs[logical]}`;

describe('R5 census invariant', () => {
    it('(AC-A1) metaShardLogicals is contiguous 2-digit; bad partitions throw', () => {
        expect(metaShardLogicals(3)).toStrictEqual(['meta-00.db', 'meta-01.db', 'meta-02.db']);
        expect(() => metaShardLogicals(0)).toThrow(/positive integer/);
        expect(() => metaShardLogicals(undefined)).toThrow(/positive integer/);
    });
    it('(AC-A2) a COMPLETE manifest passes census', () => {
        expect(assertManifestCensus(harness(4).manifest)).toStrictEqual({ ok: true, failures: [] });
    });
    it('(AC-A3 / RED) a DROPPED meta shard FAILS census (under-enumeration caught pre-hash)', () => {
        const r = assertManifestCensus(harness(4, { drop: ['meta-02.db'] }).manifest);
        expect(r.ok).toBe(false);
        expect(r.failures.includes('CENSUS_MISSING:meta-02.db')).toBe(true);
    });
    it('(AC-A4 / RED) a DROPPED required singleton FAILS census', () => {
        const r = assertManifestCensus(harness(2, { drop: ['id-index.bin'] }).manifest);
        expect(r.ok).toBe(false);
        expect(r.failures.includes('CENSUS_MISSING:id-index.bin')).toBe(true);
    });
    it('(AC-A5 / RED) a fused-shard GAP FAILS census', () => {
        const r = assertManifestCensus(harness(2, { extraBlobs: { 'fused-shard-000.bin': Buffer.from('F0'), 'fused-shard-002.bin': Buffer.from('F2') } }).manifest);
        expect(r.ok).toBe(false);
        expect(r.failures.includes('CENSUS_FUSED_GAP:1')).toBe(true);
    });
    it('(AC-A6 / RED) a DROPPED reader anchor (meta-knowledge.db / meta-report.db) FAILS census', () => {
        for (const anchor of ['meta-knowledge.db', 'meta-report.db']) {
            const r = assertManifestCensus(harness(3, { drop: [anchor] }).manifest);
            expect(r.ok).toBe(false);
            expect(r.failures.includes(`CENSUS_MISSING:${anchor}`)).toBe(true);
        }
    });
    it('(AC-A7 / RED) with rankings_dbs, a DROPPED required rankings-<type>.db FAILS census', () => {
        const rankings = { 'rankings-model.db': Buffer.from('RM'), 'rankings-paper.db': Buffer.from('RP'), 'rankings-tool.db': Buffer.from('RT') };
        const partitions = { rankings_dbs: true, type_counts: { model: 9, paper: 4, dataset: 0, tool: 2 } };
        // complete (dataset=0 so rankings-dataset.db legitimately absent) => PASS
        expect(assertManifestCensus(harness(2, { extraBlobs: rankings, partitions }).manifest)).toStrictEqual({ ok: true, failures: [] });
        const r = assertManifestCensus(harness(2, { extraBlobs: rankings, partitions, drop: ['rankings-paper.db'] }).manifest);
        expect(r.ok).toBe(false);
        expect(r.failures.includes('CENSUS_MISSING:rankings-paper.db')).toBe(true);
    });
    it('(AC-A8 / no over-fail) a valid cycle WITHOUT rankings passes (rankings_dbs not set)', () => {
        expect(assertManifestCensus(harness(3).manifest)).toStrictEqual({ ok: true, failures: [] });
    });
    it('(AC-A9 / no over-fail) an empty type (type_counts=0) does NOT require its rankings db', () => {
        const partitions = { rankings_dbs: true, type_counts: { model: 5, paper: 0, dataset: 0, tool: 0 } };
        expect(assertManifestCensus(harness(2, { extraBlobs: { 'rankings-model.db': Buffer.from('RM') }, partitions }).manifest)).toStrictEqual({ ok: true, failures: [] });
        const r = assertManifestCensus(harness(2, { partitions }).manifest);
        expect(r.ok).toBe(false);
        expect(r.failures.includes('CENSUS_MISSING:rankings-model.db')).toBe(true);
    });
});

describe('R5 exhaustive VERIFY (fenced / clean / poison / absent / 5xx)', () => {
    it('(AC-B1 / fence) stage_disabled => fenced no-op: no GET-and-rehash, not verified', async () => {
        const h = harness(2);
        const r = await verifyCycleExhaustive({ cycleManifest: h.manifest, downloadBlob: h.downloadBlob, putQuarantine: h.putQuarantine });
        expect(r.fenced).toBe(true);
        expect(r.verified).toBe(false);
        expect(h.dl.calls.length).toBe(0);
    });
    it('(AC-B2) enabled + all bytes hash to their key => VERIFIED (every blob GET, not a sample)', async () => {
        const h = harness(4);
        const r = await verifyCycleExhaustive({ mode: 'stage_enabled', cycleManifest: h.manifest, downloadBlob: h.downloadBlob, putQuarantine: h.putQuarantine });
        expect(r.verified).toBe(true);
        expect(r.failures.length).toBe(0);
        expect(h.dl.calls.length).toBe(Object.keys(h.manifest.blobs).length);
    });
    it('(AC-B3 / poison) a blob whose bytes do NOT hash to its key is CAUGHT (not key/HEAD-trusted) + quarantined', async () => {
        const poisonKey = blobKey(harness(3), 'meta-01.db');
        const h2 = harness(3, { poison: new Set([poisonKey]) });
        const r = await verifyCycleExhaustive({ mode: 'stage_enabled', cycleManifest: h2.manifest, downloadBlob: h2.downloadBlob, putQuarantine: h2.putQuarantine });
        expect(r.verified).toBe(false);
        expect(r.failures.some((f: string) => f.startsWith('POISON:meta-01.db'))).toBe(true);
        expect(h2.quarantine.store.size).toBe(1);
        expect([...h2.quarantine.store.keys()][0].startsWith('data/quarantine/run-1-a1-x/')).toBe(true);
    });
    it('(AC-B4 / poison write-once) re-verify never OVERWRITES the quarantine key', async () => {
        const poisonKey = `data/blobs/${sha(Buffer.from('M1'))}`; // meta-01 key
        const h = harness(3, { poison: new Set([poisonKey]) });
        await verifyCycleExhaustive({ mode: 'stage_enabled', cycleManifest: h.manifest, downloadBlob: h.downloadBlob, putQuarantine: h.putQuarantine });
        const firstRec = [...h.quarantine.store.values()][0];
        await verifyCycleExhaustive({ mode: 'stage_enabled', cycleManifest: h.manifest, downloadBlob: h.downloadBlob, putQuarantine: h.putQuarantine });
        expect(h.quarantine.store.size).toBe(1);
        expect([...h.quarantine.store.values()][0]).toBe(firstRec);
        expect(h.quarantine.calls.length >= 2).toBe(true);
    });
    it('(AC-B5) a MISSING blob (404/null) never reaches verified', async () => {
        const h = harness(2, { absent: new Set([`data/blobs/${sha(Buffer.from('M0'))}`]) });
        const r = await verifyCycleExhaustive({ mode: 'stage_enabled', cycleManifest: h.manifest, downloadBlob: h.downloadBlob, putQuarantine: h.putQuarantine });
        expect(r.verified).toBe(false);
        expect(r.failures.some((f: string) => f.startsWith('ABSENT:meta-00.db'))).toBe(true);
    });
    it('(AC-B6) a 5xx / download-failure never reaches verified (fail-closed)', async () => {
        const h = harness(2, { error: new Set([`data/blobs/${sha(Buffer.from('M1'))}`]) });
        const r = await verifyCycleExhaustive({ mode: 'stage_enabled', cycleManifest: h.manifest, downloadBlob: h.downloadBlob, putQuarantine: h.putQuarantine });
        expect(r.verified).toBe(false);
        expect(r.failures.some((f: string) => f.startsWith('DOWNLOAD_FAIL:meta-01.db'))).toBe(true);
    });
    it('(AC-B7) census failure short-circuits verify (no partial "verified")', async () => {
        const h = harness(3, { drop: ['meta-02.db'] });
        const r = await verifyCycleExhaustive({ mode: 'stage_enabled', cycleManifest: h.manifest, downloadBlob: h.downloadBlob, putQuarantine: h.putQuarantine });
        expect(r.verified).toBe(false);
        expect(r.failures.includes('CENSUS_MISSING:meta-02.db')).toBe(true);
        expect(h.dl.calls.length).toBe(0);
    });
});

describe('R5 source audit — no pointer / DELETE / GC / serving mutation', () => {
    it('(AC-C1) ALL changed source files write NO data/current.json, add NO DeleteObject / concurrency', () => {
        const roots = [
            'scripts/factory/lib/build-id.js',
            'scripts/factory/lib/pack-finalizer.js',
            'scripts/factory/lib/r2-bridge.js',
            'scripts/factory/lib/r5-staging.js',
            'scripts/factory/r2-upload-s3.js',
            'scripts/factory/acceptance-staged-cycle.js',
        ];
        // A WRITE primitive on the same line as current.json = an actual pointer write
        // (Phase 3). Fence comments/logs that merely mention "no data/current.json" are
        // not writes, so this is line- + write-scoped to avoid false positives.
        const writeToPointer = /(putConditional|putQuarantine|putObjectConditional|PutObjectCommand|streamToR2|uploadBuffer|\.put\()[^\n]*current\.json/;
        for (const f of roots) {
            const src = fs.readFileSync(path.resolve(process.cwd(), f), 'utf8');
            for (const line of src.split('\n')) expect(writeToPointer.test(line)).toBe(false);
            expect(/DeleteObjects?Command|deleteObject/.test(src)).toBe(false);
        }
        const r5 = fs.readFileSync(path.resolve(process.cwd(), 'scripts/factory/lib/r5-staging.js'), 'utf8');
        expect(/concurrency:/.test(r5)).toBe(false);
    });
});
