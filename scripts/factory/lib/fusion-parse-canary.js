/**
 * W3-O1 (Founder D-89/D-90) fusion parse-attrition CANARY — 3-state,
 * capability-aware, fail-closed-narrow.
 *
 * Consumes the per-shard parse-accounting summaries gathered during Master
 * Fusion plus the engine capability classification, and emits EXACTLY one of
 * three states, each with an explicit reason code:
 *
 *   PRESENT_VALID  (protocol==1 AND EVERY processed shard monitored conserved+
 *       complete — no not-applicable remainder)
 *       -> dropped==0 => PASS ; dropped>0 => DEGRADED (NEVER blocks publication)
 *   EXPECTED_BUT_MISSING  (a v1-capable run, but a summary is missing/old/
 *       non-conserved, OR aggregate non-conservation, OR drop-detail incomplete,
 *       OR a processed shard is neither monitored nor not-applicable — an
 *       unexplained accounting shortfall) -> FAIL + publication blocked. The ONLY
 *       new blocking case.
 *   NOT_ACTIVE_OR_NOT_APPLICABLE  (legacy/JS/no monitored shard/zero shards, OR a
 *       v1 run with monitored shards but a not-applicable/unmonitored remainder
 *       whose attrition is unobserved — a clearly-marked partial)
 *       -> NOT_EVALUATED / WARN. NEVER blocks, NEVER PASS.
 *
 * IRON RULE: UNKNOWN must never become PASS; legacy/inactive must never
 * masquerade as an integrity FAIL. ANTI-EMPTY-SET: no-summary / zero-records /
 * zero-shards / addon-without-field / bridge-default-zero / parser-not-on-path /
 * parse-failure-to-empty-object / expected-shard-count-unestablished can NEVER
 * be reported as dropped=0 PASS.
 */

import { classifyCapability, validateSummary } from './fusion-capability.js';

/** Create a fresh aggregate accumulator. */
export function newCanaryAggregate() {
    return {
        processedShards: 0,
        summaryRecordsSeen: 0,          // shards that attached a parseAccounting object
        monitoredSummaries: 0,          // protocol-v1 'binary' summaries
        notApplicableShards: 0,         // legacy-JSON OR JS-fallback shards (not monitored)
        conservedMonitored: 0,
        declared: 0,
        parsed: 0,
        dropped: 0,
        dropDetailRecordsSeen: 0,       // per-drop records actually surfaced
        nonConservedSummary: false,     // any monitored summary failed conservation
        incompleteDetail: false,        // any monitored summary records<dropped
        malformedSummary: false,        // a shard processed but no/garbage accounting
    };
}

/**
 * Fold one processed shard's parseAccounting into the aggregate.
 * `acc` may be null/undefined (addon returned no field, or JS fallback path).
 */
export function foldShard(agg, acc) {
    agg.processedShards += 1;
    if (acc && typeof acc === 'object') agg.summaryRecordsSeen += 1;
    const v = validateSummary(acc);
    if (v.reason === 'no_accounting_object' || v.reason === 'summary_not_protocol_v1') {
        // A shard was processed but produced no usable v1 summary. On a v1-capable
        // run this is a stranded/missing summary -> EXPECTED_BUT_MISSING fail.
        agg.malformedSummary = true;
        return v;
    }
    if (v.reason === 'engine_path_not_applicable') {
        agg.notApplicableShards += 1; // legacy-JSON shard, valid v1 passthrough, unmonitored
        return v;
    }
    // Monitored binary summary.
    agg.monitoredSummaries += 1;
    agg.declared += v.declared;
    agg.parsed += v.parsed;
    agg.dropped += v.dropped;
    agg.dropDetailRecordsSeen += v.records;
    if (v.conserved) agg.conservedMonitored += 1; else agg.nonConservedSummary = true;
    if (!v.detailComplete) agg.incompleteDetail = true;
    return v;
}

/**
 * Fold one shard that was fused by the JS fallback path (fuseShardFFI returned
 * null). The JS fallback has NO parse-attrition monitoring, so this shard's
 * attrition is unobserved. It MUST be COUNTED as not-applicable (never silently
 * skipped — that would let a fully-monitored 0-drop subset read as a clean
 * dropped=0 PASS while these shards' drops are invisible). It is NOT a stranded
 * monitored summary, so it does NOT set malformedSummary.
 */
export function foldFallbackShard(agg) {
    agg.processedShards += 1;
    agg.notApplicableShards += 1;
    return { reason: 'js_fallback_not_monitored' };
}

/**
 * Final verdict. `cap` is the raw capability surface; `agg` the folded aggregate.
 * `expectedShardCount` is the number of shards Master Fusion intended to process
 * (so a zero-shard / count-unestablished run cannot fake a clean PASS).
 *
 * @returns {object} machine-readable summary (state + verdict + reason + fields).
 */
