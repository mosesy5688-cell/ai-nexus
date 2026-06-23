/**
 * W3-O1 (Founder D-88/D-89/D-90) Master-Fusion parse-attrition wiring.
 *
 * Master-fusion.js is at the CES 250-line ceiling, so the per-shard collection,
 * the NXVF_PARSE_DROP emission, and the final canary enforcement live here. This
 * is a PURE SIDE-CHANNEL: it reads the parseAccounting attached to each fuse
 * result and emits GHA log lines + a machine-readable aggregate. It never
 * touches the fused entity output, the codec, or the >=90% floor.
 */

import {
    newCanaryAggregate, foldShard, finalizeCanary, dropLogLine,
} from './fusion-parse-canary.js';

/** Create the per-run accumulator. */
export function newParseAccounting() {
    return newCanaryAggregate();
}

/**
 * Fold one fuse result's parseAccounting into the aggregate and emit one
 * machine-readable NXVF_PARSE_DROP line per drop record. `acc` is the camelCase
 * `result.parseAccounting` from fuseShardFFI (or null/undefined on JS fallback).
 */
export function collectShardAccounting(agg, acc, log = console.log) {
    foldShard(agg, acc);
    const records = acc && Array.isArray(acc.dropRecords) ? acc.dropRecords : [];
    for (const rec of records) log(dropLogLine(rec));
}

/**
 * Finalize the canary. Emits the single aggregate summary line
 * (NXVF_PARSE_ACCOUNTING {json}). If the verdict is the blocking
 * EXPECTED_BUT_MISSING/FAIL case, THROWS (fail-closed) — the caller surfaces it
 * the same way as any other fusion integrity failure. PRESENT_VALID/DEGRADED and
 * NOT_ACTIVE_OR_NOT_APPLICABLE never throw. The >=90% floor is untouched either
 * way.
 *
 * @param {object} cap raw `parseAccountingCapability()` surface.
 * @param {object} agg the folded aggregate.
 * @param {number} expectedShardCount Master Fusion's intended shard count.
 * @param {function} log
 * @returns {object} the machine-readable summary (also returned for tests).
 */
export function finalizeParseAccounting(cap, agg, expectedShardCount, log = console.log) {
    const summary = finalizeCanary(cap, agg, expectedShardCount);
    log(`NXVF_PARSE_ACCOUNTING ${JSON.stringify(summary)}`);
    log(
        `[FUSION][W3-O1] parse-attrition: ${summary.accounting_status} ` +
        `(reason=${summary.reason}, protocol=${summary.protocol_version}, ` +
        `engine=${summary.engine_mode}, shards=${summary.processed_shards}/${summary.expected_shards}, ` +
        `declared=${summary.declared_entity_count}, parsed=${summary.parsed_entity_count}, ` +
        `dropped=${summary.dropped_entity_count}, ` +
        `drop_detail_records_seen=${summary.drop_detail_records_seen})`
    );
    if (summary.blocking) {
        const err = new Error(
            `[FUSION][W3-O1] PARSE_ACCOUNTING_FAIL: ${summary.state}/${summary.reason} — ` +
            `dropped=${summary.dropped_entity_count}, records_seen=${summary.drop_detail_records_seen}, ` +
            `declared=${summary.declared_entity_count}, parsed=${summary.parsed_entity_count}`
        );
        err.w3o1ParseAccounting = summary;
        throw err;
    }
    return summary;
}
