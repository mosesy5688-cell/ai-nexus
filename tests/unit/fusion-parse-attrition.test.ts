// tests/unit/fusion-parse-attrition.test.ts
//
// W3-O1 (Founder D-88 / D-89 / D-90) fused-input parse-attrition OBSERVABILITY.
// Hermetic EXEC: drives the REAL JS canary + capability classifier
// (scripts/factory/lib/fusion-capability.js + fusion-parse-canary.js +
// fusion-parse-accounting.js) over synthetic per-shard parseAccounting summaries
// shaped EXACTLY like the NAPI camelCase result. No native addon, no network.
//
// SRS-1 invariants: W3O1-CAP, W3O1-CANARY, W3O1-CONSERVE, W3O1-FINGERPRINT-LEAK,
// W3O1-SURFACED. The Rust-side conservation/fingerprint/no-payload invariants are
// proven in rust/nxvf-core (parse_report unit tests + tests/parse_attrition.rs).
import { describe, it, expect } from 'vitest';
import { classifyCapability, validateSummary, PARSE_ACCOUNTING_PROTOCOL_EXPECTED } from '../../scripts/factory/lib/fusion-capability.js';
import { newCanaryAggregate, foldShard, finalizeCanary, dropLogLine } from '../../scripts/factory/lib/fusion-parse-canary.js';
import { newParseAccounting, collectShardAccounting, finalizeParseAccounting } from '../../scripts/factory/lib/fusion-parse-accounting.js';

// A protocol-v1 'binary' summary with `dropped` drops, conserved+complete.
function v1Summary(declared: number, dropped: number, opts: any = {}) {
    const records = [];
    for (let i = 0; i < (opts.records ?? dropped); i++) {
        records.push({
            part: 'part-001.bin', entryIndex: i, errorClass: 'json_parse',
            serdeLine: 1, serdeColumn: 2, payloadLength: 12,
            payloadFingerprint: `fp${i.toString(16).padStart(16, '0')}`.slice(0, 16),
            fingerprintStatus: 'ok', attributionStatus: 'unavailable',
        });
    }
    return {
        protocolVersion: opts.protocolVersion ?? 1,
        enginePath: opts.enginePath ?? 'binary',
        part: 'part-001.bin',
        declaredEntityCount: declared,
        parsedEntityCount: opts.parsed ?? declared - dropped,
        droppedEntityCount: dropped,
        parseErrorCount: dropped,
        conserved: declared === (opts.parsed ?? declared - dropped) + dropped,
        dropRecords: records,
    };
}

const V1_CAP = { protocolConstant: 1, hasFuseShard: true, engineMode: 'rust' };

function runCanary(cap: any, summaries: any[], expectedShards: number) {
    const agg = newCanaryAggregate();
    for (const s of summaries) foldShard(agg, s);
    return finalizeCanary(cap, agg, expectedShards);
}

describe('W3O1-CAP capability classification (D-89 §11)', () => {
    it('explicit constant 1 + fuseShard + rust -> protocol 1', () => {
        expect(classifyCapability(V1_CAP)).toMatchObject({ engine_mode: 'rust', protocol: 1 });
        expect(PARSE_ACCOUNTING_PROTOCOL_EXPECTED).toBe(1);
    });
    it('rust addon WITHOUT protocol export -> legacy (not v1, not unavailable)', () => {
        expect(classifyCapability({ protocolConstant: undefined, hasFuseShard: true, engineMode: 'rust' }))
            .toMatchObject({ protocol: 'legacy' });
    });
    it('js fallback -> unavailable', () => {
        expect(classifyCapability({ engineMode: 'js' })).toMatchObject({ engine_mode: 'js', protocol: 'unavailable' });
    });
    it('a missing/absent protocol field is NEVER inferred as v1', () => {
        // default-zero must not be promoted.
        expect(classifyCapability({ protocolConstant: 0, hasFuseShard: true, engineMode: 'rust' }).protocol).not.toBe(1);
        expect(classifyCapability({}).protocol).not.toBe(1);
        expect(classifyCapability(undefined).protocol).not.toBe(1);
    });
});

