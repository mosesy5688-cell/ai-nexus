// W3-O1 (Founder D-89) — 3-state parse-attrition canary gates.
// PRESENT_VALID -> PASS/DEGRADED ; EXPECTED_BUT_MISSING -> FAIL(block) ;
// NOT_ACTIVE_OR_NOT_APPLICABLE -> NOT_EVALUATED/WARN(never block, never PASS).
import { describe, it, expect } from 'vitest';
import {
    EXPECTED_PROTOCOL,
    newParseIntegrityAggregate,
    accumulateParseAccounting,
    accumulateNotApplicable,
    evaluateParseIntegrity,
} from '../../scripts/factory/lib/parse-integrity-canary.js';
import { classifyAccountingProtocol } from '../../scripts/factory/lib/rust-bridge.js';

const cap = (protocol: any) => ({ engineMode: protocol === 'unavailable' ? 'js' : 'rust', protocol });
// A well-formed protocol-v1 self-declaring summary (NAPI camelCase shape).
const validAcc = (declared: number, dropped: number) => ({
    protocolVersion: 1,
    declared,
    parsed: declared - dropped,
    dropped,
    parseErrors: dropped,
    conserved: true,
    errorClasses: dropped > 0 ? ['json_parse_error'] : [],
});

describe('W3-O1 3-state canary (D-89)', () => {
    it('gate1: protocol v1 + zero drops -> PASS / PRESENT_VALID', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, validAcc(1000, 0));
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('PASS');
        expect(v.summary.accounting_status).toBe('PRESENT_VALID');
        expect(v.publicationBlocked).toBe(false);
    });

    it('gate2: protocol v1 + drops>0 -> DEGRADED (not blocking)', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, validAcc(1000, 31));
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('DEGRADED');
        expect(v.summary.accounting_status).toBe('PRESENT_VALID');
        expect(v.publicationBlocked).toBe(false);
        expect(v.summary.dropped_entity_count).toBe(31);
    });

    it('gate3: protocol v1 + summary MISSING (null) -> FAIL / EXPECTED_BUT_MISSING', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, null);
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('FAIL');
        expect(v.summary.accounting_status).toBe('EXPECTED_BUT_MISSING');
        expect(v.publicationBlocked).toBe(true);
    });

    it('gate4: protocol v1 + MALFORMED summary (declared not numeric) -> FAIL', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, { protocolVersion: 1, declared: 'x' } as any);
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('FAIL');
        expect(v.summary.accounting_status).toBe('EXPECTED_BUT_MISSING');
    });

    it('gate5: protocol v1 + conservation mismatch -> FAIL', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, { protocolVersion: 1, declared: 1000, parsed: 990, dropped: 5, parseErrors: 5, conserved: true, errorClasses: [] });
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('FAIL');
        expect(v.publicationBlocked).toBe(true);
    });

    it('gate6/7: legacy .node -> NOT_EVALUATED/WARN, NOT PASS, NOT blocked', () => {
        const agg = newParseIntegrityAggregate(cap('legacy'));
        accumulateParseAccounting(agg, null);
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('NOT_EVALUATED');
        expect(v.summary.accounting_status).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(v.summary.reason).toBe('LEGACY_NATIVE_ADDON');
        expect(v.status).not.toBe('PASS');
        expect(v.publicationBlocked).toBe(false);
    });

    it('gate8: JS fallback -> NOT_APPLICABLE/WARN, NOT PASS', () => {
        const agg = newParseIntegrityAggregate(cap('unavailable'));
        accumulateNotApplicable(agg);
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('NOT_EVALUATED');
        expect(v.summary.reason).toBe('JS_FALLBACK_NO_RUST_READER');
        expect(v.status).not.toBe('PASS');
        expect(v.publicationBlocked).toBe(false);
    });

    it('gate9: zero processed shards -> NOT PASS', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        const v = evaluateParseIntegrity(agg);
        expect(v.status).not.toBe('PASS');
        expect(v.summary.accounting_status).toBe('NOT_ACTIVE_OR_NOT_APPLICABLE');
        expect(v.summary.reason).toBe('NO_SHARDS_PROCESSED');
    });

    it('gate10: defaults / all-JS-fallback cannot fake dropped=0 PASS', () => {
        const def = newParseIntegrityAggregate();
        expect(evaluateParseIntegrity(def).status).not.toBe('PASS');
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateNotApplicable(agg); accumulateNotApplicable(agg);
        const v = evaluateParseIntegrity(agg);
        expect(v.status).not.toBe('PASS');
        expect(v.summary.dropped_entity_count).toBe(0);
        expect(v.summary.reason).toBe('NO_MONITORED_RUST_SHARD');
    });

    it('gate11: missing protocol field is NOT inferred as v1 -> FAIL on capable run', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, { declared: 1000, parsed: 1000, dropped: 0, conserved: true, errorClasses: [] } as any);
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('FAIL');
        expect(v.summary.accounting_status).toBe('EXPECTED_BUT_MISSING');
    });

    it('gate12: every verdict carries an explicit reason code', () => {
        const states = [
            (() => { const a = newParseIntegrityAggregate(cap(1)); accumulateParseAccounting(a, validAcc(10, 0)); return a; })(),
            (() => { const a = newParseIntegrityAggregate(cap(1)); accumulateParseAccounting(a, validAcc(10, 2)); return a; })(),
            (() => { const a = newParseIntegrityAggregate(cap(1)); accumulateParseAccounting(a, null); return a; })(),
            newParseIntegrityAggregate(cap('legacy')),
            newParseIntegrityAggregate(cap('unavailable')),
        ];
        for (const a of states) {
            const v = evaluateParseIntegrity(a);
            expect(typeof v.summary.reason).toBe('string');
            expect(v.summary.reason.length).toBeGreaterThan(0);
        }
    });

    it('gate13: capability handshake classification (+ EXPECTED_PROTOCOL===1)', () => {
        expect(EXPECTED_PROTOCOL).toBe(1);
        expect(classifyAccountingProtocol({ fuseShard: () => {}, nxvfParseAccountingProtocol: () => 1 }))
            .toEqual({ engineMode: 'rust', protocol: 1 });
        expect(classifyAccountingProtocol({ fuseShard: () => {} }).protocol).toBe('legacy');
        expect(classifyAccountingProtocol(null)).toEqual({ engineMode: 'js', protocol: 'unavailable' });
        expect(classifyAccountingProtocol({}).protocol).toBe('unavailable');
    });

    it('mixed run: present-valid + JS-fallback -> PRESENT_VALID, not_applicable surfaced', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, validAcc(1000, 0));
        accumulateNotApplicable(agg);
        const v = evaluateParseIntegrity(agg);
        expect(v.status).toBe('PASS');
        expect(v.summary.not_applicable_shards).toBe(1);
        expect(v.summary.summary_records_seen).toBe(1);
    });

    it('FAIL dominates: one EXPECTED_BUT_MISSING among present-valid -> FAIL', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, validAcc(1000, 0));
        accumulateParseAccounting(agg, null);
        expect(evaluateParseIntegrity(agg).status).toBe('FAIL');
    });

    it('gate15(js): summary never carries raw payload/source fields', () => {
        const agg = newParseIntegrityAggregate(cap(1));
        accumulateParseAccounting(agg, validAcc(1000, 3));
        const keys = Object.keys(evaluateParseIntegrity(agg).summary);
        for (const forbidden of ['payload', 'raw', 'body', 'readme', 'text', 'token', 'secret', 'key']) {
            expect(keys.some(k => k.toLowerCase().includes(forbidden))).toBe(false);
        }
    });
});
