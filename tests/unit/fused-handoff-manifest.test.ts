// tests/unit/fused-handoff-manifest.test.ts
// MASTER-FUSION-HANDOFF PR-A (S1-BR EXACT-PRODUCER R2 HANDOFF) — hermetic EXEC
// invariants for scripts/factory/fused-handoff-manifest.js. The verifier of record
// (manifest generate/verify + descriptor provenance) runs in Compute (produce) and
// Persist/VFS/Upload (consume). These drive the REAL module against an on-disk temp
// fused dir (no R2, no network) and lock: exact set equality, per-file size + sha256,
// set_sha256, the >=400 part + >=400 processedShards gates, the .complete gate, and
// the run-scoped descriptor provenance rules. NEVER count-only acceptance.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    generateManifest, verifyDirAgainstManifest, verifyDescriptor,
    computeSetSha256, PART_FILE_MIN, COMPLETE_SHARD_MIN, CARRIER_TYPE
} from '../../scripts/factory/fused-handoff-manifest.js';

let dir: string;
const CTX = { upstreamRunId: 'U1', factoryRunId: 'F1', producerRunAttempt: 1, headSha: 'deadbeef' };

// A minimally upload-guard-VALID zstd frame for a GUARDED part: magic 28 B5 2F FD + a body (total
// >= 16B == the ZSTD_MIN_BYTES floor). Real fused parts ARE large bulk .json.zst; this is the floor.
// PR-C: part-*.json.zst are uploaded via `backup-dir` so generate now asserts isUploadEligible on them.
function zst(tag: string): Buffer {
    const body = Buffer.from(String(tag).padEnd(12, '.'));
    return Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), body]);
}

function writeFused(n: number, processedShards = n) {
    for (let i = 0; i < n; i++) {
        fs.writeFileSync(path.join(dir, `part-${String(i).padStart(3, '0')}.json.zst`), zst(`shard-payload-${i}`));
    }
    // `.complete` is a small non-.zst JSON sentinel (< 256B). It is a BYPASS member (upload-file +
    // restore-file), EXEMPT from the generate-assert -> written as-is (would be guard-refused if asserted).
    fs.writeFileSync(path.join(dir, '.complete'), JSON.stringify({ processedShards, expectedShards: n }));
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fused-handoff-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('manifest generation (Compute produce)', () => {
    it('#1 generates manifest with the full schema + counts .complete as a file', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        expect(m.schema_version).toBe(1);
        expect(m.carrier_type).toBe(CARRIER_TYPE);
        expect(m.upstream_run_id).toBe('U1');
        expect(m.factory_run_id).toBe('F1');
        expect(m.producer_run_attempt).toBe(1);
        expect(m.head_sha).toBe('deadbeef');
        expect(typeof m.created_at).toBe('string');
        expect(m.part_file_count).toBe(400);
        expect(m.file_count).toBe(401); // 400 parts + .complete
        expect(m.complete_processed_shards).toBe(400);
        expect(m.total_bytes).toBeGreaterThan(0);
        // .complete IS a member of files[]
        expect(m.files.some((f) => f.relative_path === '.complete')).toBe(true);
        // every file carries {relative_path, size_bytes, sha256}
        for (const f of m.files) {
            expect(typeof f.relative_path).toBe('string');
            expect(typeof f.size_bytes).toBe('number');
            expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
        // manifest must NOT contain its own hash
        expect(Object.prototype.hasOwnProperty.call(m, 'manifest_sha256')).toBe(false);
    });

    it('set_sha256 is over the STABLE-SORTED (relative_path, sha256) tuples (order-independent)', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        const shuffled = [...m.files].reverse();
        expect(computeSetSha256(shuffled)).toBe(m.set_sha256);
        // a content change flips the set hash
        const mutated = m.files.map((f, i) => (i === 0 ? { ...f, sha256: 'f'.repeat(64) } : f));
        expect(computeSetSha256(mutated)).not.toBe(m.set_sha256);
    });
});

