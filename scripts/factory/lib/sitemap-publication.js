/**
 * D-140 Lane S-A §5 — CHILD-BEFORE-INDEX PUBLICATION BARRIER.
 *
 * The sitemap index (`sitemaps/sitemap-index.xml`) must NEVER be published until
 * every child shard it references (`sitemaps/sitemap-N.xml.gz`) is confirmed
 * present on R2. A lexical "index last" sort is INSUFFICIENT and a single
 * concurrency batch containing children + index is PROHIBITED — both can let the
 * index land while a child is still missing/failed.
 *
 * This module provides the explicit discrimination + verification primitives:
 *   - classifySitemapObjects(): split the upload set into { children, index,
 *     others } purely by remote path under the sitemaps/ prefix.
 *   - parseIndexChildLocs(): read the candidate index XML and return the exact
 *     child remote-paths it references (the set that MUST exist before publish).
 *   - verifyChildrenPresent(): HEAD each referenced child; returns the missing
 *     set. Any HEAD that errors (non-404) propagates fail-loud.
 *
 * Failure ladder (never downgraded to a warning, never publishes a partial/empty
 * index): CHILD_UPLOAD_INCOMPLETE -> INDEX_NOT_PUBLISHED -> JOB_FAIL.
 */
import fs from 'fs/promises';

export const SITEMAP_INDEX_KEYS = new Set(['sitemaps/sitemap-index.xml', 'sitemap.xml']);

/** True if a remote path is a sitemap CHILD shard (sitemaps/sitemap-N.xml[.gz]). */
export function isSitemapChild(remotePath) {
    return /^sitemaps\/sitemap-\d+\.xml(\.gz)?$/.test(remotePath);
}

/** True if a remote path is the sitemap INDEX (or its root mirror). */
export function isSitemapIndex(remotePath) {
    return SITEMAP_INDEX_KEYS.has(remotePath);
}

/**
 * Partition an array of upload items ({ remotePath, ... }) into:
 *   - children: child sitemap shards (Phase 1, with everything else)
 *   - index:    the sitemap index + root mirror (Phase 2 ONLY)
 *   - others:   all non-sitemap-index objects (Phase 1)
 * The index is held OUT of the Phase-1 concurrency batch entirely.
 */
export function classifySitemapObjects(items) {
    const children = [];
    const index = [];
    const others = [];
    for (const it of items) {
        if (isSitemapIndex(it.remotePath)) index.push(it);
        else if (isSitemapChild(it.remotePath)) { children.push(it); others.push(it); }
        else others.push(it);
    }
    return { children, index, others };
}

/**
 * Parse the candidate sitemap-index XML and return the exact set of child
 * remote-paths it references (e.g. 'sitemaps/sitemap-1.xml.gz'). These are the
 * children that MUST exist on R2 before the index may be published.
 */
export async function parseIndexChildLocs(indexLocalPath) {
    const xml = await fs.readFile(indexLocalPath, 'utf8');
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
    const children = [];
    for (const loc of locs) {
        const m = loc.match(/\/(sitemaps\/sitemap-\d+\.xml(?:\.gz)?)$/);
        if (m) children.push(m[1]);
    }
    return children;
}

/**
 * Verify every referenced child exists remotely. `headFn(remotePath)` must
 * resolve to { exists, etag } and THROW on transient/credential errors (so we
 * never publish on an inconclusive check). Returns { ok, missing }.
 */
export async function verifyChildrenPresent(childRemotePaths, headFn) {
    const missing = [];
    for (const childPath of childRemotePaths) {
        const { exists } = await headFn(childPath); // throws (fail-loud) on non-404 error
        if (!exists) missing.push(childPath);
    }
    return { ok: missing.length === 0, missing };
}

/**
 * PHASE 2 — publish the sitemap index ONLY after all referenced children are
 * uploaded (Phase 1) AND each child's remote existence is verified.
 *
 * @param {object} o
 * @param {boolean} o.phase1Ok        Phase-1 children completed with zero failures.
 * @param {Array}   o.indexItems      [{ localPath, remotePath }] index + root mirror.
 * @param {string}  o.candidateIndexLocalPath  the sitemaps/sitemap-index.xml local file.
 * @param {Function} o.headFn         (remotePath) => { exists, etag }; throws on non-404.
 * @param {Function} o.uploadFn       (localPath, remotePath) => { success, ... }.
 * @param {Function} [o.log]          logger.
 * @returns {Promise<{published:boolean, status:string, candidateChildren:number, verifiedChildren:number}>}
 *
 * On any incompletion the OLD index stays in place (we never upload the new one)
 * and the result carries a non-published status the caller MUST turn into JOB_FAIL.
 */
export async function publishSitemapIndex({ phase1Ok, indexItems, candidateIndexLocalPath, headFn, uploadFn, log = console.log }) {
    const result = { published: false, status: '', candidateChildren: 0, verifiedChildren: 0 };

    if (!indexItems || indexItems.length === 0) {
        result.status = 'NO_INDEX_CANDIDATE';
        return result; // nothing to publish this cycle; not a failure.
    }
    if (!phase1Ok) {
        result.status = 'CHILD_UPLOAD_INCOMPLETE -> INDEX_NOT_PUBLISHED';
        log(`[SITEMAP-PUBLISH] ❌ ${result.status} — a Phase-1 child upload failed; OLD index left in place.`);
        return result;
    }

    const childRefs = await parseIndexChildLocs(candidateIndexLocalPath);
    result.candidateChildren = childRefs.length;
    const { ok, missing } = await verifyChildrenPresent(childRefs, headFn);
    result.verifiedChildren = childRefs.length - missing.length;
    log(`[SITEMAP-PUBLISH] Candidate children: ${result.candidateChildren}, verified present on R2: ${result.verifiedChildren}.`);

    if (!ok) {
        result.status = 'CHILD_UPLOAD_INCOMPLETE -> INDEX_NOT_PUBLISHED';
        log(`[SITEMAP-PUBLISH] ❌ ${result.status} — missing/unverified children: ${missing.join(', ')}. OLD index left in place.`);
        return result;
    }

    for (const item of indexItems) {
        const r = await uploadFn(item.localPath, item.remotePath);
        if (!r || !r.success) {
            result.status = 'INDEX_NOT_PUBLISHED';
            log(`[SITEMAP-PUBLISH] ❌ Index object upload failed: ${item.remotePath} (${r?.error || 'unknown'}). OLD index left in place.`);
            return result;
        }
    }

    result.published = true;
    result.status = 'INDEX_PUBLISHED';
    log(`[SITEMAP-PUBLISH] ✅ Index published after all ${result.candidateChildren} children verified.`);
    return result;
}
