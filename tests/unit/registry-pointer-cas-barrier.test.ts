// D-2026-0803-397 concurrency proof. HERMETIC: an in-memory store with REAL conditional-write
// semantics, ZERO network and ZERO R2. Probabilistic races are not evidence, so every interleaving is
// forced by an EXPLICIT barrier that parks each writer at a named command boundary. Includes three
// genuine RED-then-restore mutations (unconditional PUT, loser-reports-success, split read).
// R2_RUNTIME_EXERCISE = NOT PERFORMED. PRODUCTION_CAS = NOT WIRED.
import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as real from '../../scripts/factory/lib/r2-object-cas.js';

const LIB = path.resolve(__dirname, '../../scripts/factory/lib');
const SRC = fs.readFileSync(path.join(LIB, 'r2-object-cas.js'), 'utf8');
const staged: string[] = [];
async function mutate(find: string, replace: string) {
    expect(SRC.split(find).length - 1).toBe(1); // the mutation point must exist exactly once
    const name = `temp_r2_object_cas_mut_${process.pid}_${staged.length}.mjs`;
    fs.writeFileSync(path.join(LIB, name), SRC.replace(find, replace));
    staged.push(name);
    const spec = `../../scripts/factory/lib/${name}`; // opaque to the bundler, resolved at runtime
    return import(spec);
}
afterAll(() => {
    for (const n of staged) { try { fs.unlinkSync(path.join(LIB, n)); } catch (e) { /* best effort */ } }
});

const KEY = 'state/_authority/registry/CURRENT.json';
const BOTH_ACCEPTED = 'IDENT_CONCURRENT_WRITE_BOTH_ACCEPTED';
const TORN = 'IDENT_SPLIT_READ_TORN_PAIR';
type Rec = { generation: number; authority: string; record: string };

function makeCas(initial?: { body: Buffer; etag: string }) {
    const store = new Map<string, { body: Buffer; etag: string }>();
    const bodyOf = new Map<string, string>();
    if (initial) { store.set(KEY, initial); bodyOf.set(initial.etag, initial.body.toString()); }
    const log: string[] = [];
    const applied: Array<{ writer: string; unconditional: boolean }> = [];
    const ordinals = new Map<string, number>();
    const gates = new Map<string, any>();
    const armed = new Set<string>();
    let seq = 0;
    function gate(tag: string) {
        if (!gates.has(tag)) {
            let release!: () => void; let onHit!: () => void;
            const open = new Promise<void>((r) => { release = r; });
            const hit = new Promise<void>((r) => { onHit = r; });
            gates.set(tag, { open, release, hit, onHit });
        }
        return gates.get(tag);
    }
    let skew = 0;
    function err(name: string, status: number) {
        const e: any = new Error(name); e.name = name; e.$metadata = { httpStatusCode: status }; return e;
    }
    function client(writer: string) {
        return { async send(cmd: any) {
            const n = cmd.constructor.name; const i = cmd.input;
            const k = `${writer}:${n}`;
            const ord = (ordinals.get(k) || 0) + 1; ordinals.set(k, ord);
            const tag = `${k}:${ord}`;
            log.push(tag);
            if (armed.has(tag)) { const g = gate(tag); g.onHit(); await g.open; }
            const cur = store.get(i.Key);
            if (n === 'GetObjectCommand') {
                if (!cur) throw err('NoSuchKey', 404);
                // Every GET declares the ContentLength of the body it returns, so the
                // torn-body guard is ARMED in every barrier scenario. skew forces a mismatch.
                return { Body: (async function* () { yield cur.body; })(), ETag: cur.etag, ContentLength: cur.body.length + skew };
            }
            const hasMatch = typeof i.IfMatch === 'string';
            const hasNone = typeof i.IfNoneMatch === 'string';
            if (hasNone && cur) throw err('PreconditionFailed', 412);
            if (hasMatch && (!cur || cur.etag !== i.IfMatch)) throw err('PreconditionFailed', 412);
            const etag = `"v${++seq}"`;
            const body = Buffer.from(i.Body);
            store.set(i.Key, { body, etag });
            bodyOf.set(etag, body.toString());
            applied.push({ writer, unconditional: !hasMatch && !hasNone });
            return { ETag: etag };
        } };
    }
    return { store, bodyOf, log, applied, armed, gate, client, setSkew: (n: number) => { skew = n; } };
}

async function writerRun(mod: any, cas: any, writer: string, rec: Rec) {
    const c = cas.client(writer);
    const observed = await mod.readObjectWithVersion(c, { bucket: 'b', key: KEY });
    const params: any = { bucket: 'b', key: KEY, body: Buffer.from(JSON.stringify(rec)) };
    if (observed.state === 'ABSENT') params.ifNoneMatch = '*'; else params.ifMatch = observed.version;
    const put = await mod.putObjectConditional(c, params);
    return { writer, rec, observed, put };
}