describe('manifest verification (consume) — exact set + content gates', () => {
    it('verifies a clean produce/consume round-trip', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        const r = verifyDirAgainstManifest(dir, m);
        expect(r.ok).toBe(true);
        expect(r.set_sha256).toBe(m.set_sha256);
    });

    it('#6 missing manifest (null/garbage) => fail-loud', () => {
        writeFused(400);
        expect(verifyDirAgainstManifest(dir, null as never).ok).toBe(false);
        expect(verifyDirAgainstManifest(dir, {} as never).code).toBe('CARRIER_MISMATCH');
    });

    it('#7 .complete missing => fail-loud', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        fs.unlinkSync(path.join(dir, '.complete'));
        // disk set no longer matches manifest (FILE_MISSING) — never silently OK.
        expect(verifyDirAgainstManifest(dir, m).ok).toBe(false);
    });

    it('#7b .complete present but COMPLETE_MISSING reported when truly absent from both', () => {
        // build a manifest WITHOUT .complete, dir WITHOUT .complete -> COMPLETE_MISSING gate.
        // Parts are upload-eligible zst frames (generate asserts GUARDED parts before the verify path).
        for (let i = 0; i < 400; i++) fs.writeFileSync(path.join(dir, `part-${String(i).padStart(3, '0')}.json.zst`), zst(`x${i}`));
        const m = generateManifest(dir, CTX);
        expect(verifyDirAgainstManifest(dir, m).code).toBe('COMPLETE_MISSING');
    });

    it('#8 processedShards < 400 => fail-loud', () => {
        writeFused(400, 399);
        const m = generateManifest(dir, CTX);
        expect(verifyDirAgainstManifest(dir, m).code).toBe('COMPLETE_SHARDS_LOW');
        expect(COMPLETE_SHARD_MIN).toBe(400);
    });

    it('#9 part count < 400 => fail-loud (even when processedShards passes its gate)', () => {
        // 399 parts but the sentinel reports 400 processedShards: the part-count gate
        // must still reject — counts are checked independently, never count-only.
        writeFused(399, 400);
        const m = generateManifest(dir, CTX);
        expect(verifyDirAgainstManifest(dir, m).code).toBe('PART_COUNT_LOW');
        expect(PART_FILE_MIN).toBe(400);
    });

    it('#10 missing file (in manifest, absent on disk) => fail-loud', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        fs.unlinkSync(path.join(dir, 'part-000.json.zst'));
        expect(verifyDirAgainstManifest(dir, m).code).toBe('FILE_MISSING');
    });

    it('#11 extra file (on disk, not in manifest) => fail-loud', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        fs.writeFileSync(path.join(dir, 'part-999.json.zst'), 'rogue');
        expect(verifyDirAgainstManifest(dir, m).code).toBe('FILE_EXTRA');
    });

    it('#12 size mismatch => fail-loud', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        fs.writeFileSync(path.join(dir, 'part-000.json.zst'), 'shard-payload-0-EXTENDED');
        expect(verifyDirAgainstManifest(dir, m).code).toBe('SIZE_MISMATCH');
    });

    it('#13 per-file hash mismatch (same size) => fail-loud', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        const orig = fs.readFileSync(path.join(dir, 'part-000.json.zst'));
        const tamper = Buffer.alloc(orig.length, 0x41);
        fs.writeFileSync(path.join(dir, 'part-000.json.zst'), tamper);
        expect(verifyDirAgainstManifest(dir, m).code).toBe('HASH_MISMATCH');
    });

    it('#14 set hash mismatch => fail-loud', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX);
        const bad = { ...m, set_sha256: '0'.repeat(64) };
        expect(verifyDirAgainstManifest(dir, bad).code).toBe('SET_HASH_MISMATCH');
    });

    it('#14b a manifest that smuggles its own hash => fail-loud (no self-hash)', () => {
        writeFused(400);
        const m = generateManifest(dir, CTX) as Record<string, unknown>;
        m.manifest_sha256 = 'abc';
        expect(verifyDirAgainstManifest(dir, m as never).code).toBe('MANIFEST_SELF_HASH');
    });
});

