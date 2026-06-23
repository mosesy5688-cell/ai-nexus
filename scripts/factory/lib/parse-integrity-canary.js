// W3-O1 parse-attrition observability — THREE-STATE canary (Founder D-89).
//
// OBSERVE-ONLY. Never fixes data, mutates payloads, or changes the >=90% floor.
// It folds per-shard parse accounting (produced by the Rust reader, surfaced via
// fuseShard's NAPI struct -> rust-bridge.js -> master-fusion.js — NEVER parsed
// from console text) and a capability handshake into a 3-state verdict:
//
//   PRESENT_VALID                -> dropped==0 PASS ; dropped>0 DEGRADED
//   EXPECTED_BUT_MISSING         -> FAIL (publication blocked) — the ONLY new block
//   NOT_ACTIVE_OR_NOT_APPLICABLE -> NOT_EVALUATED / WARN (never blocks, never PASS)
//
// IRON RULE (D-89): UNKNOWN MUST NEVER BECOME PASS, BUT LEGACY/INACTIVE MUST NOT
// MASQUERADE AS AN INTEGRITY FAILURE. Zero/absent accounting != zero drops.

export const EXPECTED_PROTOCOL = 1;

/** Fresh aggregate seeded with the run-level capability handshake
 *  (`{ engineMode:'rust'|'js', protocol: number|'legacy'|'unavailable' }`). */
export function newParseIntegrityAggregate(capability) {
    const cap = capability || { engineMode: 'unknown', protocol: 'unavailable' };
    return {
        engineMode: cap.engineMode,
        protocol: cap.protocol,            // run-level: 1 (capable) | 'legacy' | 'unavailable'
        processedShards: 0,
        summaryRecordsSeen: 0,             // shards that returned a PRESENT_VALID v1 summary
        notApplicableShards: 0,            // JS-fallback / legacy shards (Rust reader not observed)
        expectedButMissingShards: 0,       // capable run, but a Rust-path shard's summary absent/old/broken
        conservationBroken: 0,
        declared: 0, parsed: 0, dropped: 0, parseErrors: 0,
        affectedParts: 0,
        errorClasses: new Set(),
    };
}

/** Fold one Rust-path shard's NAPI `parseAccounting` (`acc`) into `agg`.
 *  Capability-aware + anti-empty-set: a missing/old/forged summary on a capable
 *  run is EXPECTED_BUT_MISSING; on a non-capable run it is NOT_APPLICABLE. A
 *  default-zero/absent field is NEVER inferred as a valid v1 summary. */
export function accumulateParseAccounting(agg, acc) {
    agg.processedShards++;
    const capable = agg.protocol === EXPECTED_PROTOCOL;
    const selfDeclaresV1 =
        !!acc && acc.protocolVersion === EXPECTED_PROTOCOL && typeof acc.declared === 'number';
    if (capable && selfDeclaresV1) {
        const conserved = acc.conserved === true && acc.declared === acc.parsed + acc.dropped;
        if (!conserved) { agg.conservationBroken++; agg.expectedButMissingShards++; return agg; }
        agg.summaryRecordsSeen++;
        agg.declared += acc.declared; agg.parsed += acc.parsed; agg.dropped += acc.dropped;
        agg.parseErrors += acc.parseErrors || 0;
        if (acc.dropped > 0) agg.affectedParts++;
        for (const c of acc.errorClasses || []) agg.errorClasses.add(c);
        return agg;
    }
    if (capable) { agg.expectedButMissingShards++; return agg; } // capable but no valid summary
    agg.notApplicableShards++;                                    // legacy/unavailable reader
    return agg;
}

/** A shard that ran the JS fallback (Rust reader not invoked) — NOT observed,
 *  NOT a failure. Counted so it can never silently become a zero-drop PASS. */
export function accumulateNotApplicable(agg) {
    agg.processedShards++;
    agg.notApplicableShards++;
    return agg;
}