/** Both writers read the SAME state, then A's PUT is admitted first and B's PUT second. */
async function concurrent(mod: any, opts: { cold?: boolean; sameDigest?: boolean } = {}) {
    const prev = opts.cold ? 0 : 4;
    const gen = prev + 1;
    const cas = makeCas(opts.cold ? undefined
        : { body: Buffer.from(JSON.stringify({ generation: prev, authority: 'auth-0', record: 'rec-0' })), etag: '"v0"' });
    const gA = 'A:PutObjectCommand:1'; const gB = 'B:PutObjectCommand:1';
    cas.armed.add(gA); cas.armed.add(gB);
    const recA: Rec = { generation: gen, authority: 'auth-A', record: 'rec-A' };
    const recB: Rec = opts.sameDigest ? { ...recA } : { generation: gen, authority: 'auth-B', record: 'rec-B' };
    const pA = writerRun(mod, cas, 'A', recA); const pB = writerRun(mod, cas, 'B', recB);
    await cas.gate(gA).hit; await cas.gate(gB).hit; // both have READ and are parked before any PUT
    cas.gate(gA).release();
    const rA = await pA;
    cas.gate(gB).release();
    const rB = await pB;
    const winners = [rA, rB].filter((r) => r.put.outcome === real.CAS_WRITE_OUTCOME.WRITTEN);
    const loser = [rA, rB].find((r) => r.put.outcome !== real.CAS_WRITE_OUTCOME.WRITTEN);
    const canary = (cas.applied.length > 1 || winners.length > 1) ? BOTH_ACCEPTED : null;
    let verdict: any = null; let readBack: string | null = null;
    if (loser) {
        const re = await real.readObjectWithVersion(cas.client(`${loser.writer}-reread`), { bucket: 'b', key: KEY });
        readBack = re.body.toString();
        const seen = JSON.parse(readBack);
        verdict = real.classifyContentionState({
            previously_observed_generation: prev, intended_generation: loser.rec.generation,
            new_generation: seen.generation,
            intended_authority_identity_digest: loser.rec.authority, new_authority_identity_digest: seen.authority,
            intended_record_digest: loser.rec.record, new_record_digest: seen.record
        });
    }
    return { cas, rA, rB, winners, loser, canary, verdict, readBack, prev, gen };
}

