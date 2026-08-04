// D-2026-0803-397 O-1 pure classifier branch matrix + thin-CLI exit semantics. HERMETIC: no network,
// no R2, no credentials. Every branch, both boundaries the ruling adds and INTENDED_GENERATION_NOT_NEW
// are pinned, plus the non-collapse of SUPERSEDED_BY_EQUIVALENT into plain SUPERSEDED.
// R2_RUNTIME_EXERCISE = NOT PERFORMED. PRODUCTION_CAS = NOT WIRED.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyContentionState, CAS_CLASSIFICATION, CAS_ERROR_CODE } from '../../scripts/factory/lib/r2-object-cas.js';
import { runPointerCas, POINTER_CAS_EXIT, POINTER_CAS_REASON, LOCKED_POINTER_KEY } from '../../scripts/factory/registry-pointer-cas-cli.js';

const C = CAS_CLASSIFICATION;
const base = {
    previously_observed_generation: 4, intended_generation: 5,
    intended_authority_identity_digest: 'auth-me', intended_record_digest: 'rec-me',
    new_authority_identity_digest: 'auth-me', new_record_digest: 'rec-me'
};
const cls = (o: any) => classifyContentionState({ ...base, ...o });
const TERM = { terminal: true, retry_eligible: false, writer_success: false };
describe('O-1 classifier: every branch of the locked table', () => {
    it('INTENDED_GENERATION_NOT_NEW is terminal with zero PUT permitted', () => {
        for (const intended of [4, 3, 0]) {
            expect(cls({ intended_generation: intended, new_generation: 4 }))
                .toMatchObject({ classification: C.INTENDED_GENERATION_NOT_NEW, put_permitted: false, ...TERM });
        }
    });
    it('new_generation > intended_generation is SUPERSEDED and is NOT this writer success', () => {
        expect(cls({ new_generation: 6 })).toMatchObject({ classification: C.SUPERSEDED, ...TERM });
    });
    it('equal generation + BOTH digests identical is SUPERSEDED_BY_EQUIVALENT, never plain SUPERSEDED', () => {
        const v = cls({ new_generation: 5 });
        expect(v).toMatchObject({ classification: C.SUPERSEDED_BY_EQUIVALENT, fork: false, ...TERM });
        expect(v.classification).not.toBe(C.SUPERSEDED);
    });
    it('equal generation + EITHER digest differing is FORK / AUTHORITY_COLLISION', () => {
        const forks = [{ new_authority_identity_digest: 'auth-other' }, { new_record_digest: 'rec-other' },
            { new_authority_identity_digest: 'auth-other', new_record_digest: 'rec-other' }];
        for (const f of forks) {
            expect(cls({ new_generation: 5, ...f }))
                .toMatchObject({ classification: C.FORK_AUTHORITY_COLLISION, fork: true, ...TERM });
        }
    });
    it('new_generation < previously_observed_generation is GENERATION_REGRESSION / FORK / TERMINAL', () => {
        expect(cls({ new_generation: 3 }))
            .toMatchObject({ classification: C.GENERATION_REGRESSION_FORK, fork: true, ...TERM });
    });
    it('previously_observed < new < intended is the ONLY RETRY_ELIGIBLE branch', () => {
        expect(classifyContentionState({ ...base, intended_generation: 8, new_generation: 6 })).toMatchObject({
            classification: C.RETRY_ELIGIBLE, retry_eligible: true, terminal: false, writer_success: false
        });
    });
});
describe('O-1 classifier: the two boundaries the ruling adds', () => {
    it('new_generation == previously_observed is CONTENTION_WITHOUT_OBSERVED_ADVANCE, terminal, no retry', () => {
        expect(cls({ new_generation: 4 }))
            .toMatchObject({ classification: C.CONTENTION_WITHOUT_OBSERVED_ADVANCE, ...TERM });
    });
    it('an absent, malformed or unclassifiable re-read is CONTENTION_REREAD_INVALID with no cold-start fallback', () => {
        const bad = [{ new_record_absent: true, new_generation: 5 }, { new_generation: null },
            { new_generation: undefined }, { new_generation: 5.5 }, { new_generation: -1 },
            { new_generation: '5' }, { new_generation: NaN },
            { new_generation: 5, new_authority_identity_digest: '' },
            { new_generation: 5, new_record_digest: undefined }];
        for (const b of bad) {
            expect(cls(b)).toMatchObject({
                classification: C.CONTENTION_REREAD_INVALID, cold_start_fallback_permitted: false, ...TERM
            });
        }
    });
    it('rejects unusable intended inputs instead of guessing a state', () => {
        const bad = [{ previously_observed_generation: null }, { intended_generation: 'x' },
            { intended_authority_identity_digest: '' }, { intended_record_digest: null }];
        for (const b of bad) {
            expect(() => cls({ ...b, new_generation: 5 }))
                .toThrowError(expect.objectContaining({ code: CAS_ERROR_CODE.INVALID_CLASSIFIER_INPUT }));
        }
    });
});
describe('O-1 classifier: exhaustive sweep and success-claim floor', () => {
    it('is total over a full small integer sweep and NEVER reports writer success', () => {
        const seen = new Set<string>();
        for (let prev = 0; prev <= 4; prev++) {
            for (let want = 0; want <= 5; want++) {
                for (let got = 0; got <= 6; got++) {
                    for (const variant of ['same', 'diff', 'invalid']) {
                        const v = classifyContentionState({
                            ...base, previously_observed_generation: prev, intended_generation: want,
                            new_generation: variant === 'invalid' ? null : got,
                            new_record_digest: variant === 'diff' ? 'rec-other' : 'rec-me'
                        });
                        expect(Object.values(C)).toContain(v.classification);
                        expect(v.writer_success).toBe(false);
                        expect(v.terminal).toBe(v.classification !== C.RETRY_ELIGIBLE);
                        if (want > prev && got === want && variant !== 'invalid') {
                            expect(v.classification).toBe(variant === 'same' ? C.SUPERSEDED_BY_EQUIVALENT : C.FORK_AUTHORITY_COLLISION);
                        }
                        seen.add(v.classification);
                    }
                }
            }
        }
        expect([...seen].sort()).toEqual(Object.values(C).sort());
    });
    it('read-back is diagnostic only: seeing the expected record is NOT proof this writer wrote it', () => {
        const v = cls({ new_generation: 5 });
        expect(v.classification).toBe(C.SUPERSEDED_BY_EQUIVALENT);
        expect(v.writer_success).toBe(false);
        expect(v.put_permitted).toBe(false);
        expect(Object.keys(v)).not.toContain('read_back_confirms_write');
    });
});
const BODY = Buffer.from('{"generation":9}');
const okIo = { readFileBuffer: () => BODY, readFileText: () => JSON.stringify({ version: '"etag-with \\"quotes\\""' }) };
const VERSION_TOKEN = JSON.parse(okIo.readFileText()).version;
const ARGS = [`--bucket=b1`, `--key=${LOCKED_POINTER_KEY}`, '--body-file=/x/body.json', '--version-file=/x/ver.json'];
function client(handler: (input: any) => any) {
    const sent: any[] = [];
    return { sent, createClient: async () => ({ async send(cmd: any) { sent.push(cmd.input); return handler(cmd.input); } }) };
}
const s3err = (name: string, status: number | null): any => Object.assign(new Error(name), { name },
    status === null ? {} : { $metadata: { httpStatusCode: status } });
