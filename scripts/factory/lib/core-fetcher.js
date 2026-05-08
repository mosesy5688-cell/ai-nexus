/**
 * CORE Fulltext Fetcher — V26.6
 *
 * Fetches paper fulltext from CORE (core.ac.uk) as third waterfall tier.
 * CORE holds 46M+ fulltext papers including many arXiv papers without HTML.
 *
 * API: https://api.core.ac.uk/v3
 * Rate limit: 10 req/s (free tier with API key)
 */

const CORE_API_BASE = 'https://api.core.ac.uk/v3';
const CORE_API_KEY = process.env.CORE_API_KEY || '';
const FETCH_TIMEOUT_MS = 30000;

function headers() {
    const h = {
        'Accept': 'application/json',
        'User-Agent': 'Free2AITools/2.1 (research; https://free2aitools.com)',
    };
    if (CORE_API_KEY) h['Authorization'] = `Bearer ${CORE_API_KEY}`;
    return h;
}

/**
 * Search CORE for a paper by arXiv ID and return fulltext.
 * @param {string} arxivId - e.g. "2301.12345"
 * @returns {{ type: string, text: string|null, source: string, status: number }}
 */
export async function fetchCoreFulltext(arxivId) {
    if (!CORE_API_KEY) return { type: 'SKIP', text: null, status: 0, source: 'core' };
    if (!arxivId) return { type: 'SKIP', text: null, status: 400, source: 'core' };

    try {
        const query = encodeURIComponent(`arxivId:${arxivId}`);
        const url = `${CORE_API_BASE}/search/works?q=${query}&limit=1&fulltext=true`;
        const res = await fetch(url, {
            headers: headers(),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (res.status === 429) {
            const wait = parseInt(res.headers.get('Retry-After') || '5', 10);
            console.warn(`[CORE] 429 rate limited, waiting ${wait}s...`);
            await new Promise(r => setTimeout(r, wait * 1000));
            return { type: 'FAILURE', text: null, status: 429, source: 'core' };
        }
        if (!res.ok) return { type: 'FAILURE', text: null, status: res.status, source: 'core' };

        const data = await res.json();
        const results = data.results || [];
        if (results.length === 0) return { type: 'SKIP', text: null, status: 404, source: 'core' };

        const work = results[0];
        const fulltext = work.fullText || '';
        if (fulltext.length < 200) return { type: 'SKIP', text: null, status: 204, source: 'core' };

        return { type: 'TEXT', text: fulltext, status: 200, source: 'core' };
    } catch (e) {
        return { type: 'FAILURE', text: null, status: e.name === 'TimeoutError' ? 408 : 0, source: 'core' };
    }
}

/**
 * Search CORE by DOI or title (for non-arXiv papers).
 * @param {string} doi - DOI string
 * @param {string} title - Paper title as fallback
 * @returns {{ type: string, text: string|null, source: string, status: number }}
 */
export async function fetchCoreByDoi(doi, title) {
    if (!CORE_API_KEY) return { type: 'SKIP', text: null, status: 0, source: 'core' };
    if (!doi && !title) return { type: 'SKIP', text: null, status: 400, source: 'core' };

    try {
        const query = doi
            ? encodeURIComponent(`doi:"${doi}"`)
            : encodeURIComponent(title.substring(0, 200));
        const url = `${CORE_API_BASE}/search/works?q=${query}&limit=1&fulltext=true`;
        const res = await fetch(url, {
            headers: headers(),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });

        if (res.status === 429) return { type: 'FAILURE', text: null, status: 429, source: 'core' };
        if (!res.ok) return { type: 'FAILURE', text: null, status: res.status, source: 'core' };

        const data = await res.json();
        const results = data.results || [];
        if (results.length === 0) return { type: 'SKIP', text: null, status: 404, source: 'core' };

        const fulltext = results[0].fullText || '';
        if (fulltext.length < 200) return { type: 'SKIP', text: null, status: 204, source: 'core' };

        return { type: 'TEXT', text: fulltext, status: 200, source: 'core' };
    } catch (e) {
        return { type: 'FAILURE', text: null, status: e.name === 'TimeoutError' ? 408 : 0, source: 'core' };
    }
}
