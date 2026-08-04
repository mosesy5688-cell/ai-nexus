// D-2026-0803-397 CAS primitive contract. HERMETIC: the S3 client is a mock, ZERO real network and
// ZERO R2 access. Proves the single-response read (body AND the exact server ETag from ONE
// GetObjectCommand), the opaque-token guarantee, STATUS PRECEDENCE on BOTH paths (a service code
// never overrides a status), the exactly-one-condition single-part PUT with no internal retry and no
// unconditional downgrade, the IfMatch:'*' ban, and acceptance that is never inferred.
// R2_RUNTIME_EXERCISE = NOT PERFORMED. PRODUCTION_CAS = NOT WIRED.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
    readObjectWithVersion, putObjectConditional, classifyContentionState,
    CAS_READ_STATE, CAS_WRITE_OUTCOME, CAS_ERROR_CODE, CasError
} from '../../scripts/factory/lib/r2-object-cas.js';

const SRC_PATH = path.resolve(__dirname, '../../scripts/factory/lib/r2-object-cas.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
// Executable body of the write primitive only, so the no-retry canary cannot be satisfied by comments.
const PUT_CODE = CODE.slice(CODE.indexOf('export async function putObjectConditional')).split('\nconst FORK_VERDICTS')[0];

// Deliberately hostile opaque tokens: embedded quotes, a weak-validator prefix and surrounding
// whitespace. A conforming primitive forwards them byte-for-byte.
const RAW_ETAG = '"9a0364b9e99bb480dd25e1f0284c8555-7"';
const WEIRD_ETAG = ' W/"a b/c" ';
const T = { bucket: 'test-bucket', key: 'state/_authority/registry/CURRENT.json' };
const BODY = Buffer.from('{"generation":8}');

type Sent = { name: string; input: any };
function makeClient(handler: (c: Sent) => any) {
    const sent: Sent[] = [];
    const send = async (cmd: any) => { const c = { name: cmd.constructor.name, input: cmd.input }; sent.push(c); return handler(c); };
    return { sent, send };
}
function s3err(name: string, status: number | null, extra: any = {}) {
    const e: any = Object.assign(new Error(`injected ${name}`), { name });
    if (status !== null) e.$metadata = { httpStatusCode: status };
    return Object.assign(e, extra);
}
const bare = (extra: any) => Object.assign(new Error('boom'), extra);
const stream = (buf: Buffer) => (async function* () { yield buf; })();
const okGet = (body: Buffer, etag: string) => ({ Body: stream(body), ETag: etag, ContentLength: body.length });
const throwing = (err: any) => makeClient(() => { throw err; });
const put = (resolved: any) => putObjectConditional(makeClient(() => resolved), { ...T, body: BODY, ifMatch: RAW_ETAG });
describe('readObjectWithVersion: one GET carries both the body and its own version', () => {
    it('returns the body AND the raw server ETag from exactly one GetObjectCommand', async () => {
        const c = makeClient(() => okGet(BODY, RAW_ETAG));
        const r = await readObjectWithVersion(c, T);
        expect(r.state).toBe(CAS_READ_STATE.PRESENT);
        expect(r.body.toString()).toBe('{"generation":8}');
        expect(r.version).toBe(RAW_ETAG);
        expect(c.sent.map((s) => s.name)).toEqual(['GetObjectCommand']);
        expect(c.sent[0].input).toEqual({ Bucket: T.bucket, Key: T.key });
    });
    it('treats the ETag as opaque: no unquote, no trim, no parse, no regeneration', async () => {
        const r = await readObjectWithVersion(makeClient(() => okGet(Buffer.from('x'), WEIRD_ETAG)), T);
        expect(r.version).toBe(WEIRD_ETAG);
        expect(r.version).not.toBe(WEIRD_ETAG.trim());
    });
    it('flows that exact ETag verbatim into IfMatch on the following PUT', async () => {
        const read = await readObjectWithVersion(makeClient(() => okGet(Buffer.from('a'), WEIRD_ETAG)), T);
        const wc = makeClient(() => ({ ETag: '"next"' }));
        await putObjectConditional(wc, { ...T, body: BODY, ifMatch: read.version });
        expect(wc.sent).toHaveLength(1);
        expect(wc.sent[0].input.IfMatch).toBe(WEIRD_ETAG);
        expect(wc.sent[0].input.IfNoneMatch).toBeUndefined();
    });
    it('accepts a transformToByteArray body without a second round trip', async () => {
        const c = makeClient(() => ({ ETag: RAW_ETAG, ContentLength: 3, Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }));
        expect([...(await readObjectWithVersion(c, T)).body]).toEqual([1, 2, 3]);
        expect(c.sent).toHaveLength(1);
    });
    it('a response without a version token fails loud', async () => {
        const c = makeClient(() => ({ Body: stream(Buffer.from('x')), ContentLength: 1 }));
        await expect(readObjectWithVersion(c, T)).rejects.toMatchObject({ code: CAS_ERROR_CODE.VERSION_MISSING });
    });
});
describe('STATUS PRECEDENCE on the read path: absence is ONLY a genuine not-found', () => {
    it('any 404, or a NoSuchKey code with NO status, is ABSENT', async () => {
        const absent = [s3err('NoSuchKey', 404), s3err('NoSuchBucket', 404), s3err('Other', 404),
            s3err('NoSuchKey', null), bare({ Code: 'NoSuchKey' })];
        for (const err of absent) {
            const r = await readObjectWithVersion(throwing(err), T);
            expect(r.state).toBe(CAS_READ_STATE.ABSENT);
            expect(r.version).toBeNull();
            expect(r.body).toBeNull();
        }
    });
    it('a NoSuchKey NAME never overrides a non-404 status', async () => {
        for (const status of [500, 503, 403, 409, 412]) {
            await expect(readObjectWithVersion(throwing(s3err('NoSuchKey', status)), T))
                .rejects.toMatchObject({ code: CAS_ERROR_CODE.READ_FAILED });
        }
        await expect(readObjectWithVersion(throwing(bare({ Code: 'NoSuchKey', $metadata: { httpStatusCode: 500 } })), T))
            .rejects.toMatchObject({ code: CAS_ERROR_CODE.READ_FAILED });
    });
    it('403, 5xx and transport faults FAIL LOUD and never masquerade as ABSENT', async () => {
        for (const err of [s3err('AccessDenied', 403), s3err('InternalError', 500), s3err('SlowDown', 503),
            s3err('TimeoutError', null, { code: 'ECONNRESET' })]) {
            await expect(readObjectWithVersion(throwing(err), T))
                .rejects.toMatchObject({ name: 'CasError', code: CAS_ERROR_CODE.READ_FAILED });
        }
    });
    it('a body-read failure is a loud CAS_BODY_READ_FAILED, not ABSENT', async () => {
        const broken = (async function* () { yield Buffer.from('pa'); throw s3err('ECONNRESET', null); })();
        for (const body of [broken, null]) {
            const c = makeClient(() => ({ Body: body, ETag: RAW_ETAG, ContentLength: 2 }));
            await expect(readObjectWithVersion(c, T)).rejects.toMatchObject({ code: CAS_ERROR_CODE.BODY_READ_FAILED });
        }
    });
});
describe('torn-body guard: the ContentLength of the SAME response is enforced, never skipped', () => {
    const readWith = (declared: any, text = 'abc') =>
        readObjectWithVersion(makeClient(() => ({ Body: stream(Buffer.from(text)), ETag: RAW_ETAG, ContentLength: declared })), T);
    it('rejects a mismatch AND every unusable declared length rather than disabling the guard', async () => {
        for (const declared of [9, undefined, null, 'abc', -1, 1.5, NaN, {}, true, -1n]) {
            await expect(readWith(declared)).rejects.toMatchObject({ code: CAS_ERROR_CODE.TRUNCATED_BODY });
        }
    });
    it('accepts a matching number, digit-string or BigInt, including a legitimate zero', async () => {
        for (const declared of [3, '3', 3n]) expect((await readWith(declared)).content_length).toBe(3);
        expect((await readWith(0, '')).content_length).toBe(0);
    });
});
describe('no HeadObjectCommand and no split read anywhere in the primitive', () => {
    it('imports exactly GetObjectCommand and PutObjectCommand from the S3 client', () => {
        expect(CODE).toMatch(/import \{ GetObjectCommand, PutObjectCommand \} from '@aws-sdk\/client-s3';/);
        expect(CODE.match(/from '@aws-sdk\/[^']+'/g)).toEqual(["from '@aws-sdk/client-s3'"]);
    });
    it('contains no HeadObject, no multipart and no Upload helper in executable code', () => {
        for (const banned of ['HeadObject', 'lib-storage', 'Upload', 'CreateMultipartUpload', 'UploadPart']) {
            expect(CODE.includes(banned)).toBe(false);
        }
    });
    it('a read issues one command and a write issues one command', async () => {
        const rc = makeClient(() => okGet(Buffer.from('a'), RAW_ETAG));
        await readObjectWithVersion(rc, T);
        const wc = makeClient(() => ({ ETag: '"n"' }));
        await putObjectConditional(wc, { ...T, body: BODY, ifNoneMatch: '*' });
        expect(rc.sent).toHaveLength(1);
        expect(wc.sent).toHaveLength(1);
        expect(wc.sent[0].name).toBe('PutObjectCommand');
    });
});
describe('putObjectConditional: exactly one USABLE condition, rejected before any send', () => {
    const rejects = async (over: any) => {
        const c = makeClient(() => ({ ETag: '"n"' }));
        await expect(putObjectConditional(c, { ...T, body: BODY, ...over }))
            .rejects.toMatchObject({ code: CAS_ERROR_CODE.INVALID_PRECONDITION });
        expect(c.sent).toHaveLength(0);
    };
    it('rejects a missing condition, a double condition, and a non-wildcard IfNoneMatch', async () => {
        await rejects({});
        await rejects({ ifMatch: RAW_ETAG, ifNoneMatch: '*' });
        await rejects({ ifNoneMatch: 'etag' });
    });
    it('rejects a PRESENT but unusable ifMatch instead of silently becoming a cold-start create', async () => {
        // Presence decides "supplied": '' or 0 alongside a valid ifNoneMatch is a DOUBLE condition.
        for (const junk of ['', 0, false, 7, {}]) {
            await rejects({ ifMatch: junk, ifNoneMatch: '*' });
            await rejects({ ifMatch: junk });
        }
    });
    it("rejects IfMatch:'*' at the primitive: an existence check is not a compare-and-swap", async () => {
        await rejects({ ifMatch: '*' });
    });
    it('rejects a missing bucket, key or body before any send', async () => {
        const c = makeClient(() => ({ ETag: '"n"' }));
        await expect(putObjectConditional(c, { bucket: '', key: T.key, body: BODY, ifNoneMatch: '*' }))
            .rejects.toMatchObject({ code: CAS_ERROR_CODE.INVALID_INVOCATION });
        await expect(putObjectConditional(c, { ...T, ifNoneMatch: '*' }))
            .rejects.toMatchObject({ code: CAS_ERROR_CODE.INVALID_INVOCATION });
        expect(c.sent).toHaveLength(0);
    });
    it('sends ONE single-part PutObjectCommand and returns WRITTEN only on server acceptance', async () => {
        const c = makeClient(() => ({ ETag: '"gen-8"' }));
        const r = await putObjectConditional(c, { ...T, body: BODY, ifMatch: RAW_ETAG, contentType: 'application/json' });
        expect(r).toMatchObject({ outcome: CAS_WRITE_OUTCOME.WRITTEN, contention: false, version: '"gen-8"' });
        expect(c.sent).toHaveLength(1);
        expect(c.sent[0].input).toEqual({ Bucket: T.bucket, Key: T.key, Body: BODY, IfMatch: RAW_ETAG, ContentType: 'application/json' });
    });
});
describe('STATUS PRECEDENCE on the write path: a service code never overrides a status', () => {
    const thrown = async (err: any) => {
        const c = throwing(err);
        const r = await putObjectConditional(c, { ...T, body: BODY, ifMatch: RAW_ETAG });
        expect(c.sent).toHaveLength(1); // exactly one send, no transport retry
        return r;
    };
    const fatal = async (err: any) => {
        const c = throwing(err);
        await expect(putObjectConditional(c, { ...T, body: BODY, ifMatch: RAW_ETAG }))
            .rejects.toMatchObject({ code: CAS_ERROR_CODE.PUT_FAILED });
        expect(c.sent).toHaveLength(1);
    };
    it('CONFLICTING (status, code) pairs are decided by the STATUS alone', async () => {
        expect((await thrown(s3err('PreconditionFailed', 409))).outcome).toBe(CAS_WRITE_OUTCOME.CONTENTION);
        expect((await thrown(s3err('ConflictException', 412))).outcome).toBe(CAS_WRITE_OUTCOME.PRECONDITION_FAILED);
        expect((await thrown(s3err('OperationAborted', 412))).outcome).toBe(CAS_WRITE_OUTCOME.PRECONDITION_FAILED);
    });
    it('a transient status with a contention NAME is FATAL, never a terminal contention verdict', async () => {
        for (const status of [500, 503, 403, 200, 404, 429]) {
            await fatal(s3err('PreconditionFailed', status));
            await fatal(s3err('OperationAborted', status));
        }
    });
    it('only a STATUS-LESS error consults the exact service codes', async () => {
        expect((await thrown(s3err('PreconditionFailed', null))).outcome).toBe(CAS_WRITE_OUTCOME.PRECONDITION_FAILED);
        expect((await thrown(s3err('ConflictException', null))).outcome).toBe(CAS_WRITE_OUTCOME.CONTENTION);
        expect((await thrown(s3err('OperationAborted', null))).outcome).toBe(CAS_WRITE_OUTCOME.CONTENTION);
        expect((await thrown(bare({ Code: 'PreconditionFailed' }))).outcome).toBe(CAS_WRITE_OUTCOME.PRECONDITION_FAILED);
        await fatal(bare({ code: 'ECONNRESET' }));
        await fatal(s3err('SomeOtherError', null));
    });
    it('agreeing pairs still classify, and 412 stays distinct from 409', async () => {
        expect(await thrown(s3err('PreconditionFailed', 412)))
            .toMatchObject({ outcome: CAS_WRITE_OUTCOME.PRECONDITION_FAILED, contention: true, version: null });
        expect(await thrown(s3err('ConflictException', 409)))
            .toMatchObject({ outcome: CAS_WRITE_OUTCOME.CONTENTION, contention: true, version: null });
        expect(CAS_WRITE_OUTCOME.PRECONDITION_FAILED).not.toBe(CAS_WRITE_OUTCOME.CONTENTION);
    });
    it('the write primitive contains no loop, timer or retry construct', () => {
        expect(PUT_CODE.length).toBeGreaterThan(200);
        expect(PUT_CODE).not.toMatch(/for\s*\(|while\s*\(|setTimeout|maxAttempts|attempt|retry/i);
    });
});
describe('acceptance is never inferred from "send did not throw"', () => {
    it('a resolved value with no usable acceptance token is NEVER WRITTEN', async () => {
        const noSignal = [null, undefined, {}, { $metadata: {} }, 'ok', 7, { ETag: '' },
            { $metadata: { httpStatusCode: 200 } }, { $metadata: { httpStatusCode: 204 }, ETag: '' },
            { $metadata: { httpStatusCode: 206 }, ETag: '"g1"' }, { $metadata: { httpStatusCode: 500 }, ETag: '"x"' },
            { $metadata: { httpStatusCode: 302 } }];
        for (const resolved of noSignal) {
            await expect(put(resolved)).rejects.toMatchObject({ code: CAS_ERROR_CODE.INVALID_RESPONSE });
        }
    });
    it('a resolved 412/409 is contention; only a non-206 2xx or a bare ETag is acceptance', async () => {
        expect((await put({ $metadata: { httpStatusCode: 412 } })).outcome).toBe(CAS_WRITE_OUTCOME.PRECONDITION_FAILED);
        expect((await put({ $metadata: { httpStatusCode: 409 } })).outcome).toBe(CAS_WRITE_OUTCOME.CONTENTION);
        expect((await put({ $metadata: { httpStatusCode: 204 }, ETag: '"g1"' })).outcome).toBe(CAS_WRITE_OUTCOME.WRITTEN);
        expect((await put({ ETag: '"g1"' })).version).toBe('"g1"');
    });
    it('never claims writer success from a classification', () => {
        expect(classifyContentionState({
            previously_observed_generation: 4, intended_generation: 5, new_generation: 5,
            intended_authority_identity_digest: 'a', new_authority_identity_digest: 'a',
            intended_record_digest: 'r', new_record_digest: 'r'
        }).writer_success).toBe(false);
        expect(new CasError('X', 'y').name).toBe('CasError');
    });
});
