/**
 * FIELD-CONTRACT ENFORCEMENT POINT (FINDING-GR-1 / D-2026-0809-416 SS1 (a)).
 *
 * Applied at the ADAPTER NORMALISATION BOUNDARY -- inside the adapter, on the
 * normalised entity, BEFORE content_hash is computed -- so an over-cap array
 * never enters a batch file and the stored hash describes the STORED content.
 *
 * HONEST CONTRACT. A silently shortened list is a lie about completeness, so
 * every action this module takes is:
 *   1. counted   (module counters, published in harvest health), and
 *   2. stamped   (the record itself carries `<field>_truncated`,
 *                 `<field>_original_count`, `<field>_kept_count`,
 *                 `<field>_projected`, `<field>_policy`).
 * A conforming record is left byte-identical and carries NO disclosure fields:
 * nothing happened, so nothing is claimed.
 *
 * EVERY bound comes from field-contracts.js. This file contains no bound.
 *
 * P1: the projection walks the array ONCE and never serialises it. Peak extra
 * memory is the bounded output (<= maxBytes), not the input.
 */

import { DISPOSITION, fieldContractsFor, FIELD_CONTRACTS } from './field-contracts.js';

const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** JSON overhead of one string element inside an array: the two quote chars. */
const QUOTE_BYTES = 2;

/** Fresh, zeroed producer-bound counters. */
export function createCounters() {
    return {
        schema_version: 1,
        records_contract_examined: 0,
        records_field_truncated: 0,
        records_field_projected: 0,
        fields_truncated: 0,
        elements_dropped: 0,
        records_quarantined: 0,
        quarantine: [],
        // D1/D3: set by the emitter when the emitted-line assertion fires.
        producer_line_breach: null,
    };
}

let counters = createCounters();

/** The process-wide counters (adapter + emitter share ONE tally). */
export function getCounters() {
    return counters;
}

/** Reset the process-wide counters (tests, and one harvest run per process). */
export function resetCounters() {
    counters = createCounters();
    return counters;
}

/** Byte-safe right clamp: drop whole characters until the UTF-8 size fits. */
function clampBytes(str, maxBytes) {
    let out = str;
    while (out.length > 0 && byteLen(out) > maxBytes) out = out.slice(0, -1);
    return out;
}

/**
 * Resolve one list element to its tag NAME string.
 * A plain string is already the projected form. An object is a third-party DTO:
 * take the first declared name key that carries a non-empty string. Anything
 * else is unusable and is dropped (counted as a drop, never silently).
 */
function elementName(element, contract) {
    if (typeof element === 'string') return element.trim() || null;
    if (!element || typeof element !== 'object') return null;
    for (const key of contract.nameKeys || []) {
        const v = element[key];
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
}

/**
 * Project + bound one list-valued field.
 * @returns {{kept: string[], original: number, projected: boolean, truncated: boolean}}
 */
export function projectListField(value, contract) {
    const original = value.length;
    const kept = [];
    let usedBytes = 0;
    let projected = false;

    for (const element of value) {
        if (kept.length >= contract.maxElements) break;
        const name = elementName(element, contract);
        if (name === null) continue;
        if (typeof element !== 'string') projected = true;
        const bounded = clampBytes(name, contract.maxElementBytes);
        if (bounded !== name) projected = true;
        const cost = byteLen(bounded) + QUOTE_BYTES;
        if (usedBytes + cost > contract.maxBytes) break;
        usedBytes += cost;
        kept.push(bounded);
    }

    return { kept, original, projected, truncated: kept.length < original };
}

/** Stamp the honest disclosure for one governed field. */
function discloseField(record, field, contract, result) {
    record[`${field}_original_count`] = result.original;
    record[`${field}_kept_count`] = result.kept.length;
    record[`${field}_policy`] = contract.policy;
    if (result.truncated) record[`${field}_truncated`] = true;
    if (result.projected) record[`${field}_projected`] = contract.projection;
}

/**
 * Apply every field contract that governs this record, IN PLACE.
 *
 * Idempotent: a record that already conforms is not touched and gains no
 * disclosure field, so re-running the enforcer can never inflate the counters
 * or re-stamp a record.
 *
 * @param {Object} record normalised entity (mutated in place)
 * @param {Object} [state] counters to charge (defaults to the shared tally)
 * @param {Object} [table] contract table (injectable -- it is the SOLE input)
 * @returns {{applied: string[], disposition: string}}
 */
export function applyFieldContracts(record, state = counters, table = FIELD_CONTRACTS) {
    const applied = [];
    if (!record || typeof record !== 'object') {
        return { applied, disposition: DISPOSITION.EMIT };
    }

    state.records_contract_examined += 1;
    const contracts = fieldContractsFor(record.source, record.type, table);
    if (!contracts) return { applied, disposition: DISPOSITION.EMIT };

    let truncatedAny = false;
    let projectedAny = false;

    for (const [field, contract] of Object.entries(contracts)) {
        const value = record[field];
        if (!Array.isArray(value)) continue;
        const result = projectListField(value, contract);
        if (!result.truncated && !result.projected) continue;

        record[field] = result.kept;
        discloseField(record, field, contract, result);
        applied.push(field);
        state.elements_dropped += result.original - result.kept.length;
        if (result.truncated) {
            state.fields_truncated += 1;
            truncatedAny = true;
        }
        if (result.projected) projectedAny = true;
    }

    if (truncatedAny) state.records_field_truncated += 1;
    if (projectedAny) state.records_field_projected += 1;

    return { applied, disposition: DISPOSITION.EMIT };
}
