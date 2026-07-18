import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import {
    STAGE_MODE, stagingEnabled, R5_STAGING_PREFIXES, isR5StagingPath,
    BLOB_MULTIPART_THRESHOLD, putBlobConditional, stageCycle, sha256, R5StagingError, main as stageMain,
} from '../../scripts/factory/lib/r5-staging.js';
// @ts-ignore
import { putObjectConditionalFFI } from '../../scripts/factory/lib/r2-bridge.js';

// Vitest-collected hermetic suite for the R5 staging substrate + the r2-bridge
// conditional-write primitive. All R2 I/O is an injected fake/spy — no network,
// no disk. Converted 1:1 from scripts/factory/r5-staging.test.mjs (node:test).

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

function makePutSpy(preexisting: string[] = []) {
    const calls: any[] = []; const store = new Set(preexisting);
    const put = async (key: string, body: Buffer, opts: any = {}) => {
        calls.push({ key, size: body.length, ifNoneMatch: opts.ifNoneMatch, contentType: opts.contentType });
        if (opts.ifNoneMatch === '*' && store.has(key)) return { ok: false, precondition_failed: true };
        store.add(key);
        return { ok: true, etag: 'e-' + key };
    };
    return { put, calls, store };
}
function makeCycle(buildId: string, artifacts: Record<string, Buffer>) {
    const blobs: any = {}; const bytesByLogical: any = {};
    for (const [logical, body] of Object.entries(artifacts)) { blobs[logical] = sha(body); bytesByLogical[logical] = body; }
    return { manifest: { build_id: buildId, partitions: { meta_shards: 1 }, blobs }, bytesByLogical };
}

// A minimal fake AWS S3 client (constructor name != 'R2Client' -> used directly).
class FakeS3 {
    inputs: any[] = []; store = new Map(); faultOnce: any = null;
    async send(command: any) {
        const input = command.input; this.inputs.push(input);
        if (this.faultOnce) { const f = this.faultOnce; this.faultOnce = null; throw f; }
        if (input.IfNoneMatch === '*' && this.store.has(input.Key)) {
            const e: any = new Error('precondition failed'); e.name = 'PreconditionFailed'; e.$metadata = { httpStatusCode: 412 }; throw e;
        }
        this.store.set(input.Key, input.Body);
        return { ETag: '"etag-x"' };
    }
}

describe('R5 staging — fence constants', () => {
    it('(RS-A1) STAGE_MODE is the hardcoded literal stage_disabled + stagingEnabled default false', () => {
        expect(STAGE_MODE).toBe('stage_disabled');
        expect(stagingEnabled()).toBe(false);
        expect(stagingEnabled('stage_enabled')).toBe(true);
    });
    it('(RS-A2) R5 staging prefixes are frozen + isR5StagingPath matches the three write-once roots only', () => {
        expect([...R5_STAGING_PREFIXES]).toStrictEqual(['data/blobs/', 'data/cycles/', 'data/quarantine/']);
        expect(Object.isFrozen(R5_STAGING_PREFIXES)).toBe(true);
        for (const p of ['data/blobs/ab', 'data/cycles/run-1/manifest.json', 'data/quarantine/run-1/x.json']) expect(isR5StagingPath(p)).toBe(true);
        for (const p of ['data/meta-00.db', 'data/id-index.bin', 'data/current.json', 'meta/x', 'cache/y']) expect(isR5StagingPath(p)).toBe(false);
    });
});

describe('R5 conditional-write primitive (putObjectConditionalFFI)', () => {
    it('(RS-B1) create success returns { ok:true, etag } and sends IfNoneMatch:*', async () => {
        const s3 = new FakeS3();
        const r = await putObjectConditionalFFI(s3, 'data/blobs/abc', Buffer.from('X'), { ifNoneMatch: '*' });
        expect(r.ok).toBe(true); expect(r.etag).toBeTruthy();
        expect(s3.inputs[0].IfNoneMatch).toBe('*');
    });
    it('(RS-B2) 412 precondition => { ok:false, precondition_failed } (NOT persisted, not thrown)', async () => {
        const s3 = new FakeS3();
        await putObjectConditionalFFI(s3, 'data/blobs/abc', Buffer.from('X'), { ifNoneMatch: '*' });
        const r = await putObjectConditionalFFI(s3, 'data/blobs/abc', Buffer.from('Y'), { ifNoneMatch: '*' });
        expect(r).toStrictEqual({ ok: false, precondition_failed: true });
    });
    it('(RS-B3) any non-412 error THROWS (fail-loud, never masked)', async () => {
        const s3 = new FakeS3();
        const boom: any = new Error('server'); boom.$metadata = { httpStatusCode: 500 }; s3.faultOnce = boom;
        await expect(putObjectConditionalFFI(s3, 'data/blobs/z', Buffer.from('X'), { ifNoneMatch: '*' })).rejects.toThrow(/Conditional PUT/);
    });
});

