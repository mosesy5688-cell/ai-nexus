/**
 * ArXiv Ingestion Fetchers — V25.8.6.5 (2026-Standard)
 * Handles session priming, HTML5 conversion fetching, and S2 fallback.
 */

// ── Constants ───────────────────────────────────────────
export const ARXIV_HOME = 'https://arxiv.org';
export const ARXIV_HTML_BASE = 'https://arxiv.org/html';
export const S2_API = 'https://api.semanticscholar.org/graph/v1/paper';
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
    const m = canonicalId.match(/arxiv[_-](?:paper--)?(.+)/i);
    return m ? m[1].replace(/v\d+$/, '') : null;
}

export async function fetchOfficialHtml(arxivId) {
    const url = `${ARXIV_HTML_BASE}/${arxivId}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://arxiv.org/',
                'Cookie': sessionCookie,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            },
            signal: ctrl.signal 
        });
        clearTimeout(timer);
        if (res.status === 404) return { type: 'SKIP', html: null };
        if (res.status === 429) return { type: 'FAILURE', html: null };
        if (!res.ok) return { type: 'FAILURE', html: null };
        return { type: 'HTML', html: await res.text() };
    } catch (e) {
        clearTimeout(timer);
        return { type: 'FAILURE', html: null };
    }
}

let s2CallCount = 0;
export async function fetchS2Fulltext(arxivId, budget) {
    if (!arxivId) return null;
    if (s2CallCount >= budget) return null;
    s2CallCount++;
    try {
        const res = await fetch(`${S2_API}/ArXiv:${arxivId}?fields=title,abstract,fullText`, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36' 
            },
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.fullText || null;
    } catch { return null; }
}
