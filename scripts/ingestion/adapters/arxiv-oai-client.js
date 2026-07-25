/**
 * ArXiv OAI Transport + Envelope Parser (WO-3-A1 PR-A1: Transport Recovery Core)
 *
 * Owns ONLY transport (timed fetch) and OAI envelope parsing/error detection for
 * the ListRecords pagination. It does NOT own retry/budget state (that is the
 * single arbiter in arxiv-recovery-state.js) and does NOT touch normalize(),
 * ar5iv enrichment, or relation derivation.
 *
 * PAGE ATOMICITY: the caller's contract is
 *   fetch complete response -> parse complete XML -> REJECT OAI <error> envelope
 *   -> validate record set + next token -> (caller) compute progress -> accept
 *   -> advance token.
 * This module performs the fetch+parse+envelope-reject+extract steps and returns
 * a single immutable page result; it never commits partial records.
 *
 * OAI ERROR ENVELOPE (parsed BEFORE records / next-token / clean-end): an OAI
 * <error code="..."> is detected by ENVELOPE, never by HTTP status -- arXiv
 * returns HTTP 200 for badResumptionToken. An error on a resumption-token
 * request is NEVER a clean end.
 *
 * @module ingestion/adapters/arxiv-oai-client
 */

import { parseStringPromise } from 'xml2js';
import { readBodyWithinDeadline } from './arxiv-response-deadline.js';
// Record-level helpers live in their own module (CES ceiling); re-exported so
// every existing import of these names from this module keeps working.
import { pageFingerprint, countRawNewIds, mapOaiRecords } from './arxiv-oai-records.js';
export { pageFingerprint, countRawNewIds, mapOaiRecords };

export const ARXIV_OAI_BASE = 'https://oaipmh.arxiv.org/oai';

// OAI error codes -> our terminal taxonomy. badResumptionToken is the headline
// silent-failure mode (HTTP 200 body carrying an error envelope).
export const OAI_ERROR_MAP = {
    badResumptionToken: 'BAD_RESUMPTION_TOKEN',
    badArgument: 'OAI_ERROR',
    badVerb: 'OAI_ERROR',
    cannotDisseminateFormat: 'OAI_ERROR',
    idDoesNotExist: 'OAI_ERROR',
    noMetadataFormats: 'OAI_ERROR',
    noSetHierarchy: 'OAI_ERROR',
    // noRecordsMatch is handled specially by the caller (clean-zero ONLY for an
    // initial no-token request with zero accepted so far; otherwise fail-loud).
    noRecordsMatch: 'NO_RECORDS_MATCH',
};

/** Build the ListRecords URL for the first page or a resumption page. */
export function buildListRecordsUrl(resumptionToken, from) {
    let url = `${ARXIV_OAI_BASE}?verb=ListRecords`;
    if (resumptionToken) {
        url += `&resumptionToken=${encodeURIComponent(resumptionToken)}`;
    } else {
        url += '&metadataPrefix=arXiv&set=cs';
        if (from) url += `&from=${from}`;
    }
    return url;
}

/**
 * Inspect a parsed OAI document for an <error code="..."> envelope.
 * @returns {{code:string, text:string}|null}
 */
export function detectOaiError(parsed) {
    const err = parsed?.['OAI-PMH']?.error;
    if (!err) return null;
    const first = Array.isArray(err) ? err[0] : err;
    const code = (typeof first === 'object' && first?.$?.code) || 'unknown';
    const text = (typeof first === 'object' ? first._ : first) || '';
    return { code: String(code), text: String(text).trim() };
}

/**
 * Extract the ListRecords node, its records, and the next resumptionToken from a
 * parsed (error-free) OAI document.
 *
 * BLOCKER B -- STRUCTURAL DISTINCTION. `listRecordsPresent` reports whether the
 * <ListRecords> node EXISTS at all, independent of <record> count. The caller
 * MUST consult it before treating an empty batch as a clean end: PRESENT + zero
 * records + no token -> legal empty page; ABSENT (node missing) -> structural
 * error (MALFORMED_XML on initial; ALWAYS fail-loud on a tokened request). A
 * parseable 200 with no <error> and no ListRecords node is NOT a clean end.
 */
export function extractListRecords(parsed) {
    const root = parsed?.['OAI-PMH'];
    // PRESENCE keyed on the <ListRecords> NODE existing, NOT on it being truthy:
    // xml2js renders <ListRecords></ListRecords> as [''] (a LEGAL empty page).
    if (!root || !Object.prototype.hasOwnProperty.call(root, 'ListRecords')) {
        return { listRecordsPresent: false, listRecords: null, records: [], nextToken: null };
    }
    const lr = root.ListRecords?.[0];
    const node = lr && typeof lr === 'object' ? lr : {};
    const rawToken = node.resumptionToken?.[0];
    const nextToken = (rawToken && (rawToken._ || rawToken)) || null;
    return { listRecordsPresent: true, listRecords: node, records: node.record || [], nextToken: nextToken || null };
}