describe('R5 staging — multipart FAIL-CLOSED', () => {
    it('(RS-C1) oversized blob FAILS CLOSED with R5_MULTIPART_CONDITIONAL_UNPROVEN + zero PUT', async () => {
        const spy = makePutSpy();
        const big = Buffer.alloc(BLOB_MULTIPART_THRESHOLD + 1, 1);
        let err: any;
        try { await putBlobConditional(spy.put, sha(big), big); } catch (e) { err = e; }
        expect(err).toBeInstanceOf(R5StagingError);
        expect(err.code).toBe('R5_MULTIPART_CONDITIONAL_UNPROVEN');
        expect(spy.calls.length).toBe(0);
    });
    it('(RS-C2) at-threshold blob is single-part create-only (PUT with ifNoneMatch:*)', async () => {
        const spy = makePutSpy();
        const ok = Buffer.alloc(BLOB_MULTIPART_THRESHOLD, 2);
        const r = await putBlobConditional(spy.put, sha(ok), ok);
        expect(r.ok).toBe(true);
        expect(spy.calls[0].ifNoneMatch).toBe('*');
        expect(spy.calls[0].key.startsWith('data/blobs/')).toBe(true);
    });
});

async function fencedNoopUnder(eventName: string) {
    const saved = { ...process.env };
    // Set the trigger + EVERY plausible enabling env var; the hardcoded const must ignore all.
    process.env.GITHUB_EVENT_NAME = eventName;
    process.env.STAGE_MODE = 'stage_enabled';
    process.env.R5_STAGE_ENABLED = 'true';
    process.env.STAGE_ENABLED = 'true';
    try {
        const spy = makePutSpy();
        const { manifest, bytesByLogical } = makeCycle('run-1-a1-x', { 'meta-00.db': Buffer.from('M') });
        const res = await stageCycle({ cycleManifest: manifest, resolveBytes: (l: string) => bytesByLogical[l], putConditional: spy.put });
        expect(res.fenced).toBe(true);
        expect(res.staged).toBe(false);
        expect(spy.calls.length).toBe(0);
    } finally { process.env = saved; }
}

describe('R5 stageCycle — FENCED no-op (production) for cron + manual', () => {
    it('(RS-D1 / fence) stage_disabled => zero new-prefix PUT under CRON (schedule/workflow_run)', async () => {
        await fencedNoopUnder('schedule');
        await fencedNoopUnder('workflow_run');
    });
    it('(RS-D2 / fence) stage_disabled => zero new-prefix PUT under MANUAL (workflow_dispatch)', async () => {
        await fencedNoopUnder('workflow_dispatch');
    });
});

describe('R5 stageCycle — ENABLED path (DI only)', () => {
    it('(RS-E1) enabled: PUTs each blob create-only + cycle manifest LAST; never data/current.json', async () => {
        const spy = makePutSpy();
        const { manifest, bytesByLogical } = makeCycle('run-7-a1-abc', { 'meta-00.db': Buffer.from('M0'), 'id-index.bin': Buffer.from('IDX') });
        const res = await stageCycle({ mode: 'stage_enabled', cycleManifest: manifest, resolveBytes: (l: string) => bytesByLogical[l], putConditional: spy.put });
        expect(res.staged).toBe(true);
        expect(res.blobsPut).toBe(2);
        const keys = spy.calls.map((c: any) => c.key);
        for (const c of spy.calls) expect(c.ifNoneMatch).toBe('*');
        expect(keys[keys.length - 1]).toBe('data/cycles/run-7-a1-abc/manifest.json');
        expect(keys.some((k: string) => k.includes('current.json'))).toBe(false);
        expect(keys.some((k: string) => k.startsWith('data/quarantine/'))).toBe(false);
    });
    it('(RS-E2) enabled: a pre-existing blob key is DEDUPED (precondition-failed), still counted synced', async () => {
        const { manifest, bytesByLogical } = makeCycle('run-8-a1-abc', { 'meta-00.db': Buffer.from('SHARED') });
        const preKey = 'data/blobs/' + manifest.blobs['meta-00.db'];
        const spy = makePutSpy([preKey]);
        const res = await stageCycle({ mode: 'stage_enabled', cycleManifest: manifest, resolveBytes: (l: string) => bytesByLogical[l], putConditional: spy.put });
        expect(res.blobsDeduped).toBe(1);
        expect(res.blobsPut).toBe(0);
        expect(res.synced).toStrictEqual(['meta-00.db']);
    });
    it('(RS-E3) enabled: local bytes not matching the manifest key => FAIL CLOSED (key==content)', async () => {
        const spy = makePutSpy();
        const { manifest } = makeCycle('run-9-a1-abc', { 'meta-00.db': Buffer.from('ORIG') });
        let err: any;
        try { await stageCycle({ mode: 'stage_enabled', cycleManifest: manifest, resolveBytes: () => Buffer.from('TAMPERED'), putConditional: spy.put }); } catch (e) { err = e; }
        expect(err.code).toBe('R5_STAGE_KEY_CONTENT_MISMATCH');
    });
    it('(RS-E4 / RED-restore) the fence is load-bearing: identical inputs -> 0 PUT disabled, >0 PUT enabled', async () => {
        const { manifest, bytesByLogical } = makeCycle('run-10-a1-abc', { 'meta-00.db': Buffer.from('M') });
        const off = makePutSpy();
        await stageCycle({ cycleManifest: manifest, resolveBytes: (l: string) => bytesByLogical[l], putConditional: off.put });
        expect(off.calls.length).toBe(0);
        const on = makePutSpy();
        await stageCycle({ mode: 'stage_enabled', cycleManifest: manifest, resolveBytes: (l: string) => bytesByLogical[l], putConditional: on.put });
        expect(on.calls.length > 0).toBe(true);
    });
    it('(RS-E5) the workflow STAGE entrypoint (r5-staging main) resolves as a fenced no-op', async () => {
        await expect(stageMain()).resolves.toBeUndefined();
    });
});