export function finalizeCanary(cap, agg, expectedShardCount) {
    const capability = classifyCapability(cap);
    const base = {
        accounting_status: '',
        state: '',
        verdict: '',
        blocking: false,
        reason: '',
        protocol_version: capability.protocol,
        engine_mode: capability.engine_mode,
        capability_reason: capability.reason,
        processed_shards: agg.processedShards,
        expected_shards: typeof expectedShardCount === 'number' ? expectedShardCount : -1,
        summary_records_seen: agg.summaryRecordsSeen,
        monitored_summaries: agg.monitoredSummaries,
        not_applicable_shards: agg.notApplicableShards,
        declared_entity_count: agg.declared,
        parsed_entity_count: agg.parsed,
        dropped_entity_count: agg.dropped,
        drop_detail_records_seen: agg.dropDetailRecordsSeen,
    };

    // ── NOT_ACTIVE_OR_NOT_APPLICABLE: legacy / JS / nothing monitored ──
    if (capability.protocol !== 1) {
        return done(base, 'NOT_ACTIVE_OR_NOT_APPLICABLE', 'NOT_EVALUATED', false,
            `not_v1_capable:${capability.reason}`);
    }
    if (typeof expectedShardCount !== 'number' || expectedShardCount <= 0) {
        // v1-capable but the expected count was never established -> cannot PASS,
        // cannot FAIL an integrity claim; warn, never block.
        return done(base, 'NOT_ACTIVE_OR_NOT_APPLICABLE', 'NOT_EVALUATED', false,
            'expected_shard_count_unestablished');
    }
    if (agg.processedShards === 0) {
        return done(base, 'NOT_ACTIVE_OR_NOT_APPLICABLE', 'NOT_EVALUATED', false,
            'zero_shards_processed');
    }

    // ── EXPECTED_BUT_MISSING: v1-capable run but the summary chain is broken ──
    // (missing/old/non-conserved summary, aggregate non-conservation, drop-detail
    //  incomplete, OR an unexplained accounting shortfall — a processed shard
    //  that is NEITHER monitored NOR not-applicable). The ONLY new blocking case.
    if (agg.malformedSummary) {
        return done(base, 'EXPECTED_BUT_MISSING', 'FAIL', true, 'summary_missing_or_malformed');
    }
    // Every processed shard must land in exactly one bucket (monitored OR
    // not-applicable). A shortfall means a shard was processed but never
    // accounted (silently skipped) — a genuine missing summary, FAIL.
    if (agg.monitoredSummaries + agg.notApplicableShards !== agg.processedShards
        || agg.processedShards < expectedShardCount) {
        return done(base, 'EXPECTED_BUT_MISSING', 'FAIL', true, 'unaccounted_processed_shard');
    }

    // ── NOT_ACTIVE_OR_NOT_APPLICABLE: nothing monitored is NOT a FAIL ──
    // An all-not-applicable (all legacy-JSON / all-JS-fallback) run produced zero
    // monitored binary summaries. Per SRS-1 W3O1-CANARY "no monitored shard ->
    // NOT_ACTIVE_OR_NOT_APPLICABLE / NOT_EVALUATED / WARN (never block)". The
    // genuine missing/garbage cases were already caught by malformedSummary above,
    // so reaching here with 0 monitored is a legitimate not-applicable run.
    if (agg.monitoredSummaries === 0) {
        return done(base, 'NOT_ACTIVE_OR_NOT_APPLICABLE', 'NOT_EVALUATED', false,
            'all_shards_not_applicable');
    }

    // Monitored-summary integrity checks (the conserved monitored subset).
    if (agg.nonConservedSummary || agg.declared !== agg.parsed + agg.dropped) {
        return done(base, 'EXPECTED_BUT_MISSING', 'FAIL', true, 'conservation_mismatch');
    }
    if (agg.incompleteDetail || agg.dropDetailRecordsSeen !== agg.dropped) {
        return done(base, 'EXPECTED_BUT_MISSING', 'FAIL', true, 'drop_detail_incomplete');
    }

    // ── Partial-monitoring: some monitored, but a not-applicable remainder whose
    // attrition is UNOBSERVED. A clean dropped=0 PASS would be a lie (drops on the
    // unmonitored shards are invisible), so classify NOT_EVALUATED — never a false
    // PASS, never a FAIL merely for being not-applicable. [DEFECT 1] ──
    if (agg.notApplicableShards > 0) {
        return done(base, 'NOT_ACTIVE_OR_NOT_APPLICABLE', 'NOT_EVALUATED', false,
            'monitored_partial_unobserved_remainder');
    }

    // ── PRESENT_VALID: EVERY shard monitored, conserved + complete. ──
    if (agg.dropped === 0) {
        return done(base, 'PRESENT_VALID', 'PASS', false, 'conserved_zero_drops');
    }
    return done(base, 'PRESENT_VALID', 'DEGRADED', false, 'conserved_with_drops');
}

function done(base, state, verdict, blocking, reason) {
    base.state = state;
    base.verdict = verdict;
    base.blocking = blocking;
    base.reason = reason;
    base.accounting_status = `${state}/${verdict}`;
    return base;
}

/** Build the one machine-readable NXVF_PARSE_DROP log line for a drop record. */
export function dropLogLine(rec) {
    return `NXVF_PARSE_DROP ${JSON.stringify({
        part: rec.part,
        entry_index: rec.entryIndex,
        error_class: rec.errorClass,
        serde_line: rec.serdeLine ?? null,
        serde_column: rec.serdeColumn ?? null,
        payload_length: rec.payloadLength,
        payload_fingerprint: rec.payloadFingerprint ?? null,
        fingerprint_status: rec.fingerprintStatus,
        attribution_status: rec.attributionStatus,
    })}`;
}
