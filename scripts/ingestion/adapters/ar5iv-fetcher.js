/**
 * Ar5iv Full-Text HTML Fetcher
 * V25.8: Deep Paper enrichment via ar5iv.labs.arxiv.org
 *
 * LEGAL-RESILIENCE L1 (Papers Abstract-Only, 2026-06-06): the fetched full text
 * is a TRANSIENT in-pipeline DERIVATION input ONLY. arxiv-adapter.normalize()
 * uses it in-process to mine datasets_used + has_code/relation edges, then
 * DISCARDS it — it is NEVER persisted into body_content / the packed cold .bin,
 * and NEVER served to humans or the public API. "Raw Content = Fuel; Structure
 * = Asset": the full paper body is fuel, not a stored/served asset.
 *
 * Rate-limited to respect ar5iv infrastructure (5s between requests).
 */

const AR5IV_BASE = 'https://ar5iv.labs.arxiv.org/html';
const FETCH_TIMEOUT_MS = 15000;
const RATE_LIMIT_MS = 5000;
const MAX_HTML_SIZE = 500000; // 500KB cap per paper

let _lastFetchTime = 0;

/**
 * Fetch full-text HTML for a single ArXiv paper.
 * @param {string} arxivId - e.g. "2401.12345" or "2401.12345v2"
 * @returns {string|null} Cleaned HTML text or null on failure
 */
export async function fetchAr5ivHtml(arxivId, deps = {}) {
    if (!arxivId) return null;
    // Test seam only; production passes nothing and keeps FETCH_TIMEOUT_MS, the 5s
    // RATE_LIMIT_MS spacing and the global fetch exactly as they are.
    const timeoutMs = Number.isFinite(deps.timeoutMs) ? deps.timeoutMs : FETCH_TIMEOUT_MS;
    const rateLimitMs = Number.isFinite(deps.rateLimitMs) ? deps.rateLimitMs : RATE_LIMIT_MS;
    const fetchImpl = deps.fetch || fetch;

    // Strip version suffix for ar5iv (uses latest)
    const cleanId = arxivId.replace(/v\d+$/, '');
    const url = `${AR5IV_BASE}/${cleanId}`;

    // Rate limiting. _lastFetchTime is stamped BEFORE the fetch (below), so the
    // interval is measured start-to-start and overlaps the previous call's duration --
    // that overlap is what makes a call cost at most max(rateLimitMs, timeoutMs).
    const now = Date.now();
    const elapsed = now - _lastFetchTime;
    if (elapsed < rateLimitMs) {
        await new Promise(r => setTimeout(r, rateLimitMs - elapsed));
    }
    _lastFetchTime = Date.now();

    // NBF-4 FULL-RESPONSE DEADLINE. One AbortController + ONE timer, armed at fetch
    // start and kept armed through `response.text()`, so timeoutMs bounds the WHOLE
    // lifecycle: fetch start -> headers -> complete body consumption -> text returned.
    // Previously the timer was cleared the moment headers arrived, leaving the body
    // read unbounded -- so FETCH_TIMEOUT_MS was not a bound and the 10 x 15000 = 150000
    // per-page figure the admission gate prices was unsound. Aborting the signal
    // errors the body stream, so a stalled OR slowly-trickling body fails AT the
    // deadline (total duration, not idle). The timer is cleared in `finally`, i.e. on
    // success, HTTP-error, body-failure and timeout paths alike; nothing is awaited
    // during cleanup, so no orphaned network task and no handle blocks settlement.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(url, {
            headers: {
                'User-Agent': 'Free2AITools-Scholar/1.0 (academic-indexing)',
                'Accept': 'text/html'
            },
            signal: controller.signal
        });

        if (!response.ok) {
            if (response.status === 404) return null; // Paper not yet rendered
            console.warn(`[AR5IV] HTTP ${response.status} for ${arxivId}`);
            return null;
        }

        const html = await response.text(); // STILL under the same armed deadline
        if (html.length > MAX_HTML_SIZE) {
            return extractMainContent(html.substring(0, MAX_HTML_SIZE));
        }
        return extractMainContent(html);
    } catch (e) {
        if (e.name === 'AbortError') {
            console.warn(`[AR5IV] Timeout for ${arxivId}`);
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Extract main article content from ar5iv HTML, stripping nav/header/footer.
 * Returns plain text with section headers preserved.
 */
function extractMainContent(html) {
    // Remove script/style/nav/header/footer tags
    let text = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '');

    // Preserve section headers as markdown
    text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, content) => {
        const hashes = '#'.repeat(parseInt(level));
        return `\n${hashes} ${stripTags(content).trim()}\n`;
    });

    // Preserve paragraphs
    text = text.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, content) => {
        return stripTags(content).trim() + '\n\n';
    });

    // Strip remaining tags
    text = stripTags(text);

    // Clean whitespace
    text = text.replace(/\n{3,}/g, '\n\n').trim();

    // Minimum quality check
    if (text.length < 200) return null;
    return text;
}

function stripTags(html) {
    return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
}

/**
 * Batch fetch for multiple papers with progress tracking.
 * @param {Array<{arxiv_id: string}>} papers - Papers to enrich
 * @param {number} maxCount - Maximum papers to fetch (budget control)
 * @returns {Map<string, string>} arxivId -> fullText
 */
export async function batchFetchAr5iv(papers, maxCount = 500) {
    console.log(`[AR5IV] Batch enrichment: ${Math.min(papers.length, maxCount)} papers...`);
    const results = new Map();
    let fetched = 0, success = 0;

    for (const paper of papers) {
        if (fetched >= maxCount) break;
        const id = paper.arxiv_id;
        if (!id) continue;

        const html = await fetchAr5ivHtml(id);
        fetched++;
        if (html) {
            results.set(id, html);
            success++;
        }

        if (fetched % 50 === 0) {
            console.log(`  [AR5IV] Progress: ${fetched}/${maxCount} (${success} enriched)`);
        }
    }

    console.log(`[AR5IV] Complete: ${success}/${fetched} papers enriched with full text`);
    return results;
}