/** Read Retry-After (BLOCKER C) into ms: integer-seconds or HTTP-date; null if absent. */
export function parseRetryAfterMs(response) {
    const raw = response?.headers?.get?.('retry-after');
    if (!raw) return null;
    const seconds = parseInt(raw, 10);
    if (!isNaN(seconds) && String(seconds) === String(raw).trim()) return seconds * 1000;
    const dateMs = new Date(raw).getTime() - Date.now();
    return isNaN(dateMs) ? null : Math.max(0, dateMs);
}

/**
 * Outcome kinds returned by fetchOaiPage (transport-level, before record mapping):
 *   - kind 'page'   : a fully-parsed, error-free page (records + nextToken).
 *   - kind 'http'   : a non-ok HTTP status (caller decides retry vs terminate).
 *   - kind 'oai'    : an OAI <error> envelope (caller maps to terminal).
 *   - kind 'parse'  : XML parse failure (MALFORMED_XML / FetchError parse).
 *   - kind 'fetch'  : transport throw (AbortError -> abort; else fetch error).
 *
 * This function NEVER retries and NEVER sleeps -- the single-arbiter budget owns
 * that. It performs exactly one timed request + parse + envelope check.
 *
 * @param {Object} args
 * @param {Function} args.fetchWithTimeout - bound BaseAdapter.fetchWithTimeout seam.
 * @param {string} args.url - the ListRecords URL.
 * @param {number} args.timeoutMs - budget for THIS request (from the state machine).
 * @param {Object} args.headers - request headers.
 */
export async function fetchOaiPage({ fetchWithTimeout, url, timeoutMs, headers, timers, now = Date.now }) {
    // NBF-4: ONE deadline per attempt = start + timeoutMs, covering request + headers
    // + COMPLETE body consumption. fetchWithTimeout's own abort window ends at
    // headers, so the body gets exactly the REMAINING part of the same N -- never a
    // second full budget (that would turn 120000 into 240000).
    const startedAt = now();
    let response;
    try {
        response = await fetchWithTimeout(url, { headers }, timeoutMs);
    } catch (error) {
        const kind = error?.name === 'AbortError' ? 'abort' : 'fetch';
        return { kind: 'fetch', errorKind: kind, error };
    }

    if (!response.ok) {
        return { kind: 'http', status: response.status, response };
    }

    const body = await readBodyWithinDeadline({ response, remainingMs: timeoutMs - (now() - startedAt), timers });
    // A body deadline breach is a TIMEOUT (errorKind 'abort'), not a parse failure:
    // it routes through the single arbiter exactly like a header-phase abort.
    if (!body.ok) return { kind: 'fetch', errorKind: body.errorKind, error: body.error };
    let parsed;
    try {
        parsed = await parseStringPromise(body.text);
    } catch (error) {
        return { kind: 'parse', error };
    }

    // Envelope FIRST -- before records / next-token / clean-end.
    const oaiError = detectOaiError(parsed);
    if (oaiError) {
        return { kind: 'oai', oaiError };
    }

    const { listRecordsPresent, records, nextToken } = extractListRecords(parsed);
    // BLOCKER B: carry the structural presence signal so the caller can reject a
    // tokened response missing <ListRecords> (never COMPLETE) and classify an
    // initial missing-node as MALFORMED_XML rather than a silent empty page.
    return { kind: 'page', listRecordsPresent, records, nextToken };
}

/**
 * Map an OAI <error> envelope to a terminal state. An OAI error on a
 * resumption-token request is NEVER a clean end. noRecordsMatch is clean-zero
 * (COMPLETE) ONLY for an initial (no-token) request with zero accepted so far;
 * on a resumption request, or after records accepted, it is fail-loud. UNKNOWN
 * codes fail closed (OAI_ERROR).
 *
 * @returns {('BAD_RESUMPTION_TOKEN'|'OAI_ERROR'|'COMPLETE')}
 */
export function classifyOaiError(oaiError, resumptionToken, acceptedSoFar) {
    const code = oaiError.code;
    if (code === 'badResumptionToken') return 'BAD_RESUMPTION_TOKEN';
    if (code === 'noRecordsMatch') {
        if (!resumptionToken && acceptedSoFar === 0) return 'COMPLETE';
        return 'OAI_ERROR';
    }
    return 'OAI_ERROR'; // badArgument/badVerb/... and any UNKNOWN -> fail-closed.
}

export default {
    fetchOaiPage,
    buildListRecordsUrl,
    detectOaiError,
    extractListRecords,
    pageFingerprint,
    countRawNewIds,
    parseRetryAfterMs,
    mapOaiRecords,
    classifyOaiError,
};
