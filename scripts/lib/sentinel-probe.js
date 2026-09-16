/**
 * L9 GUARDIAN - budgeted Tier-2 page probe with per-request evidence.
 *
 * Replaces the un-timed `await fetch(url)` + `.gz` retry that sentinel-prod.js
 * used to inline. Three properties this module adds:
 *
 *  1. ONE deadline per logical check covers the main request, the `.gz`
 *     fallback and the body read TOGETHER. The fallback never gets a fresh
 *     budget (see probePage: both requests receive the same `deadlineAt`).
 *  2. The deadline ABORTS the in-flight request via AbortController. It does
 *     not merely stop awaiting it. The same controller covers `res.text()`, so
 *     a body that stalls after a 200 is aborted and fails honestly.
 *  3. The primary and the fallback are recorded SEPARATELY (status, duration,
 *     error) and the check records which response was finally used.
 *
 * A local deadline is reported as outcome 'probe-timeout'. It is NEVER reported
 * as an HTTP status - in particular never as 524, which is a CDN-origin verdict
 * this script has no standing to issue.
 *
 * Fallback ELIGIBILITY and the text/minSize content checks are unchanged from
 * the previous implementation on purpose: fallback only when a response was
 * received and it was not ok and the URL does not already end in `.gz`.
 */

/**
 * Headers that would identify the SERVED deploy. X-Guardian-Version is
 * deliberately absent: src/middleware.ts sets it to the string literal
 * 'v18.12.5-resilient', so it is constant across every deploy and identifies
 * nothing. When none of these is present the version is recorded as 'unknown';
 * the checkout HEAD is NEVER substituted for it (it describes this script, not
 * the response).
 */
export const DEPLOY_VERSION_HEADERS = ['x-deploy-id', 'x-build-id', 'x-nexus-build', 'cf-deployment-id'];

export const UNKNOWN_VERSION = 'unknown';

function header(res, name) {
    try {
        return (res && res.headers && typeof res.headers.get === 'function') ? res.headers.get(name) : null;
    } catch {
        return null;
    }
}

function captureResponseIdentity(record, res) {
    let version = UNKNOWN_VERSION;
    for (const name of DEPLOY_VERSION_HEADERS) {
        const value = header(res, name);
        if (value) { version = value; break; }
    }
    record.responseVersion = version;
    record.cfCacheStatus = header(res, 'cf-cache-status');
    // Origin-reported render time set by src/middleware.ts. On a
    // `cf-cache-status: HIT` this is the value captured when the CACHED response
    // was produced, not a measurement of this request. Recorded raw, uninterpreted.
    record.originRenderHeader = header(res, 'x-guardian-time');
}

/**
 * Issue one request against a shared deadline and return its evidence record.
 *
 * @param {object} o
 * @param {'primary'|'gz-fallback'} o.role
 * @param {number} o.deadlineAt  absolute ms deadline shared across the check
 * @returns {Promise<{record: object, body: string|null, ok: boolean, response: object|null}>}
 */