/** One reader; a competing commit is injected between a split read's two round trips. */
async function splitRead(mod: any) {
    const cas = makeCas({ body: Buffer.from('BODY-1'), etag: '"v0"' });
    const tag = 'S:GetObjectCommand:2';
    cas.armed.add(tag);
    const p = mod.readObjectWithVersion(cas.client('S'), { bucket: 'b', key: KEY });
    const shape = await Promise.race([cas.gate(tag).hit.then(() => 'SPLIT'), p.then(() => 'SINGLE')]);
    if (shape === 'SPLIT') {
        cas.store.set(KEY, { body: Buffer.from('BODY-2'), etag: '"v9"' });
        cas.bodyOf.set('"v9"', 'BODY-2');
        cas.gate(tag).release();
    }
    const r = await p;
    const gets = cas.log.filter((l) => l.includes('GetObjectCommand')).length;
    const torn = cas.bodyOf.get(r.version) !== r.body.toString();
    return { shape, gets, torn, verdict: (shape === 'SPLIT' || torn || gets !== 1) ? TORN : 'GREEN' };
}
describe('barrier: only one writer may ever win', () => {
    it('cold start with IfNoneMatch: two creators, exactly one create is accepted', async () => {
        const o = await concurrent(real, { cold: true });
        expect(o.rA.observed.state).toBe(real.CAS_READ_STATE.ABSENT);
        expect(o.rB.observed.state).toBe(real.CAS_READ_STATE.ABSENT);
        expect(o.cas.log.filter((l) => l.includes('PutObjectCommand'))).toHaveLength(2);
        expect(o.cas.applied).toHaveLength(1);
        expect(o.winners).toHaveLength(1);
        expect(o.loser!.put.outcome).toBe(real.CAS_WRITE_OUTCOME.PRECONDITION_FAILED);
        expect(o.canary).toBeNull();
    });
    it('same (G,V) read, different G+1 written: one PUT applies, the loser forks and is silent', async () => {
        const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const o = await concurrent(real);
        // Assert BEFORE restoring: mockRestore() clears call history, which would make this vacuous.
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
        expect(o.rA.observed.version).toBe(o.rB.observed.version);
        expect(o.cas.applied).toHaveLength(1);
        expect(o.winners).toHaveLength(1);
        expect(o.winners[0].writer).toBe('A');
        expect(o.loser!.writer).toBe('B');
        expect(o.loser!.put.outcome).not.toBe(real.CAS_WRITE_OUTCOME.WRITTEN);
        expect(o.loser!.put.version).toBeNull();
        expect(o.verdict.classification).toBe(real.CAS_CLASSIFICATION.FORK_AUTHORITY_COLLISION);
        expect(o.verdict.fork).toBe(true);
        expect(o.verdict.writer_success).toBe(false);
        expect(JSON.parse(o.readBack!)).toEqual(o.rA.rec); // the store retains ONLY the winner
        expect(o.canary).toBeNull();
    });
    it('identical authority + record digests: the loser is SUPERSEDED_BY_EQUIVALENT, never plain SUPERSEDED', async () => {
        const o = await concurrent(real, { sameDigest: true });
        expect(o.cas.applied).toHaveLength(1);
        expect(o.winners).toHaveLength(1);
        expect(o.verdict.classification).toBe(real.CAS_CLASSIFICATION.SUPERSEDED_BY_EQUIVALENT);
        expect(o.verdict.classification).not.toBe(real.CAS_CLASSIFICATION.SUPERSEDED);
        expect(o.verdict.writer_success).toBe(false);
        expect(o.loser!.put.outcome).not.toBe(real.CAS_WRITE_OUTCOME.WRITTEN);
    });
    it('read-back is diagnostic only: an identical visible record is NOT proof of this write', async () => {
        const o = await concurrent(real, { sameDigest: true });
        expect(JSON.parse(o.readBack!)).toEqual(o.loser!.rec); // byte-identical to what the loser intended
        expect(o.loser!.put.outcome).not.toBe(real.CAS_WRITE_OUTCOME.WRITTEN);
        expect(o.verdict.writer_success).toBe(false);
        expect(o.cas.applied.map((a: any) => a.writer)).toEqual([o.winners[0].writer]);
    });
    it('the torn-body guard is ARMED in this harness: a skewed ContentLength aborts the writer', async () => {
        const cas = makeCas({ body: Buffer.from('BODY-1'), etag: '"v0"' });
        // Proves the guard is live here, not merely disabled by a mock that omits ContentLength.
        expect((await real.readObjectWithVersion(cas.client('probe'), { bucket: 'b', key: KEY })).content_length).toBe(6);
        cas.setSkew(5);
        await expect(real.readObjectWithVersion(cas.client('S'), { bucket: 'b', key: KEY }))
            .rejects.toMatchObject({ code: real.CAS_ERROR_CODE.TRUNCATED_BODY });
        expect(cas.applied).toHaveLength(0); // the writer never reached a PUT
    });
});
describe('mutation proofs: RED then restore', () => {
    it('unconditional-PUT mutation goes RED with IDENT_CONCURRENT_WRITE_BOTH_ACCEPTED', async () => {
        expect((await concurrent(real)).canary).toBeNull();
        const mod = await mutate(
            'const conditions = buildConditionInput(params.ifMatch, params.ifNoneMatch, useIfMatch);',
            'const conditions = {};');
        const red = await concurrent(mod);
        expect(red.canary).toBe(BOTH_ACCEPTED);
        expect(red.cas.applied).toHaveLength(2);
        expect(red.cas.applied.every((a: any) => a.unconditional)).toBe(true);
        expect(red.winners).toHaveLength(2);
        const restored = await concurrent(real);
        expect(restored.canary).toBeNull();
        expect(restored.cas.applied).toHaveLength(1);
    });
    it('loser-reports-success mutation goes RED with IDENT_CONCURRENT_WRITE_BOTH_ACCEPTED', async () => {
        expect((await concurrent(real)).winners).toHaveLength(1);
        const mod = await mutate(
            'if (contention) return writeResult(contention, status);',
            'if (contention) return writeResult(CAS_WRITE_OUTCOME.WRITTEN, status);');
        const red = await concurrent(mod);
        expect(red.canary).toBe(BOTH_ACCEPTED);
        expect(red.winners).toHaveLength(2);
        expect(red.cas.applied).toHaveLength(1); // only one write really landed; two claimed it
        const restored = await concurrent(real);
        expect(restored.canary).toBeNull();
        expect(restored.winners).toHaveLength(1);
    });
    it('split-read mutation goes RED at the barrier with a torn version/body pair', async () => {
        const green = await splitRead(real);
        expect(green.verdict).toBe('GREEN');
        expect(green.shape).toBe('SINGLE');
        expect(green.gets).toBe(1);
        const mod = await mutate(
            'const version = response ? response.ETag : undefined;',
            'const probe = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));\n'
            + '    const version = probe ? probe.ETag : undefined;');
        const red = await splitRead(mod);
        expect(red.verdict).toBe(TORN);
        expect(red.shape).toBe('SPLIT');
        expect(red.gets).toBe(2);
        expect(red.torn).toBe(true);
        const restored = await splitRead(real);
        expect(restored.verdict).toBe('GREEN');
        expect(restored.gets).toBe(1);
    });
});
