/**
 * OP-GR-B core: cohort reconciliation + the governed record transform
 * (FINDING-GR-1, ruling D-2026-0810-418). PURE -- no R2, no filesystem, no
 * network. Every I/O decision lives in registry-renorm-cli.js.
 *
 * HONEST CONTRACT. This module reuses the PRODUCER's own semantics verbatim:
 * the projection comes from applyFieldContracts (field-contract-enforcer.js)
 * driven by FIELD_CONTRACTS (field-contracts.js), so the re-normalised stock is
 * byte-compatible with what the producer now emits. There is no second
 * implementation of the projection anywhere in this lane, and no bound is
 * declared here -- GIANT_MIN_BYTES is the producer's own PRODUCER_LINE_MAX_BYTES.
 */

import { PRODUCER_LINE_MAX_BYTES } from '../../ingestion/lib/field-contracts.js';
import { applyFieldContracts, createCounters } from '../../ingestion/lib/field-contract-enforcer.js';

/**
 * A record is "giant" at or above the producer's own emitted-line bound. Using
 * the producer constant rather than a fresh literal means the repaired stock and
 * the live producer can never disagree about what oversized means.
 */
export const GIANT_MIN_BYTES = PRODUCER_LINE_MAX_BYTES;

/**
 * The ONLY keys whose value may differ between the before and after image of a
 * governed record: the governed field itself plus the enforcer's five
 * disclosure stamps. Any other delta is a mismatch and abandons the operation.
 */
export const ALLOWED_DELTA_FIELDS = Object.freeze([
    'tags',
    'tags_original_count',
    'tags_kept_count',
    'tags_policy',
    'tags_truncated',
    'tags_projected',
]);
const ALLOWED = new Set(ALLOWED_DELTA_FIELDS);

/** Reconciliation outcomes. MISMATCH is always fail-closed (zero rewrite). */
export const RECONCILE = Object.freeze({ MATCH: 'MATCH', MISMATCH: 'MISMATCH' });

/**
 * The pipeline layer whose id spelling reconcile() matches.
 *
 * PR-GR-C: schema v1 embedded EXPORT-layer ids (kaggle-dataset--<tail>, as spelled
 * in merged_shard_*.json.zst) while the step scans the REGISTRY layer
 * (hf-dataset--<tail>, as minted by registry-manager.js). The two disagree by
 * construction, so the census could never match and run 31563250233 self-abandoned
 * on 274 missing / 274 extra with an exact tail bijection. The census must now
 * DECLARE its layer, and loading fails closed if that declaration is absent or
 * unrecognised -- a silent layer confusion is exactly what cost a cycle.
 */
export const CENSUS_LAYER = 'registry';

/** Load and validate the embedded census. Identity only -- ids, never content. */
export function loadCensus(doc) {
    const records = (doc && doc.records) || [];
    if (!Array.isArray(records) || records.length === 0) {
        throw new Error('OP_GR_B_CENSUS_EMPTY');
    }
    if (doc.matches_layer !== CENSUS_LAYER) {
        throw new Error(`OP_GR_B_CENSUS_LAYER_MISMATCH: matches_layer=${JSON.stringify(doc.matches_layer)} but reconcile matches the ${CENSUS_LAYER} layer`);
    }
    if (doc.count !== records.length) {
        throw new Error(`OP_GR_B_CENSUS_COUNT_DRIFT: header ${doc.count} vs ${records.length} rows`);
    }
    const byId = new Map();
    for (const r of records) {
        if (!r.id) throw new Error('OP_GR_B_CENSUS_ROW_WITHOUT_ID');
        if (byId.has(r.id)) throw new Error(`OP_GR_B_CENSUS_DUPLICATE_ID: ${r.id}`);
        byId.set(r.id, r);
    }
    return { ids: new Set(byId.keys()), byId, count: byId.size, forensicsSha256: doc.forensics_sha256 };
}

/**
 * Compute the field-level delta between a record's pre-image and its post-image.
 *
 * `before` is a SHALLOW key->value snapshot taken before the transform. The
 * enforcer REPLACES record.tags with a new array rather than mutating the old
 * one, so the pre-image reference survives and an unchanged field can be proven
 * by identity instead of by an unaffordable deep clone of a 311 MB array.
 */
export function fieldDelta(before, after) {
    const changed = [], added = [], removed = [];
    for (const k of Object.keys(after)) {
        if (!before.has(k)) { added.push(k); continue; }
        if (before.get(k) !== after[k]) changed.push(k);
    }
    for (const k of before.keys()) if (!(k in after)) removed.push(k);
    return { changed, added, removed };
}

