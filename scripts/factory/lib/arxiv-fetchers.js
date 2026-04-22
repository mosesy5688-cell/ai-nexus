/**
 * ArXiv Ingestion Fetchers — V26.6 (2026-Standard)
 * Handles session priming and ar5iv HTML5 conversion fetching.
 */

// ── Constants ───────────────────────────────────────────
export const ARXIV_HOME = 'https://arxiv.org';
export const ARXIV_HTML_BASE = 'https://arxiv.org/html';
export const FETCH_TIMEOUT_MS = 60000;

let sessionCookie = '';

// ── Core Fetchers ───────────────────────────────────────
export async function primeSession() {
    try {
        console.log(`[BOOSTER] Priming session at ${ARXIV_HOME}...`);
        const res = await fetch(ARXIV_HOME, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' } 
        });
        const cookies = res.headers.get('set-cookie');
        if (cookies) {
            sessionCookie = cookies.split(';')[0];
            console.log(`[BOOSTER] Obtained session cookie: ${sessionCookie.substring(0, 15)}...`);
        }
    } catch (e) {
        console.warn(`[BOOSTER] Session priming failed: ${e.message}`);
    }
}

export function extractArxivId(canonicalId) {
    if (!canonicalId) return null;
    
    // 1. Try to find a standard ArXiv ID pattern anywhere
    const arxivMatch = canonicalId.match(/(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i);
    if (arxivMatch) return arxivMatch[1].replace(/v\d+$/, '');
    
    // 2. Fallback for S2 IDs (e.g. unknown--649... or semantic_scholar...)
    let id = canonicalId.replace(/^(?:arxiv|unknown|semantic_scholar|s2)[_-]+(?:paper--)?/i, '');
    if (/^[a-f0-9]{40}$/i.test(id) || /^\d+$/.test(id)) return id;
    
    return null;
}

export async function fetchOfficialHtml(arxivId) {
    const isArxiv = /^\d{4}\.\d{4,5}$/.test(arxivId) || /^[a-z-]+\/\d{7}$/i.test(arxivId);
    if (!isArxiv) return { type: 'SKIP', html: null, status: 400 };
    const url = `${ARXIV_HTML_BASE}/${arxivId}`;
    try {
        const res = await fetch(url, { 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://arxiv.org/',
                'Cookie': sessionCookie,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (res.status === 404) return { type: 'SKIP', html: null, status: 404 };
        if (res.status === 429) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10);
            console.warn(`[ArXiv] 429 rate limited, waiting ${retryAfter}s...`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            return { type: 'FAILURE', html: null, status: 429 };
        }
        if (!res.ok) return { type: 'FAILURE', html: null, status: res.status };
        return { type: 'HTML', html: await res.text(), status: 200, source: 'official' };
    } catch (e) {
        return { type: 'FAILURE', html: null, status: e.name === 'TimeoutError' || e.name === 'AbortError' ? 408 : 0 };
    }
}

export async function fetchAr5ivHtml(arxivId) {
    const isArxiv = /^\d{4}\.\d{4,5}$/.test(arxivId) || /^[a-z-]+\/\d{7}$/i.test(arxivId);
    if (!isArxiv) return { type: 'SKIP', html: null, status: 400 };
    const url = `https://ar5iv.labs.arxiv.org/html/${arxivId}`;
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (res.status === 404) return { type: 'SKIP', html: null, status: 404 };
        if (res.status === 429) {
            const retryAfter = parseInt(res.headers.get('Retry-After') || '30', 10);
            console.warn(`[ar5iv] 429 rate limited, waiting ${retryAfter}s...`);
            await new Promise(r => setTimeout(r, retryAfter * 1000));
            return { type: 'FAILURE', html: null, status: 429 };
        }
        if (!res.ok) return { type: 'FAILURE', html: null, status: res.status };
        return { type: 'HTML', html: await res.text(), status: 200, source: 'ar5iv' };
    } catch (e) {
        return { type: 'FAILURE', html: null, status: e.name === 'TimeoutError' || e.name === 'AbortError' ? 408 : 0 };
    }
}

