/**
 * PRODUCER-SIDE FIELD CONTRACTS (FINDING-GR-1 / D-2026-0809-416 SS1 wrapper (c)).
 *
 * DECLARATIVE table. It is the SOLE input to the enforcement point
 * (field-contract-enforcer.js). No bound may be written anywhere else: a magic
 * number in an adapter or in the harvester is, by construction, a bound nobody
 * can audit. Same shape as content-policy.js (single-sourced, type-aware,
 * applied at every cut point) but for LIST-valued fields and for the record as
 * a whole.
 *
 * WHY IT EXISTS
 * The Kaggle adapter passed `dataset.tags` through unbounded. Kaggle returns a
 * raw Swagger Tag-DTO array (14 keys per element: ref/name/nameNullable/hasName/
 * description/hasDescription/descriptionNullable/fullPath/fullPathNullable/
 * hasFullPath/competitionCount/datasetCount/scriptCount/totalCount). Observed:
 * 150,400 to 506,245 elements on a SINGLE dataset entity, up to 311,223,937
 * bytes in one field, 274 records at or above 32 MiB, 40.3% of the whole
 * decompressed corpus. The 4/4 packer keeps only `tr(tags, 500)` -- a 500-char
 * column -- so the payload is provably unread.
 *
 * ------------------------------------------------------------------------
 * DERIVATION OF EVERY NUMBER IN THIS FILE (forensics v1, sha256 16c97d7e...)
 * ------------------------------------------------------------------------
 * TAGS_MAX_ELEMENTS = 64
 *   Forensics SS1.4: "a real Kaggle dataset carries on the order of 5-10 tags".
 *   64 is 6.4x that legitimate upper end and 1/7,910 of the observed maximum
 *   cardinality (506,245). It cannot clip a conforming entity.
 * TAGS_MAX_ELEMENT_BYTES = 128
 *   A PROJECTED element is one tag name/ref (a Kaggle slug, tens of bytes).
 *   The observed 291-829 B per element is the whole 14-key DTO, not the name.
 * TAGS_MAX_BYTES = 8192  (a PROJECTION BUDGET, not a serialised-form cap)
 *   = TAGS_MAX_ELEMENTS * TAGS_MAX_ELEMENT_BYTES, i.e. the cardinality cap
 *   valued at the per-element cap. Also 4x content-policy README_EXCERPT_MAX
 *   (2048) and 1/37,993 of the observed maximum tags value (311,223,937 B).
 *   HONEST STATEMENT OF WHAT IT BOUNDS: the enforcer charges each kept element
 *   its UTF-8 name bytes plus the two JSON quote characters, and stops when the
 *   running total would exceed this budget. It does NOT charge the separating
 *   commas, the two array brackets, or JSON string ESCAPING. The serialised
 *   `tags` array is therefore slightly larger than the budget in the ordinary
 *   case (commas + brackets: at most maxElements + 1 further bytes) and, in the
 *   adversarial worst case where every kept byte needs a \uXXXX escape (6 bytes
 *   emitted per source byte), up to ~6x the budget, i.e. ~49 KB. Both are
 *   irrelevant against the defect being closed (311 MB) and against the record
 *   bound below, which measures the REAL serialised line; but the budget must
 *   not be described as a byte cap on the stored form, because it is not one.
 * PRODUCER_LINE_MAX_BYTES = 32 MiB
 *   Derived from a COMPLETE census (forensics SS3.1/SS3.2: all 647,896 records
 *   of all 20 shards measured, not a budgeted prefix scan). EVERY record at or
 *   above 32 MiB -- all 274 of them -- is source=kaggle, type=dataset, with
 *   99.99%+ of its bytes in `tags`. ZERO record from any other source reaches
 *   32 MiB. So once `tags` is projected, no observed conforming record touches
 *   this bound; it cannot false-fail on measured data. Headroom below the 2/4
 *   consumer ceiling (ndjson-byte-reader.js MAX_RECORD_BYTES = 64 MiB, which
 *   this file MUST NOT change) is 2x = 32 MiB of absolute slack for factory
 *   enrichment added between harvest emission and shard consumption. Forensics
 *   SS1.3 measured that slack requirement: in a 64-field giant every non-tags
 *   top-level field is <= 251 bytes, so enrichment growth is kilobytes.
 * QUARANTINE_MANIFEST_MAX_ENTRIES = 50
 *   The quarantine manifest records IDENTITY + reason, never payload. 50 keeps
 *   the manifest bounded; the TOTAL count is always reported exactly, so a
 *   manifest that hits the cap still discloses how many were quarantined.
 */