/** True when every field touched by a transform is inside the allowed set. */
export function deltaIsGoverned(delta) {
    return delta.removed.length === 0
        && delta.changed.every((k) => ALLOWED.has(k))
        && delta.added.every((k) => ALLOWED.has(k));
}

/**
 * Apply the producer's field contracts to ONE record and report exactly what
 * moved. `text` is the record's stored JSON text; the returned `afterText` is
 * what will be written back.
 *
 * Returns `governed:false` (and NO afterText) when the transform would touch
 * anything beyond the governed field -- the caller must treat that as a
 * mismatch and abandon, never as a record to skip.
 */
export function transformRecord(text, counters = createCounters()) {
    const beforeBytes = Buffer.byteLength(text, 'utf8');
    const record = JSON.parse(text);
    const before = new Map(Object.entries(record));

    const result = applyFieldContracts(record, counters);
    const delta = fieldDelta(before, record);
    const governed = deltaIsGoverned(delta);

    const row = {
        id: record.id,
        source: record.source,
        type: record.type,
        before_bytes: beforeBytes,
        applied: result.applied,
        fields_changed: [...delta.changed, ...delta.added].sort(),
        fields_removed: delta.removed,
        governed,
    };
    if (!governed) return { governed: false, row, afterText: null };

    const afterText = JSON.stringify(record);
    row.after_bytes = Buffer.byteLength(afterText, 'utf8');
    row.bytes_reclaimed = beforeBytes - row.after_bytes;
    row.tags_original_count = record.tags_original_count;
    row.tags_kept_count = record.tags_kept_count;
    row.tags_policy = record.tags_policy;
    row.tags_truncated = record.tags_truncated === true;
    row.tags_projected = record.tags_projected || null;
    return { governed: true, row, afterText };
}

/**
 * Reconcile the giant cohort actually found in the loaded registry against the
 * census, one for one.
 *
 * MISMATCH on ANY of: an id in the census not found giant; a giant found that
 * the census does not name; a record whose transform would touch a field
 * outside the governed set. The caller MUST perform zero rewrites on MISMATCH.
 */
export function reconcile(found, census) {
    const foundIds = new Set(found.map((r) => r.id));
    const missing = [...census.ids].filter((id) => !foundIds.has(id)).sort();
    const extra = [...foundIds].filter((id) => !census.ids.has(id)).sort();
    const ungoverned = found.filter((r) => !r.governed).map((r) => ({
        id: r.id, fields_changed: r.fields_changed, fields_removed: r.fields_removed,
    }));
    const duplicates = found.length !== foundIds.size
        ? found.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i).sort()
        : [];

    const reasons = [];
    if (missing.length) reasons.push(`${missing.length} census id(s) not found giant in the loaded registry`);
    if (extra.length) reasons.push(`${extra.length} giant record(s) not named by the census`);
    if (ungoverned.length) reasons.push(`${ungoverned.length} record(s) would change a non-governed field`);
    if (duplicates.length) reasons.push(`${duplicates.length} duplicate id(s) among the giants`);

    return {
        status: reasons.length ? RECONCILE.MISMATCH : RECONCILE.MATCH,
        expected: census.count,
        observed: foundIds.size,
        missing, extra, ungoverned, duplicates, reasons,
    };
}

/** Per-record byte accounting totals for the dry-run manifest. */
export function accounting(rows) {
    const governed = rows.filter((r) => r.governed);
    const sum = (f) => governed.reduce((a, r) => a + (r[f] || 0), 0);
    return {
        records: rows.length,
        governed_records: governed.length,
        before_bytes_total: sum('before_bytes'),
        after_bytes_total: sum('after_bytes'),
        bytes_reclaimed_total: sum('bytes_reclaimed'),
        tag_elements_dropped_total: governed.reduce(
            (a, r) => a + ((r.tags_original_count || 0) - (r.tags_kept_count || 0)), 0),
        max_after_bytes: governed.reduce((a, r) => Math.max(a, r.after_bytes || 0), 0),
    };
}

/**
 * Post-transform verification predicate: no record in the rewritten cohort may
 * remain at or above the giant bound, and no shard's record count may move.
 */
export function verifyOutcome({ rows, shards }) {
    const stillGiant = rows.filter((r) => (r.after_bytes || 0) >= GIANT_MIN_BYTES)
        .map((r) => ({ id: r.id, after_bytes: r.after_bytes }));
    const countDrift = shards.filter((s) => s.entity_count_before !== s.entity_count_after)
        .map((s) => ({ shard: s.shard, before: s.entity_count_before, after: s.entity_count_after }));
    return {
        ok: stillGiant.length === 0 && countDrift.length === 0,
        giant_records_remaining: stillGiant,
        record_count_drift: countDrift,
        max_record_bytes_after: rows.reduce((a, r) => Math.max(a, r.after_bytes || 0), 0),
    };
}