describe('generate==guard for GUARDED parts + .complete BYPASS exemption (PR-C family-completeness)', () => {
    it('#G1 a guard-refusable part (sub-16B / no zstd magic .zst) fails LOUD MEMBER_UPLOAD_INELIGIBLE at generate', () => {
        writeFused(400);
        // part-*.json.zst upload via `backup-dir` (factory-upload.yml:617) -> the r2-handoff guard CAN
        // refuse them. Corrupt ONE to a sub-floor .zst (no zstd magic, < 16B) -- exactly what the uploader
        // refuses. generate MUST fail loud HERE, never emit a manifest whose exact-set read-back the
        // uploader cannot satisfy (a late FILE_MISSING). ANTI-VACUITY: remove the guarded-assert and
        // generate SUCCEEDS on this dir -> this test reds.
        fs.writeFileSync(path.join(dir, 'part-000.json.zst'), Buffer.from('bad')); // 3B, no magic
        expect(() => generateManifest(dir, CTX)).toThrow(/MEMBER_UPLOAD_INELIGIBLE/);
    });

    it('#G2 the BYPASS .complete sentinel is NEVER upload-asserted -- a tiny (<256B, non-.zst) .complete still generates', () => {
        // `.complete` reaches R2 via upload-file:621 + restore-file:744/902 belt-and-suspenders, so it
        // ALWAYS reaches R2. It is a small non-.zst JSON far below the 256B floor -> asserting it would be a
        // FALSE fail-loud that breaks the pipeline. Guards the OPPOSITE error (wrongly asserting a bypass member).
        writeFused(400);
        const complete = fs.readFileSync(path.join(dir, '.complete'));
        expect(complete.length).toBeLessThan(256); // would be guard-refused if it were asserted
        const m = generateManifest(dir, CTX); // must NOT throw
        expect(m.files.some((f) => f.relative_path === '.complete')).toBe(true);
        expect(verifyDirAgainstManifest(dir, m).ok).toBe(true); // exact-set read-back still verifies clean
    });

    it('#G3 a large real part (>>16B valid frame) is INCLUDED (no false fail-loud on a legit part)', () => {
        writeFused(400);
        fs.writeFileSync(path.join(dir, 'part-000.json.zst'), Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.alloc(65536, 0x41)]));
        const m = generateManifest(dir, CTX);
        expect(m.part_file_count).toBe(400);
        expect(verifyDirAgainstManifest(dir, m).ok).toBe(true);
    });
});

describe('descriptor provenance (consume)', () => {
    const base = {
        producer_attempt: 1,
        exact_staging_prefix: 'state/_handoff/fused/U1/F1/attempt-1/',
        manifest_sha256: 'm', set_sha256: 's',
        upstream_run_id: 'U1', factory_run_id: 'F1', head_sha: 'abc', created_at: '2026-06-18T00:00:00Z'
    };
    const cur = { upstreamRunId: 'U1', factoryRunId: 'F1', runAttempt: 2 };

    it('#3 current attempt 2 consumes a descriptor pointing at producer attempt 1', () => {
        const r = verifyDescriptor(base, cur);
        expect(r.ok).toBe(true);
        expect(r.staging_prefix).toBe('state/_handoff/fused/U1/F1/attempt-1/');
    });

    it('#4 descriptor to a different run/upstream => fail', () => {
        expect(verifyDescriptor({ ...base, factory_run_id: 'F2' }, cur).code).toBe('DESC_RUN_MISMATCH');
        expect(verifyDescriptor({ ...base, upstream_run_id: 'U2' }, cur).code).toBe('DESC_UPSTREAM_MISMATCH');
    });

    it('#5 producer_attempt > current run_attempt => fail', () => {
        expect(verifyDescriptor({ ...base, producer_attempt: 3, exact_staging_prefix: 'state/_handoff/fused/U1/F1/attempt-3/' }, cur).code).toBe('DESC_ATTEMPT_FUTURE');
    });

    it('malformed / missing-field descriptor => fail (no list-latest, no guess)', () => {
        expect(verifyDescriptor(null as never, cur).code).toBe('DESC_MALFORMED');
        const { set_sha256, ...noSet } = base; void set_sha256;
        expect(verifyDescriptor(noSet as never, cur).code).toBe('DESC_FIELD_MISSING');
    });

    it('exact_staging_prefix must match the derived run+attempt path (no prefix smuggling)', () => {
        const tampered = { ...base, exact_staging_prefix: 'state/_handoff/fused/U1/F1/attempt-LATEST/' };
        expect(verifyDescriptor(tampered, cur).code).toBe('DESC_PREFIX_MISMATCH');
    });

    it('producer_attempt must be a positive int', () => {
        expect(verifyDescriptor({ ...base, producer_attempt: 0 }, cur).code).toBe('DESC_ATTEMPT_INVALID');
    });
});
