/**
 * PRODUCER EMISSION GUARD (FINDING-GR-1 / D-2026-0809-416 SS1 (a)).
 *
 * The ONE place where a normalised record becomes an NDJSON line. Two controls
 * live here, and they are deliberately DIFFERENT in kind:
 *
 *   QUARANTINE (a DATA disposition). A record whose serialised line would
 *   exceed the producer bound cannot be honestly repaired by field truncation
 *   -- its bulk sits outside every declared field contract, so truncating it
 *   would mean inventing a rule for content nobody declared. It is therefore
 *   NOT emitted, and its IDENTITY + typed reason + measured bytes are counted
 *   and recorded. Never dropped silently, never guessed at.
 *
 *   ASSERTION (a CODE invariant). Immediately before the write, the line's
 *   bytes are asserted against the same bound. Reaching it means a record got
 *   to the writer WITHOUT passing the screen -- a wiring/ordering defect, not a
 *   data condition -- so it throws a typed, named error and never skips
 *   silently. This is what turns the 2/4 consumer ceiling's headroom premise
 *   (ndjson-byte-reader.js MAX_RECORD_BYTES, which this path MUST NOT touch)
 *   into an enforced producer invariant rather than an assertion about data.
 *
 * The two controls are intentionally independent, exactly like the two gates
 * the ruling asks for: neither is allowed to be the other's only proof.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    PRODUCER_LINE_MAX_BYTES, LINE_TERMINATOR_BYTES, QUARANTINE_REASON,
    QUARANTINE_MANIFEST_MAX_ENTRIES, DISPOSITION,
} from './field-contracts.js';
import { getCounters, resetCounters } from './field-contract-enforcer.js';

// Re-exported so the harvester has ONE producer-bound import site.
export { getCounters, resetCounters };

/** Named error code. Grep-able in a GHA log; stable for consumers. */
export const PRODUCER_LINE_TERMINAL = 'PRODUCER_LINE_BYTES_LIMIT_EXCEEDED';

const STATE_DIR = path.join('data', 'state');
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** Typed failure for an emitted line that breaches the producer bound. */
export class ProducerLineBoundError extends Error {
    constructor(detail = {}) {
        super(`${PRODUCER_LINE_TERMINAL}: line ${detail.lineBytes} B > producer bound ${detail.maxBytes} B`
            + ` (source=${detail.source || 'unknown'} id=${detail.id || 'unknown'})`);
        this.name = 'ProducerLineBoundError';
        this.code = PRODUCER_LINE_TERMINAL;
        this.lineBytes = detail.lineBytes;
        this.maxBytes = detail.maxBytes;
        this.source = detail.source || null;
        this.id = detail.id || null;
    }
}

/**
 * PRODUCER-SIDE EMITTED-LINE ASSERTION. Loud typed failure, never a skip.
 * @param {string} line the exact NDJSON line, terminator included
 * @param {Object} [context] { source, id } for the terminal message
 * @param {number} [maxBytes] bound (from the contract table by default)
 * @returns {number} the measured line bytes
 */
export function assertEmittedLineBytes(line, context = {}, maxBytes = PRODUCER_LINE_MAX_BYTES) {
    const lineBytes = byteLen(line);
    if (lineBytes > maxBytes) {
        throw new ProducerLineBoundError({ lineBytes, maxBytes, source: context.source, id: context.id });
    }
    return lineBytes;
}

/**
 * Quarantine screen on the serialised record.
 * @returns {string|null} typed reason, or null when the record may be emitted
 */
export function screenRecordBytes(recordBytes, maxBytes = PRODUCER_LINE_MAX_BYTES) {
    if (recordBytes + LINE_TERMINATOR_BYTES > maxBytes) {
        return QUARANTINE_REASON.RECORD_BYTES_OVER_PRODUCER_BOUND;
    }
    return null;
}

/**
 * Resolve the effective bounds. Both default to the contract table's single
 * wall, so production behaviour is the table's value and nothing else; the
 * split exists only so a test can drive screen and assertion independently.
 * @param {{screenMaxBytes?: number, lineMaxBytes?: number}} [bounds]
 * @returns {{lineMaxBytes: number, screenMaxBytes: number}}
 */
export function resolveBounds(bounds = {}) {
    const lineMaxBytes = bounds.lineMaxBytes ?? PRODUCER_LINE_MAX_BYTES;
    return { lineMaxBytes, screenMaxBytes: bounds.screenMaxBytes ?? lineMaxBytes };
}

/**
 * The DISTINCT breach marker (D3). It is NOT an adapter error and NOT a
 * quarantine: it is a producer-emission invariant breach, and harvest health
 * must be able to tell the three apart.
 */