/** Evaluate the 3-state canary over a fully-accumulated aggregate. */
export function evaluateParseIntegrity(agg) {
    const capable = agg.protocol === EXPECTED_PROTOCOL;
    const summary = {
        accounting_status: null,
        protocol_version: agg.protocol,
        engine_mode: agg.engineMode,
        processed_shards: agg.processedShards,
        summary_records_seen: agg.summaryRecordsSeen,
        declared_entity_count: agg.declared,
        parsed_entity_count: agg.parsed,
        dropped_entity_count: agg.dropped,
        parse_errors: agg.parseErrors,
        affected_parts: agg.affectedParts,
        not_applicable_shards: agg.notApplicableShards,
        expected_but_missing_shards: agg.expectedButMissingShards,
        distinct_error_classes: [...agg.errorClasses].sort(),
        drop_rate: agg.declared > 0 ? agg.dropped / agg.declared : 0,
        reason: null,
    };
    // 1) Capable run, but a Rust-path shard lost/broke its accounting -> FAIL (fail-closed).
    if (agg.expectedButMissingShards > 0 || agg.conservationBroken > 0) {
        summary.accounting_status = 'EXPECTED_BUT_MISSING';
        summary.reason = `protocol v1 live but ${agg.expectedButMissingShards} shard summary(ies) missing/old/non-conserved`;
        return { status: 'FAIL', publicationBlocked: true, summary };
    }
    // 2) Aggregate conservation cross-check among present-valid shards -> FAIL.
    if (agg.summaryRecordsSeen > 0 && agg.declared !== agg.parsed + agg.dropped) {
        summary.accounting_status = 'EXPECTED_BUT_MISSING';
        summary.reason = `aggregate conservation broken: ${agg.declared} != ${agg.parsed} + ${agg.dropped}`;
        return { status: 'FAIL', publicationBlocked: true, summary };
    }
    // 3) At least one valid v1 conserved summary -> PRESENT_VALID (PASS / DEGRADED).
    if (capable && agg.summaryRecordsSeen > 0) {
        summary.accounting_status = 'PRESENT_VALID';
        if (agg.dropped > 0) {
            summary.reason = `${agg.dropped} entit(ies) dropped across ${agg.affectedParts} part(s) — surfaced, not blocking`;
            return { status: 'DEGRADED', publicationBlocked: false, summary };
        }
        summary.reason = 'no entities dropped';
        return { status: 'PASS', publicationBlocked: false, summary };
    }
    // 4) Observability not active for this run (legacy .node / JS fallback / no
    //    monitored Rust shard / empty). NEVER PASS, NEVER block (anti-empty-set).
    summary.accounting_status = 'NOT_ACTIVE_OR_NOT_APPLICABLE';
    summary.reason =
        agg.protocol === 'legacy' ? 'LEGACY_NATIVE_ADDON'
        : agg.protocol === 'unavailable' ? 'JS_FALLBACK_NO_RUST_READER'
        : agg.processedShards === 0 ? 'NO_SHARDS_PROCESSED'
        : 'NO_MONITORED_RUST_SHARD';
    return { status: 'NOT_EVALUATED', publicationBlocked: false, summary };
}

/** Emit the machine-readable aggregate line + the verdict. */
export function reportParseIntegrity(agg, log = console) {
    const verdict = evaluateParseIntegrity(agg);
    log.log(`NXVF_PARSE_INTEGRITY ${JSON.stringify(verdict.summary)}`);
    const tag = verdict.status === 'FAIL' ? '❌'
        : verdict.status === 'DEGRADED' ? '⚠️'
        : verdict.status === 'NOT_EVALUATED' ? '➖' : '✅';
    log.log(`[PARSE-INTEGRITY] ${tag} ${verdict.status} (${verdict.summary.accounting_status}): ${verdict.summary.reason}`);
    return verdict;
}

/** End-of-fusion finalizer: emit the canary, fail closed ONLY on EXPECTED_BUT_MISSING
 *  (does NOT touch the >=90% floor), and return the sentinel fields to persist. */
export function finalizeParseIntegrity(agg, proc = process, log = console) {
    const verdict = reportParseIntegrity(agg, log);
    if (verdict.status === 'FAIL') {
        log.error(`[PARSE-INTEGRITY] FAIL — ${verdict.summary.reason}. Failing fusion (fail-closed; >=90% floor untouched).`);
        proc.exitCode = 1;
    }
    return { parseIntegrity: verdict.summary, parseIntegrityStatus: verdict.status };
}
