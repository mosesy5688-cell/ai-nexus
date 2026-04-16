/**
 * HuggingFace README Fetcher — C-stage (V26.4 §18.23.5)
 *
 * Fix for the 167→115 models-enriched-per-partition collapse observed across
 * Runs 24309565292 / 24389730436 / 24438771397 / 24496159440 (04-12→04-16).
 *
 * Changes vs the previous inline implementation in density-booster.js:
 *   1. /raw/ (Pages bucket, 200 req/5min Free) → /resolve/ (Resolvers bucket,
 *      5000 req/5min Free, 25x budget). Resolvers is the endpoint the HF CDN
 *      uses for model weights — README fetches belong here, not Pages.
 *   2. 429 honors IETF draft-ietf-httpapi-ratelimit-headers (`RateLimit: t=…`)
 *      then falls back to `Retry-After`, default 60s.
 *   3. HF_TOKEN preflight via whoami-v2 — fail fast if a token is provided
 *      but invalid (avoids silently burning anonymous quota for the whole run).
 *   4. Reason-bucket telemetry so we can read the *shape* of failures from the
 *      summary line instead of guessing from aggregate ratios.
 */

const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_HEADERS = HF_TOKEN ? { Authorization: `Bearer ${HF_TOKEN}` } : {};
const WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';

export const hfReasons = { ok: 0, notFound: 0, rateLimited: 0, tooShort: 0, networkError: 0 };

export async function preflightHfToken() {
    if (!HF_TOKEN) {
        console.warn('[HF] HF_TOKEN missing — anonymous mode (Pages 200/5min). Severe rate-limit expected.');
        return true;
    }
    try {
        const res = await fetch(WHOAMI_URL, { headers: HF_HEADERS, signal: AbortSignal.timeout(10000) });
        if (!res.ok) { console.error(`[HF] HF_TOKEN invalid (whoami-v2 ${res.status}). Fail-fast.`); return false; }
        console.log('[HF] HF_TOKEN valid.');
        return true;
    } catch (e) { console.error(`[HF] preflight error: ${e.message}. Fail-fast.`); return false; }
}

export async function fetchHfReadme(modelId) {
    try {
        const url = `https://huggingface.co/${modelId}/resolve/main/README.md`;
        const res = await fetch(url, { headers: HF_HEADERS, signal: AbortSignal.timeout(15000), redirect: 'follow' });
        if (res.status === 429) {
            const rlHeader = res.headers.get('ratelimit') || '';
            const waitSec = parseInt((rlHeader.match(/t=(\d+)/) || [])[1] || res.headers.get('retry-after') || '60', 10);
            console.warn(`[HF] 429 rate-limited — waiting ${waitSec}s`);
            await new Promise(r => setTimeout(r, waitSec * 1000));
            hfReasons.rateLimited++; return null;
        }
        if (res.status === 404) { hfReasons.notFound++; return null; }
        if (!res.ok) { hfReasons.networkError++; return null; }
        const text = await res.text();
        if (text.length < 200) { hfReasons.tooShort++; return null; }
        hfReasons.ok++;
        return text;
    } catch { hfReasons.networkError++; return null; }
}