export async function timedRequest({ role, url, headers, deadlineAt, method = 'GET', fetchImpl = fetch, now = Date.now }) {
    const startedAt = now();
    const record = {
        role,
        url,
        startedAtUtc: new Date(startedAt).toISOString(),
        durationMs: 0,
        httpStatus: null,
        outcome: 'skipped',
        timedOutDuring: null,
        error: null,
        responseVersion: null,
        cfCacheStatus: null,
        originRenderHeader: null,
        bodyLength: null
    };
    const budgetMs = deadlineAt - startedAt;
    if (budgetMs <= 0) {
        record.error = 'Skipped: the shared check budget was already exhausted when this request was due to start';
        return { record, body: null, ok: false, response: null };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let body = null;
    let ok = false;
    let response = null;
    try {
        const res = await fetchImpl(url, { method, headers, signal: controller.signal });
        response = res;
        record.httpStatus = res.status;
        captureResponseIdentity(record, res);
        ok = Boolean(res.ok);
        // Body is read only for an ok response, matching the prior control flow
        // (which called .text() only on the response it finally accepted).
        if (ok && method !== 'HEAD') {
            body = await res.text();
            record.bodyLength = body.length;
        }
        record.outcome = ok ? 'ok' : 'http-error';
        if (!ok) record.error = `HTTP ${res.status}`;
    } catch (err) {
        ok = false;
        body = null;
        if (controller.signal.aborted) {
            // httpStatus is set only after headers arrive, so it discriminates
            // a stall before headers from a stall during the body read.
            record.timedOutDuring = record.httpStatus === null ? 'headers' : 'body';
            record.outcome = 'probe-timeout';
            record.error = `Probe timeout after ${budgetMs}ms during ${record.timedOutDuring} read (local abort by this script, not an HTTP status)`;
        } else {
            record.outcome = 'transfer-error';
            record.error = (err && err.message) ? err.message : String(err);
        }
    } finally {
        clearTimeout(timer);
        record.durationMs = now() - startedAt;
    }
    return { record, body, ok, response };
}

function applyContentChecks(page, content) {
    if (page.text && !content.includes(page.text)) {
        return { error: `Text missing: "${page.text}"` };
    }
    if (page.minSize && content.length < page.minSize) {
        return { error: `Payload too small: ${content.length}b < ${page.minSize}b` };
    }
    return null;
}

/**
 * Probe one page under a single shared budget.
 *
 * Returned object KEEPS the previous shape ({name, status} on pass,
 * {name, status, error} on fail); everything else is additive.
 */
export async function probePage({ baseUrl, page, headers, budgetMs, fetchImpl = fetch, now = Date.now }) {
    const startedAt = now();
    const deadlineAt = startedAt + budgetMs;
    const url = `${baseUrl}${page.url}`;
    const check = {
        name: page.name,
        status: 'PASS',
        url,
        budgetMs,
        durationMs: 0,
        outcome: 'ok',
        usedResponse: 'none',
        note: null,
        requests: []
    };

    const primary = await timedRequest({ role: 'primary', url, headers, deadlineAt, fetchImpl, now });
    check.requests.push(primary.record);

    let chosen = primary;
    // Eligibility: a COMPLETE non-ok response was received, and the URL is not
    // already a .gz. Keying off outcome === 'http-error' (NOT `httpStatus !==
    // null`) is what makes this match the prior behaviour: httpStatus is set as
    // soon as HEADERS arrive, so a BODY-phase failure after a 200 leaves
    // httpStatus = 200 with ok = false, and the looser test fired a fallback the
    // baseline never fired -- turning a mid-body failure from FAIL into PASS.
    // A primary that timed out or died in transfer gets NO fallback, as before.
    // The fallback shares `deadlineAt`, so it can only ever consume what the
    // primary left (see A4).
    if (primary.record.outcome === 'http-error' && !url.endsWith('.gz')) {
        const fallback = await timedRequest({ role: 'gz-fallback', url: `${url}.gz`, headers, deadlineAt, fetchImpl, now });
        check.requests.push(fallback.record);
        if (fallback.ok) chosen = fallback;
    }

    if (chosen.ok) {
        check.usedResponse = chosen.record.role;
        const failure = applyContentChecks(page, chosen.body === null ? '' : chosen.body);
        if (failure) {
            check.status = 'FAIL';
            check.outcome = 'content-mismatch';
            check.error = failure.error;
        }
        if (check.usedResponse === 'gz-fallback') {
            check.note = `Success came from the .gz fallback (${chosen.record.url}); the primary request (${url}) returned HTTP ${primary.record.httpStatus}. Both results are kept in requests[].`;
        }
    } else {
        check.status = 'FAIL';
        // The thrown-error text stays the PRIMARY's, preserving the previous
        // behaviour where a failed fallback left the original status in the
        // message. requests[] carries the fallback's own status alongside it.
        check.outcome = primary.record.outcome === 'ok' ? 'http-error' : primary.record.outcome;
        check.error = primary.record.error;
        check.usedResponse = 'none';
    }

    check.durationMs = now() - startedAt;
    return check;
}

/**
 * Record for a check that was never issued because the tier total budget was
 * already spent. Recorded as FAIL, not PASS and not silently omitted: the audit
 * cannot assert the health of a page it did not probe. The error text says
 * plainly that this is a not-run record, not a page verdict.
 */
export function notRunCheck(page, tierBudgetMs) {
    return {
        name: page.name,
        status: 'FAIL',
        url: page.url,
        budgetMs: 0,
        durationMs: 0,
        outcome: 'not-run',
        usedResponse: 'none',
        note: 'Not a verdict on this page: the check was never issued.',
        requests: [],
        error: `Not run: the Tier 2 total budget (${tierBudgetMs}ms) was exhausted before this check started`
    };
}
