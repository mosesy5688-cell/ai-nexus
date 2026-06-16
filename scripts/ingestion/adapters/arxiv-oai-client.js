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
 * parsed (error-free) OAI document. Returns null listRecords for a structurally
 * empty response (HTTP 200, valid XML, no ListRecords) so the caller can treat a
 * genuinely-empty initial response as clean-zero.
 */
export function extractListRecords(parsed) {
    const listRecords = parsed?.['OAI-PMH']?.ListRecords?.[0];
    if (!listRecords) return { listRecords: null, records: [], nextToken: null };
    const records = listRecords.record || [];
    const rawToken = listRecords.resumptionToken?.[0];
    const nextToken = (rawToken && (rawToken._ || rawToken)) || null;
    return { listRecords, records, nextToken: nextToken || null };
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
export async function fetchOaiPage({ fetchWithTimeout, url, timeoutMs, headers }) {
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

    let xmlText;
    let parsed;
    try {
        xmlText = await response.text();
        parsed = await parseStringPromise(xmlText);
    } catch (error) {
        return { kind: 'parse', error };
    }

    // Envelope FIRST -- before records / next-token / clean-end.
    const oaiError = detectOaiError(parsed);
    if (oaiError) {
        return { kind: 'oai', oaiError };
    }

    const { listRecords, records, nextToken } = extractListRecords(parsed);
    return { kind: 'page', listRecords, records, nextToken };
}

/**
 * Map OAI <record> nodes to internal paper objects, deduped via seenIds and
 * filtered to the target categories. Page-atomic: the caller invokes this only
 * on a fully-valid page (after envelope rejection + token validation). Does NOT
 * touch normalize() / ar5iv enrichment / relation derivation (PR-A2 scope).
 *
 * @param {Object[]} records - OAI <record> nodes from a parsed page.
 * @param {Set<string>} seenIds - cross-page dedup set (mutated: new ids added).
 * @param {string[]} targetCategories - AI/ML categories to retain.
 */
export function mapOaiRecords(records, seenIds, targetCategories) {
    const batch = [];
    for (const record of records) {
        const metadata = record.metadata?.[0]?.['arXiv']?.[0];
        if (!metadata) continue;
        const arxivId = metadata.id?.[0];
        if (!arxivId || seenIds.has(arxivId)) continue;
        const categories = (metadata.categories?.[0] || '').split(' ');
        if (!targetCategories.some((cat) => categories.includes(cat))) continue;
        seenIds.add(arxivId);
        batch.push({
            arxiv_id: arxivId,
            title: metadata.title?.[0]?.replace(/\n/g, ' ').trim(),
            summary: metadata.abstract?.[0]?.replace(/\n/g, ' ').trim(),
            authors: metadata.authors?.[0]?.author?.map((a) => `${a.forenames?.[0] || ''} ${a.keyname?.[0] || ''}`.trim()) || [],
            published: record.header?.[0]?.datestamp?.[0],
            updated: record.header?.[0]?.datestamp?.[0],
            categories,
            doi: metadata.doi?.[0],
            license: metadata.license?.[0],
        });
    }
    return batch;
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
    mapOaiRecords,
    classifyOaiError,
};
