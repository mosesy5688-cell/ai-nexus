/**
 * LangChain Hub Manifest Helper
 *
 * R4-A (prompt body void) fix. The public /repos/ listing only carries a short
 * description; the real prompt body lives in the per-prompt latest-commit
 * manifest on a different host (api.hub.langchain.com).
 *
 * This module:
 *  - flattenManifest(): pure, fixture-testable manifest -> markdown text.
 *  - fetchManifestBody(): sequential, AbortController-timed fetch with a
 *    honest fallback (returns null on any failure so the caller keeps the
 *    existing description; never fabricates a body, never aborts the harvest).
 *
 * @module ingestion/adapters/langchain-manifest
 */

export const LANGCHAIN_HUB_BASE = 'https://api.hub.langchain.com';

// Per-request timeout for the hub manifest fetch. 6s (NOT 3s) so a cold
// upstream fetch is not falsely timed-out, which would silently lose bodies.
const MANIFEST_TIMEOUT_MS = 6000;

/**
 * Infer a human role label from a message class id (e.g. the dotted import
 * path LangChain serializes). Falls back to 'message' when unknown.
 * @param {*} id - manifest message `id` (array or string)
 * @returns {string}
 */
function inferRole(id) {
    const idStr = Array.isArray(id) ? id.join('.') : String(id || '');
    const lower = idStr.toLowerCase();
    if (lower.includes('system')) return 'system';
    if (lower.includes('human') || lower.includes('user')) return 'human';
    if (lower.includes('ai') || lower.includes('assistant')) return 'ai';
    return 'message';
}

/**
 * Flatten a LangChain Hub manifest into a plain markdown body string.
 *
 * Handles two shapes:
 *  - ChatPromptTemplate: manifest.kwargs.messages[] where each message exposes
 *    m.kwargs.prompt.kwargs.template (entries without it, e.g.
 *    MessagesPlaceholder, are skipped).
 *  - PromptTemplate: manifest.kwargs.template when there are no messages.
 * Appends the input_variables list when present.
 *
 * @param {Object} manifest
 * @returns {string} flattened body, or '' when nothing usable is found
 */
export function flattenManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') return '';
    const kwargs = manifest.kwargs || {};
    const parts = [];

    const messages = Array.isArray(kwargs.messages) ? kwargs.messages : null;
    if (messages && messages.length > 0) {
        for (const m of messages) {
            const template = m && m.kwargs && m.kwargs.prompt && m.kwargs.prompt.kwargs
                ? m.kwargs.prompt.kwargs.template
                : undefined;
            // Skip entries with no template (e.g. MessagesPlaceholder).
            if (typeof template !== 'string' || template.length === 0) continue;
            const role = inferRole(m.id);
            parts.push(`## ${role}\n\n${template}`);
        }
    } else if (typeof kwargs.template === 'string' && kwargs.template.length > 0) {
        parts.push(kwargs.template);
    }

    if (Array.isArray(kwargs.input_variables) && kwargs.input_variables.length > 0) {
        parts.push(`### Input Variables\n\n${kwargs.input_variables.join(', ')}`);
    }

    return parts.join('\n\n');
}

/**
 * Fetch and flatten the latest-commit manifest body for a single prompt.
 *
 * Honest-contract: on timeout, non-OK status, or parse error this returns
 * null. The caller then falls back to the existing description. Never throws,
 * never fabricates a body. Pacing/backoff is owned by the caller (adapter)
 * which runs these sequentially via its own this.delay(...).
 *
 * @param {string} owner
 * @param {string} handle
 * @param {Object} adapter - the LangChainAdapter (for getHeaders/delay)
 * @returns {Promise<string|null>} flattened body, or null on any failure
 */
export async function fetchManifestBody(owner, handle, adapter) {
    if (!owner || !handle) return null;
    const url = `${LANGCHAIN_HUB_BASE}/commits/${owner}/${handle}/latest`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS);

    try {
        const response = await fetch(url, {
            headers: adapter.getHeaders(),
            signal: controller.signal
        });

        // V28 PR-3 (#2116 regression): on 429 — or ANY non-OK — return null
        // IMMEDIATELY (caller falls back to description). The old flat 30s wait
        // here was the stall multiplier: 100 rate-limited items x 30s = ~50min,
        // timing out the whole LangChain harvest. Persistence is now handled by
        // the adapter's aggregate circuit-breaker (enrichBodies disables
        // enrichment after N consecutive failures); the 6s AbortController above
        // still bounds a single hung fetch. No per-item flat wait.
        if (!response.ok) return null;

        const data = await response.json();
        const body = flattenManifest(data && data.manifest);
        return body && body.length > 0 ? body : null;
    } catch (err) {
        // Timeout (abort), network, or parse error -> honest fallback.
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// After this many CONSECUTIVE manifest-fetch failures, stop enriching for the
// rest of the run (lose nice-to-have bodies, keep the harvest moving).
const MANIFEST_FAIL_THRESHOLD = 8;

/**
 * Stateful manifest-body enricher with an aggregate circuit-breaker.
 *
 * V28 PR-3 (#2116 regression): the prompt body is a NICE-TO-HAVE and must NEVER
 * stall the harvest. One instance lives for the whole harvest run, so the
 * consecutive-failure counter persists across batches. When the hub
 * rate-limits, failures accumulate; once the threshold is hit, enrichment is
 * disabled for the rest of the run and every remaining item honestly falls back
 * to its description (the per-fetch 6s AbortController bounds a single hung
 * fetch; no flat per-item wait). A single success resets the counter.
 */
export class ManifestEnricher {
    constructor() {
        this.fails = 0;
        this.disabled = false;
    }

    /**
     * Enrich a batch of items in place by attaching item._body (or null).
     * @param {Object[]} items - safe items for this batch
     * @param {Object} adapter - the LangChainAdapter (getHeaders/delay)
     */
    async enrich(items, adapter) {
        for (const item of items) {
            if (this.disabled) { item._body = null; continue; }

            const owner = item.owner || 'langchain';
            const handle = item.repo_handle || item.name;
            const body = await fetchManifestBody(owner, handle, adapter);
            item._body = body;

            if (body) {
                this.fails = 0; // success → reset consecutive counter
            } else if (++this.fails >= MANIFEST_FAIL_THRESHOLD) {
                this.disabled = true;
                console.warn(`   ⚠️ [LangChain] manifest enrichment disabled after ${this.fails} consecutive failures — falling back to description.`);
            }

            await adapter.delay(500); // Sequential, gentle pacing
        }
    }
}