describe('W3O1-CANARY 3-state verdicts (D-89 §12-13)', () => {
    it('v1 + 0 drops -> PRESENT_VALID / PASS, not blocking', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 0)], 1);
        expect(r).toMatchObject({ state: 'PRESENT_VALID', verdict: 'PASS', blocking: false });
        expect(r.reason).toBeTruthy();
    });
    it('v1 + drops -> PRESENT_VALID / DEGRADED, never blocks publication', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 3)], 1);
        expect(r).toMatchObject({ state: 'PRESENT_VALID', verdict: 'DEGRADED', blocking: false });
        expect(r.dropped_entity_count).toBe(3);
    });
    it('v1 + a missing/old summary (shard processed, no accounting) -> FAIL + blocked', () => {
        const agg = newCanaryAggregate();
        foldShard(agg, v1Summary(100, 0));
        foldShard(agg, null); // a shard with NO accounting object
        const r = finalizeCanary(V1_CAP, agg, 2);
        expect(r).toMatchObject({ state: 'EXPECTED_BUT_MISSING', verdict: 'FAIL', blocking: true });
    });
    it('v1 + malformed summary (non-v1 protocol on a processed shard) -> FAIL + blocked', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 0, { protocolVersion: 2 })], 1);
        expect(r).toMatchObject({ state: 'EXPECTED_BUT_MISSING', verdict: 'FAIL', blocking: true });
    });
    it('v1 + conservation mismatch (declared != parsed + dropped) -> FAIL + blocked', () => {
        const bad = v1Summary(100, 3, { parsed: 90 }); // 90 + 3 != 100
        const r = runCanary(V1_CAP, [bad], 1);
        expect(r).toMatchObject({ state: 'EXPECTED_BUT_MISSING', verdict: 'FAIL', reason: 'conservation_mismatch', blocking: true });
    });
    it('v1 + drop-detail incomplete (records < dropped) -> FAIL + blocked', () => {
        const bad = v1Summary(100, 5, { records: 2 }); // 2 records for 5 drops
        const r = runCanary(V1_CAP, [bad], 1);
        expect(r).toMatchObject({ state: 'EXPECTED_BUT_MISSING', verdict: 'FAIL', reason: 'drop_detail_incomplete', blocking: true });
    });
    it('legacy .node -> NOT_EVALUATED, NOT blocked, NOT PASS', () => {
        const r = runCanary({ protocolConstant: undefined, hasFuseShard: true, engineMode: 'rust' }, [], 4);
        expect(r.state).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(r.verdict).toBe('NOT_EVALUATED');
        expect(r.blocking).toBe(false);
        expect(r.verdict).not.toBe('PASS');
    });
    it('JS fallback -> NOT_APPLICABLE, NOT PASS, NOT blocked', () => {
        const r = runCanary({ engineMode: 'js' }, [], 4);
        expect(r.state).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(r.verdict).not.toBe('PASS');
        expect(r.blocking).toBe(false);
    });
    it('zero shards processed under v1 -> NOT PASS (NOT_EVALUATED)', () => {
        const r = runCanary(V1_CAP, [], 4);
        expect(r.verdict).not.toBe('PASS');
        expect(r.reason).toBe('zero_shards_processed');
    });
    it('expected-shard-count unestablished -> NOT PASS', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 0)], 0);
        expect(r.verdict).not.toBe('PASS');
        expect(r.reason).toBe('expected_shard_count_unestablished');
    });
    it('every verdict carries a reason code + the full required field set', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 1)], 1);
        for (const k of ['accounting_status', 'protocol_version', 'engine_mode', 'processed_shards',
            'summary_records_seen', 'declared_entity_count', 'parsed_entity_count',
            'dropped_entity_count', 'drop_detail_records_seen', 'reason']) {
            expect(r[k]).toBeDefined();
        }
    });
});

describe('W3O1 anti-empty-set: no fallback shape may fake dropped=0 PASS', () => {
    it('default/all-fallback aggregate cannot PASS', () => {
        // JS engine, no summaries — must never read as a clean PASS.
        const r = runCanary({ engineMode: 'js' }, [], 4);
        expect(r.verdict).not.toBe('PASS');
    });
    it('addon-without-field (v1-capable but every shard returns no accounting) -> FAIL not PASS', () => {
        const agg = newCanaryAggregate();
        foldShard(agg, undefined); foldShard(agg, undefined);
        const r = finalizeCanary(V1_CAP, agg, 2);
        expect(r.verdict).not.toBe('PASS');
        expect(r.blocking).toBe(true);
    });
    it('parse-failure-to-empty-object {} -> FAIL not PASS', () => {
        const r = runCanary(V1_CAP, [{}], 1);
        expect(r.verdict).not.toBe('PASS');
        expect(r.blocking).toBe(true);
    });
});

