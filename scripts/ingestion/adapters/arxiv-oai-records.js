/**
 * ArXiv OAI RECORD-LEVEL helpers: raw-page fingerprinting, raw-new-id counting and
 * <record> -> internal paper mapping. Extracted verbatim from arxiv-oai-client.js
 * (NBF-4) purely to keep that module under the CES 250-line ceiling once the
 * full-response deadline landed. No behaviour change; arxiv-oai-client re-exports
 * all three so every existing import path still resolves.
 *
 * @module ingestion/adapters/arxiv-oai-records
 */

/**
 * Order-independent fingerprint of a page's RAW record-id set (BLOCKER D raw-
 * progress / replayed-page detection). Short non-reversible hash, NOT a
 * governance id; falls back to a length+token marker when ids are absent.
 */
export function pageFingerprint(records, nextToken) {
    const ids = [];
    for (const record of records || []) {
        const id = record?.metadata?.[0]?.['arXiv']?.[0]?.id?.[0];
        if (id) ids.push(String(id));
    }
    const basis = ids.length ? ids.slice().sort().join('|') : `empty:${(records || []).length}:${nextToken || ''}`;
    let h = 0;
    for (let i = 0; i < basis.length; i++) h = (h * 31 + basis.charCodeAt(i)) | 0;
    return 'pg#' + (h >>> 0).toString(16);
}

/**
 * Count RAW record IDs on a page NOT already in seenIds, WITHOUT mutating it
 * (BLOCKER D: raw progress is computed BEFORE category filtering + dedup commit).
 * A page of all-new raw IDs is transport-progress>0 even if 0 survive the filter.
 */
export function countRawNewIds(records, seenIds) {
    let n = 0;
    for (const record of records || []) {
        const id = record?.metadata?.[0]?.['arXiv']?.[0]?.id?.[0];
        if (id && !seenIds.has(id)) n++;
    }
    return n;
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