export function recordBreach(record, error) {
    return {
        code: error.code,
        id: (record && record.id) || null,
        source: (record && record.source) || null,
        line_bytes: error.lineBytes,
        max_bytes: error.maxBytes,
    };
}

/** Record a quarantine: count it, disclose it loudly, keep a bounded identity. */
export function quarantineRecord(record, measuredBytes, reason, state = getCounters()) {
    state.records_quarantined += 1;
    const entry = {
        id: record && record.id ? String(record.id) : null,
        source: record && record.source ? String(record.source) : null,
        type: record && record.type ? String(record.type) : null,
        reason,
        measured_bytes: measuredBytes,
    };
    if (state.quarantine.length < QUARANTINE_MANIFEST_MAX_ENTRIES) state.quarantine.push(entry);
    console.error(`::error::PRODUCER_QUARANTINE ${JSON.stringify(entry)}`);
    return entry;
}

/**
 * Serialise ONE normalised record and emit it, or quarantine it.
 *
 * `bounds` exists so the screen and the assertion can be driven INDEPENDENTLY
 * by a test. In production both default to the contract table's single wall, so
 * the screen normally catches an over-bound record first and the assertion is
 * the invariant behind it; separating them lets a test push a record through
 * the REAL emit path -- screen intact -- and prove the assertion still fires.
 *
 * @param {Object} record
 * @param {Object} writeStream
 * @param {Object} [state] counters to charge
 * @param {{screenMaxBytes?: number, lineMaxBytes?: number}} [bounds]
 * @returns {Promise<{emitted: boolean, disposition: string, bytes: number}>}
 */
export async function emitNormalizedRecord(record, writeStream, state = getCounters(), bounds = {}) {
    const { lineMaxBytes, screenMaxBytes } = resolveBounds(bounds);
    const serialized = JSON.stringify(record);
    const bytes = byteLen(serialized);

    const reason = screenRecordBytes(bytes, screenMaxBytes);
    if (reason) {
        quarantineRecord(record, bytes, reason, state);
        return { emitted: false, disposition: DISPOSITION.QUARANTINE, bytes };
    }

    const line = serialized + '\n';
    // D1 (adapter-agnostic escalation). Throwing is NOT enough: every live adapter
    // wraps `await onBatch(...)` in a catch-all that logs, breaks and returns []
    // cleanly, so a rethrow from the harvester dies inside the adapter and the run
    // takes the SUCCESS path as a green valid_zero. RECORD the breach on the shared
    // state FIRST, so the harvester can promote it after fetch() returns no matter
    // what any adapter's catch did with the exception.
    try {
        assertEmittedLineBytes(line, { source: record && record.source, id: record && record.id }, lineMaxBytes);
    } catch (e) {
        state.producer_line_breach = recordBreach(record, e);
        throw e;
    }
    if (!writeStream.write(line)) {
        await new Promise((resolve) => writeStream.once('drain', resolve));
    }
    return { emitted: true, disposition: DISPOSITION.EMIT, bytes };
}

/** Machine-readable counters for the terminal-state sidecar / harvest health. */
export function producerBoundSummary(state = getCounters()) {
    return {
        schema_version: state.schema_version,
        records_contract_examined: state.records_contract_examined,
        records_field_truncated: state.records_field_truncated,
        records_field_projected: state.records_field_projected,
        fields_truncated: state.fields_truncated,
        elements_dropped: state.elements_dropped,
        records_quarantined: state.records_quarantined,
        quarantine_identities_recorded: state.quarantine.length,
        producer_line_max_bytes: PRODUCER_LINE_MAX_BYTES,
        // D3: distinct from an adapter error and from a quarantine. null = no breach.
        producer_line_breach: state.producer_line_breach || null,
    };
}

/**
 * Persist the bounded identity-only quarantine manifest. Payload is NEVER
 * written (a 311 MB record would be re-created on disk to describe itself).
 * A write failure degrades to a warning: the COUNT still travels in the
 * sidecar, so a quarantine can never become invisible because of an IO error.
 */
export function writeQuarantineManifest(source, state = getCounters(), dir = STATE_DIR) {
    if (state.records_quarantined === 0) return null;
    const safe = String(source || 'unknown').replace(/[^a-z0-9_-]+/gi, '_');
    const file = path.join(dir, `harvest-quarantine-${safe}.json`);
    const doc = {
        schema_version: state.schema_version,
        source,
        quarantined: state.records_quarantined,
        identities_recorded: state.quarantine.length,
        identities_cap: QUARANTINE_MANIFEST_MAX_ENTRIES,
        records: state.quarantine,
    };
    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(doc, null, 2));
        return file;
    } catch (e) {
        console.warn(`::warning::producer-quarantine manifest write failed for ${source}: ${e.message}`);
        return null;
    }
}