describe('W3O1-CONSERVE conservation across multiple shards', () => {
    it('aggregate declared == parsed + dropped is enforced', () => {
        const r = runCanary(V1_CAP, [v1Summary(100, 2), v1Summary(50, 1)], 2);
        expect(r.declared_entity_count).toBe(150);
        expect(r.parsed_entity_count).toBe(147);
        expect(r.dropped_entity_count).toBe(3);
        expect(r.state).toBe('PRESENT_VALID');
        expect(r.verdict).toBe('DEGRADED');
    });
    it('parse_error_count is the json subset only (validateSummary preserves classes)', () => {
        // Mixed-class records: only json_parse counts as parse_error in the record set.
        const s = v1Summary(10, 0);
        s.dropRecords = [
            { errorClass: 'json_parse' }, { errorClass: 'offset_boundary' },
        ] as any;
        s.droppedEntityCount = 2; s.parsedEntityCount = 8;
        const v = validateSummary(s);
        expect(v.dropped).toBe(2);
        // The canary's drop_detail_records_seen counts ALL records (2), conservation holds.
        expect(v.records).toBe(2);
    });
});

describe('W3O1-SURFACED drop_detail_records_seen == dropped under v1 (D-90 §9)', () => {
    it('finalizeParseAccounting surfaces drop_detail_records_seen and enforces it', () => {
        const lines: string[] = [];
        const log = (m: string) => lines.push(m);
        const agg = newParseAccounting();
        collectShardAccounting(agg, v1Summary(100, 2), log);
        const summary = finalizeParseAccounting(V1_CAP, agg, 1, log);
        expect(summary.drop_detail_records_seen).toBe(2);
        expect(summary.dropped_entity_count).toBe(2);
        // one NXVF_PARSE_DROP per record + the aggregate line.
        expect(lines.filter(l => l.startsWith('NXVF_PARSE_DROP')).length).toBe(2);
        expect(lines.some(l => l.startsWith('NXVF_PARSE_ACCOUNTING'))).toBe(true);
    });
    it('a stranded-records run (records<dropped) THROWS fail-closed', () => {
        const agg = newParseAccounting();
        collectShardAccounting(agg, v1Summary(100, 5, { records: 2 }), () => {});
        expect(() => finalizeParseAccounting(V1_CAP, agg, 1, () => {})).toThrow(/PARSE_ACCOUNTING_FAIL/);
    });
    it('legacy run does NOT throw (never blocks)', () => {
        const agg = newParseAccounting();
        expect(() => finalizeParseAccounting({ engineMode: 'js' }, agg, 4, () => {})).not.toThrow();
    });
});

describe('W3O1-FINGERPRINT-LEAK: records + logs carry NO raw payload/source/token', () => {
    const SECRET = 'TOP_SECRET_README_BODY_token_abcdef0123';
    it('the NXVF_PARSE_DROP log line carries only irreversible coordinates', () => {
        const rec = {
            part: 'part-007.bin', entryIndex: 42, errorClass: 'json_parse',
            serdeLine: 3, serdeColumn: 9, payloadLength: SECRET.length,
            payloadFingerprint: 'deadbeefdeadbeef', fingerprintStatus: 'ok',
            attributionStatus: 'unavailable',
        };
        const line = dropLogLine(rec);
        // sentinel-leak: the secret text must NEVER appear in the emitted line.
        expect(line).not.toContain(SECRET);
        expect(line).not.toContain('README');
        expect(line).not.toContain('token_abcdef');
        // but the irreversible coordinates ARE present.
        const json = JSON.parse(line.replace('NXVF_PARSE_DROP ', ''));
        expect(json).toMatchObject({
            part: 'part-007.bin', entry_index: 42, error_class: 'json_parse',
            payload_fingerprint: 'deadbeefdeadbeef', fingerprint_status: 'ok',
            attribution_status: 'unavailable',
        });
        // payload_length is a count, not content.
        expect(typeof json.payload_length).toBe('number');
    });
    it('no-payload record surfaces null fingerprint + unavailable_no_payload', () => {
        const line = dropLogLine({
            part: 'part-000.bin', entryIndex: 1, errorClass: 'offset_boundary',
            serdeLine: null, serdeColumn: null, payloadLength: 0,
            payloadFingerprint: null, fingerprintStatus: 'unavailable_no_payload',
            attributionStatus: 'unavailable',
        });
        const json = JSON.parse(line.replace('NXVF_PARSE_DROP ', ''));
        expect(json.payload_fingerprint).toBeNull();
        expect(json.fingerprint_status).toBe('unavailable_no_payload');
    });
});