const MiB = 1024 * 1024;

/**
 * The 2/4 consumer ceiling, reproduced here for DERIVATION ONLY. It is owned by
 * scripts/factory/lib/ndjson-byte-reader.js (MAX_RECORD_BYTES) and is NOT
 * enforced, read or altered by this producer path. It exists in this file so
 * the headroom assertion below is checkable, and so a future edit that raises
 * the producer bound above it fails a test instead of passing review.
 */
export const CONSUMER_RECORD_CEILING_BYTES = 64 * MiB;

/** Hard producer invariant on ONE emitted NDJSON line (record bytes + LF). */
export const PRODUCER_LINE_MAX_BYTES = 32 * MiB;

/** The single LF that terminates every emitted NDJSON line. */
export const LINE_TERMINATOR_BYTES = 1;

/** Bounded identity-only quarantine manifest size (payload is NEVER stored). */
export const QUARANTINE_MANIFEST_MAX_ENTRIES = 50;

/** Per-field disposition vocabulary. */
export const DISPOSITION = Object.freeze({
    EMIT: 'emit',
    TRUNCATE: 'truncate',
    QUARANTINE: 'quarantine',
});

/** Typed quarantine reasons. Every quarantined record carries exactly one. */
export const QUARANTINE_REASON = Object.freeze({
    RECORD_BYTES_OVER_PRODUCER_BOUND: 'RECORD_BYTES_OVER_PRODUCER_BOUND',
});

/** Named projections. A projection is a LOSSY, DISCLOSED field rewrite. */
export const PROJECTION = Object.freeze({
    KAGGLE_TAG_DTO_NAME: 'kaggle-tag-dto-name/1',
});

const TAGS_MAX_ELEMENTS = 64;
const TAGS_MAX_ELEMENT_BYTES = 128;
const TAGS_MAX_BYTES = TAGS_MAX_ELEMENTS * TAGS_MAX_ELEMENT_BYTES;

/**
 * Kaggle `tags` contract. `projection` collapses the Swagger Tag-DTO object to
 * the one thing every downstream consumer of `tags` actually reads: the tag
 * NAME string. `nameKeys` is the ordered preference list used to find it.
 */
const KAGGLE_TAGS = Object.freeze({
    kind: 'list',
    projection: PROJECTION.KAGGLE_TAG_DTO_NAME,
    nameKeys: Object.freeze(['name', 'ref', 'fullPath']),
    maxElements: TAGS_MAX_ELEMENTS,
    maxElementBytes: TAGS_MAX_ELEMENT_BYTES,
    maxBytes: TAGS_MAX_BYTES,
    onExceed: DISPOSITION.TRUNCATE,
    policy: 'kaggle/tags/list-cap/1',
});

/**
 * THE TABLE. Keyed `<source>:<type>` so the rule is TYPE-AWARE, exactly like
 * content-policy.js. A source/type with no entry is governed by the
 * record-level producer bound only -- never by an invented per-field default,
 * because a bound nobody declared is a bound nobody can defend.
 */
export const FIELD_CONTRACTS = Object.freeze({
    'kaggle:dataset': Object.freeze({ tags: KAGGLE_TAGS }),
    'kaggle:model': Object.freeze({ tags: KAGGLE_TAGS }),
});

/** Table key for a record. */
export function contractKey(source, type) {
    return `${source || ''}:${type || ''}`;
}

/**
 * Field contracts governing one record, or null when the source/type is not
 * under contract.
 * @param {string} source
 * @param {string} type
 * @param {Object} [table] injectable table (tests pin the table as sole input)
 * @returns {Object|null}
 */
export function fieldContractsFor(source, type, table = FIELD_CONTRACTS) {
    return table[contractKey(source, type)] || null;
}
