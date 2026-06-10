/**
 * D0 source_trail coverage GATE (PR-D0b WARN->FAIL flip, "Coverage Green").
 *
 * Extracted from verify-mesh-canary.js (CES 250). The canary REPORTED coverage in
 * WARN mode while D0 threading rolled out; with coverage measured Green (run
 * 27274000163 rerun: 192/192 lines 100.0%, 0 gap, [dict:loaded] x2 host jobs,
 * graph_blob 994038/994038 by-producer {mesh_graph_explains, rel_extractor},
 * ui_related_mesh 100.0% every shard), the WARN-first / measure-then-enforce
 * protocol flips this to a bake-FAIL gate via verify-db's check() mechanism.
 *
 * Gate is a REASON-ALLOWLIST, not a numeric threshold (PM decision). Per sink:
 *  1. FAIL if any gap carries a reason OUTSIDE the legal-drop allowlist
 *     ('concept-stub-drop'-class legitimate drops only). 'unresolvable-ref',
 *     'no-refs', reverse-verb gaps and any unknown/new reason FAIL.
 *  2. FAIL on measurement-integrity loss: reverse refs exist in scanned data AND
 *     the baked sidecar dict did NOT load (status != 'loaded' -> graphDict /
 *     'absent' fallback). #2171 lesson: a silent graphDict fallback mis-reports a
 *     fake ~25% gap; with the flip that would surface as confusing
 *     unresolvable-ref FAILs, so fail fast on the integrity loss itself.
 *  3. 100% / 0-gap (today's reality) and allowlisted-reason-only gaps PASS (logged,
 *     not failed).
 */

// Legal-drop reason allowlist. A gap with a reason in this set is a KNOWN-legitimate
// drop and does NOT fail the bake; everything else (unresolvable-ref, no-refs,
// no-dict, bad-method, bad-producer, empty-source_field, unknown, and any future
// reason) FAILS. Concept/knowledge stubs are RESOLVE-FILTERED out at the producer
// before they reach this canary, so 'concept-stub-drop' is the named legitimate
// class. Adding a future legal reason is a one-line PR here.
export const LEGAL_DROP_REASONS = Object.freeze(['concept-stub-drop']);

/** Gap reasons present on a sink that are NOT in the legal-drop allowlist. */
function illegalReasons(gapByReason) {
    return Object.keys(gapByReason || {}).filter(r => !LEGAL_DROP_REASONS.includes(r));
}

/**
 * Build a SYNTHETIC sink row that encodes a measurement SKIP (mesh_graph parse
 * failure / sink scan throw) as a gap whose reason (`mesh_graph-parse-failed`,
 * `sink-scan-failed`, ...) is NOT in LEGAL_DROP_REASONS. Pushed through the SAME
 * enforceSourceTrailGate reason-allowlist so a "not measured" skip auto-FAILs the
 * bake via the unified mechanism -- never a vacuous pass via a bypass check() call.
 * Verification Rule: a skipped scan is an absence of proof, scored as a FAIL.
 * `err` (optional) supplies a short human cause in the logged line near the catch.
 */
export function syntheticFailureSink(sink, reason, err = null) {
    const cause = err && err.message ? ` (${err.message.slice(0, 40)})` : '';
    console.log(`[VERIFY] source_trail ${sink}: SKIP -> FAIL reason=${reason}${cause}`);
    return {
        sink, scanned: 0, covered: 0, pct: '0.0', gap: 1,
        byProducer: {}, gapByType: {}, gapByReason: { [reason]: 1 }, dictStatus: 'n/a',
    };
}

/**
 * One-shot helper for a catch that must RETURN immediately (mesh_graph parse fail):
 * synth a failure sink and run it through the unified gate. Returns undefined so the
 * caller can `return failGate(...)` and keep the catch body to a single line.
 */
export function failGate(check, sink, reason, err = null) {
    enforceSourceTrailGate([syntheticFailureSink(sink, reason, err)], check, {});
}

/**
 * Enforce the D0 source_trail gate over the reconciliation sink rows. `check` is
 * verify-db's registrar (label, pass, detail) -> increments failures -> exit(1).
 * `meta.dictExpected` flags that the ui_related_mesh sink had scanned refs (so the
 * baked sidecar was REQUIRED for a trustworthy measurement). When `check` is a no-op
 * (unit tests call the WARN report directly) this is pure logging.
 */
export function enforceSourceTrailGate(sinks, check, meta = {}) {
    for (const s of sinks) {
        const sink = s.sink;
        // (2) Measurement-integrity FIRST: an untrustworthy measurement must not be
        // judged for coverage at all. Only the ui_related_mesh sink loads the sidecar;
        // dictExpected = reverse refs were actually scanned.
        if (sink === 'ui_related_mesh' && meta.dictExpected && (s.dictStatus || 'loaded') !== 'loaded') {
            check(
                `Trail: ${sink}`,
                false,
                `dict not loaded (${s.dictStatus}); reverse source_trail untrustworthy without baked sidecar`,
            );
            continue;
        }
        // (1) Reason-allowlist: any gap with a non-legal reason FAILS.
        const illegal = illegalReasons(s.gapByReason);
        if (illegal.length) {
            check(`Trail: ${sink}`, false, `illegal gap reasons ${JSON.stringify(illegal)} of ${s.gap} gap`);
            continue;
        }
        // (3) PASS: 100%/0-gap, or only allowlisted-reason gaps (logged, not failed).
        const detail = s.gap > 0
            ? `${s.pct}% cov, ${s.gap} gap (all legal-drop)`
            : `${s.pct}% cov, 0 gap`;
        check(`Trail: ${sink}`, true, detail);
    }
}