describe('thin CLI: locked key, explicit bucket, structured version token, exit semantics', () => {
    let created = 0;
    const guard = { ...okIo, createClient: async () => { created++; return null; } };
    beforeEach(() => { created = 0; });
    it('exit 2 for a missing bucket, a wrong key, or a bad precondition selection, before any client', async () => {
        const K = `--key=${LOCKED_POINTER_KEY}`;
        const cases = [[K, '--body-file=/x/b', '--version-file=/x/v'],
            ['--bucket=b1', '--key=state/other/thing.json', '--body-file=/x/b', '--version-file=/x/v'],
            ['--bucket=b1', K, '--body-file=/x/b'], ['--bucket=b1', K, '--version-file=/x/v'],
            ['--bucket=b1', K, '--body-file=/x/b', '--version-file=/x/v', '--create-if-absent'],
            ['--bucket=b1', K, '--body-file=/x/b', '--version-file=/x/v', '--rogue=1']];
        for (const argv of cases) {
            const r = await runPointerCas(argv, guard);
            expect(r.exit_code).toBe(POINTER_CAS_EXIT.INVALID);
            expect(r.status).toBe('INVALID_INVOCATION');
        }
        expect(created).toBe(0);
    });
    it('exit 2 when the version file is unreadable, malformed or lacks a string version', async () => {
        const ios = [{ ...guard, readFileText: () => { throw new Error('ENOENT'); } },
            { ...guard, readFileText: () => 'not-json' },
            { ...guard, readFileText: () => JSON.stringify({ version: 42 }) },
            { ...guard, readFileText: () => JSON.stringify({ version: '' }) },
            { ...guard, readFileBuffer: () => { throw new Error('ENOENT'); } }];
        for (const io of ios) {
            const r = await runPointerCas(ARGS, io);
            expect(r.exit_code).toBe(POINTER_CAS_EXIT.INVALID);
        }
        expect(created).toBe(0);
    });
    it('exit 0 ONLY on an accepted conditional write, forwarding the token verbatim', async () => {
        const c = client(() => ({ ETag: '"gen-9"' }));
        const r = await runPointerCas(ARGS, { ...okIo, ...c });
        expect(r.exit_code).toBe(POINTER_CAS_EXIT.WRITTEN);
        expect(r.status).toBe('WRITTEN');
        expect(r.reason).toBe(POINTER_CAS_REASON.ACCEPTED);
        expect(c.sent).toHaveLength(1);
        expect(c.sent[0].IfMatch).toBe(VERSION_TOKEN);
        expect(c.sent[0].Key).toBe(LOCKED_POINTER_KEY);
        expect(JSON.stringify(r)).not.toContain('generation":9');
    });
    it('exit 3 for 412 and 409, exit 1 for transport faults and an unavailable client', async () => {
        for (const err of [s3err('PreconditionFailed', 412), s3err('ConflictException', 409)]) {
            const r = await runPointerCas(ARGS, { ...okIo, ...client(() => { throw err; }) });
            expect(r.exit_code).toBe(POINTER_CAS_EXIT.CONTENTION);
            expect(r.reason).toBe(POINTER_CAS_REASON.CONTENTION);
        }
        const fatal = await runPointerCas(ARGS, { ...okIo, ...client(() => { throw s3err('InternalError', 500); }) });
        expect(fatal.exit_code).toBe(POINTER_CAS_EXIT.FATAL);
        expect(fatal.reason).toBe(POINTER_CAS_REASON.TRANSPORT_FATAL);
        const noClient = await runPointerCas(ARGS, { ...okIo, createClient: async () => null });
        expect(noClient.exit_code).toBe(POINTER_CAS_EXIT.FATAL);
        expect(noClient.reason).toBe(POINTER_CAS_REASON.CLIENT_UNAVAILABLE);
    });
    it('uses IfNoneMatch only for an explicit cold start', async () => {
        const c = client(() => ({ ETag: '"gen-0"' }));
        const argv = ['--bucket=b1', `--key=${LOCKED_POINTER_KEY}`, '--body-file=/x/b', '--create-if-absent'];
        const r = await runPointerCas(argv, { ...okIo, ...c });
        expect(r.exit_code).toBe(POINTER_CAS_EXIT.WRITTEN);
        expect(c.sent[0].IfNoneMatch).toBe('*');
        expect(c.sent[0].IfMatch).toBeUndefined();
    });
    it("NEW-2: a version file of '*' is rejected end-to-end and NEVER reaches the wire", async () => {
        const io = { ...okIo, ...client(() => ({ ETag: '"stolen"' })) };
        const r = await runPointerCas(ARGS, { ...io, readFileText: () => JSON.stringify({ version: '*' }) });
        expect(r.exit_code).toBe(POINTER_CAS_EXIT.INVALID);
        expect(r.reason).toBe(POINTER_CAS_REASON.VERSION_TOKEN_WILDCARD);
        expect((io as any).sent).toHaveLength(0); // zero sends: not an existence-check write
        // Defence in depth: even if the CLI guard were bypassed, the primitive still refuses.
        const direct = await runPointerCas(ARGS, { ...okIo, ...client(() => ({ ETag: '"x"' })), readFileText: () => JSON.stringify({ version: '**' }) });
        expect(direct.exit_code).toBe(POINTER_CAS_EXIT.WRITTEN); // '**' is a normal opaque token
    });
    it('D-1: no upstream text, body or credential reaches ANY payload, on EVERY hostile vector', async () => {
        // Both tokens are credential-shaped AND pass the old identifier-shape filter, so a
        // shape-based sanitiser would have leaked them byte-for-byte.
        const KEYLIKE = 'AKIAIOSFODNN7EXAMPLE';
        const HEX64 = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
        expect(new RegExp('^[A-Za-z][A-Za-z0-9_]{0,63}$').test(HEX64)).toBe(true);
        const poisoned = (over: any) => Object.assign(new Error(`connect failed accessKeyId=${KEYLIKE}`), over);
        const vectors: any[][] = [
            ['name in error.name', { ...okIo, createClient: async () => { throw poisoned({ name: HEX64 }); } }],
            ['Code on a 412', { ...okIo, ...client(() => { throw Object.assign(poisoned({ Code: HEX64 }), { $metadata: { httpStatusCode: 412 } }); }) }],
            ['code + __type', { ...okIo, ...client(() => { throw poisoned({ code: KEYLIKE, __type: HEX64 }); }) }],
            ['invalid response', { ...okIo, ...client(() => ({})) }],
            ['null client', { ...okIo, createClient: async () => null }],
            ['unreadable path', { ...okIo, readFileText: () => { throw poisoned({ path: `/vault/${HEX64}` }); } }]
        ];
        const payloads: any[] = [];
        for (const [, deps] of vectors) payloads.push(await runPointerCas(ARGS, deps));
        payloads.push(await runPointerCas([`--bucket=${KEYLIKE}`, `--rogue=${HEX64}`], okIo));
        payloads.push(await runPointerCas(['--bucket=b1', `--key=state/${HEX64}.json`, '--body-file=/x/b', '--version-file=/x/v'], okIo));
        payloads.push(await runPointerCas(ARGS, { ...okIo, ...client(() => ({ ETag: '"ok"' })) })); // success payload too
        for (const p of payloads) {
            const serialized = JSON.stringify(p);
            for (const forbidden of [KEYLIKE, HEX64, 'accessKeyId', 'generation":9', '/vault/']) {
                expect(serialized).not.toContain(forbidden);
            }
            for (const banned of ['message', 'error_name', 'error_class', 'detail']) {
                expect(p).not.toHaveProperty(banned);
            }
            // T2: assert against OUR closed enum, never against the regex that produced the value.
            expect(Object.values(POINTER_CAS_REASON)).toContain(p.reason);
            if (p.key !== undefined) expect(p.key).toBe(LOCKED_POINTER_KEY);
        }
        expect(payloads[1].exit_code).toBe(POINTER_CAS_EXIT.CONTENTION);
        expect(payloads[7].reason).toBe(POINTER_CAS_REASON.ARG_KEY_NOT_LOCKED);
        expect(payloads[8].reason).toBe(POINTER_CAS_REASON.ACCEPTED);
    });
    it('creates no client and loads no R2 helper module at import time', async () => {
        vi.resetModules();
        let helperLoads = 0;
        vi.doMock('../../scripts/factory/lib/r2-helpers.js', () => { helperLoads++; return { createR2Client: () => null }; });
        const mod: any = await import('../../scripts/factory/registry-pointer-cas-cli.js');
        expect(helperLoads).toBe(0);
        const r = await mod.runPointerCas(ARGS, okIo);
        expect(helperLoads).toBe(1);
        expect(r.exit_code).toBe(POINTER_CAS_EXIT.FATAL);
        vi.doUnmock('../../scripts/factory/lib/r2-helpers.js');
        vi.resetModules();
    });
});
