/**
 * Titan Fetch V3.1 — Shared AI API Client with Hardened Retry Logic
 *
 * Unified entry point for all Gemini API calls.
 * Features: Full Jitter backoff, 429 + 5xx retry, AbortController timeout,
 * response body error logging, shared circuit breaker, safety settings.
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const GEMINI_FALLBACK_MODEL = 'gemini-2.5-pro';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

const TITAN_CONFIG = {
    STAGGER_DELAY_MS: 30000,
    BACKOFF_BASE_MS: 10000,
    MAX_RETRIES: 3,
    CIRCUIT_BREAKER_THRESHOLD: 10,
    FETCH_TIMEOUT_MS: 60000,
};

// Shared circuit breaker (singleton across daily-report-ai + knowledge-ai)
let _consecutiveFailures = 0;

/** Full Jitter: random(0, base * 2^attempt) — prevents thundering herd */
function fullJitterDelay(attempt) {
    const ceiling = TITAN_CONFIG.BACKOFF_BASE_MS * Math.pow(2, attempt);
    return Math.floor(Math.random() * ceiling);
}

/**
 * V25.8: Mandatory stagger delay between AI tasks.
 */
export async function enforceStaggerDelay() {
    console.log(`[TITAN] Enforcing ${TITAN_CONFIG.STAGGER_DELAY_MS / 1000}s stagger delay...`);
    await new Promise(resolve => setTimeout(resolve, TITAN_CONFIG.STAGGER_DELAY_MS));
}

/**
 * Gemini safety settings — BLOCK_ONLY_HIGH prevents false rejections
 * on technical AI content without fully disabling safety.
 */
function getSafetySettings() {
    const categories = [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
    ];
    return categories.map(category => ({ category, threshold: 'BLOCK_ONLY_HIGH' }));
}

/**
 * Titan V3.1: Fetch with Full Jitter backoff, 429/5xx retry, timeout, error logging.
 * @param {string} url
 * @param {object} options - fetch options
 * @param {number} attempt - current retry attempt (internal)
 * @returns {Response|null}
 */
async function fetchWithTitan(url, options, attempt = 0) {
    if (_consecutiveFailures >= TITAN_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
        console.error(`[TITAN] Circuit breaker OPEN: ${_consecutiveFailures} consecutive failures. Aborting all AI calls.`);
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TITAN_CONFIG.FETCH_TIMEOUT_MS);

    try {
        // Full Jitter delay (replaces fixed jitter + fixed backoff)
        if (attempt > 0) {
            const delay = fullJitterDelay(attempt);
            console.log(`[TITAN] Retry ${attempt}/${TITAN_CONFIG.MAX_RETRIES} after ${(delay / 1000).toFixed(1)}s jittered backoff...`);
            await new Promise(r => setTimeout(r, delay));
        }

        const response = await fetch(url, { ...options, signal: controller.signal });

        // Retryable status codes: 429 (rate limit), 500, 502, 503 (transient server errors)
        const retryable = [429, 500, 502, 503];
        if (retryable.includes(response.status)) {
            let errorDetail = '';
            try { errorDetail = await response.text(); } catch { }
            // Quota exceeded = daily/monthly limit → retrying is pointless, fail fast to fallback
            if (response.status === 429 && errorDetail.includes('exceeded your current quota')) {
                _consecutiveFailures++;
                console.warn(`[TITAN] Quota exceeded (not retryable). Failing fast to next model.`);
                return null;
            }
            if (attempt < TITAN_CONFIG.MAX_RETRIES) {
                console.warn(`[TITAN] ${response.status} (retryable). Detail: ${errorDetail.substring(0, 200)}`);
                return fetchWithTitan(url, options, attempt + 1);
            }
        }

        if (response.ok) {
            _consecutiveFailures = 0;
            return response;
        }

        // Non-retryable error — log response body for debugging
        _consecutiveFailures++;
        let errorBody = '';
        try { errorBody = await response.text(); } catch { }
        console.error(`[TITAN] API error ${response.status} (failures: ${_consecutiveFailures}). Body: ${errorBody.substring(0, 300)}`);
        return null;
    } catch (e) {
        _consecutiveFailures++;
        const reason = e.name === 'AbortError' ? `Timeout (${TITAN_CONFIG.FETCH_TIMEOUT_MS / 1000}s)` : e.message;
        console.warn(`[TITAN] Fetch error: ${reason} (failures: ${_consecutiveFailures})`);
        if (attempt < TITAN_CONFIG.MAX_RETRIES) {
            return fetchWithTitan(url, options, attempt + 1);
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Call Gemini generateContent API with Titan hardening.
 * @param {object} params - { systemInstruction, prompt, temperature, maxOutputTokens }
 * @returns {object|null} Parsed JSON response or null on failure
 */
export async function callGemini({ systemInstruction, prompt, temperature = 0.2, maxOutputTokens = 512 }) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('[TITAN] GEMINI_API_KEY not set. Skipping AI generation.');
        return null;
    }

    await enforceStaggerDelay();

    const body = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens, responseMimeType: 'application/json' },
        safetySettings: getSafetySettings(),
    };

    if (systemInstruction) {
        body.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const fetchOpts = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };

    // Try primary model, fallback on failure
    let response = await fetchWithTitan(
        `${GEMINI_BASE}/${GEMINI_MODEL}:generateContent?key=${apiKey}`, fetchOpts
    );

    if (!response && GEMINI_FALLBACK_MODEL && GEMINI_FALLBACK_MODEL !== GEMINI_MODEL) {
        console.warn(`[TITAN] Primary model ${GEMINI_MODEL} failed. Trying fallback: ${GEMINI_FALLBACK_MODEL}`);
        _consecutiveFailures = Math.max(0, _consecutiveFailures - 1);
        response = await fetchWithTitan(
            `${GEMINI_BASE}/${GEMINI_FALLBACK_MODEL}:generateContent?key=${apiKey}`, fetchOpts
        );
    }

    if (!response) return null;

    try {
        const data = await response.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
        let clean = rawText.trim();

        if (!clean || clean.length < 10) {
            console.warn(`[TITAN] Empty/blocked response (${clean.length} chars). Rejecting.`);
            return null;
        }

        // Strip markdown code fences if present (defense-in-depth)
        if (clean.startsWith('```')) {
            const match = clean.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (match) clean = match[1];
        }

        // V25.8.5: Repair common Gemini JSON malformations before parsing
        try { return JSON.parse(clean); } catch (_firstErr) {
            const repaired = clean
                .replace(/,\s*([}\]])/g, '$1')                   // trailing commas
                .replace(/(['"])?(\w+)(['"])?\s*:/g, '"$2":')     // unquoted/single-quoted keys
                .replace(/:\s*'([^']*)'/g, ': "$1"')              // single-quoted values
                .replace(/\/\/[^\n]*/g, '')                       // line comments
                .replace(/\/\*[\s\S]*?\*\//g, '');                // block comments
            return JSON.parse(repaired);
        }
    } catch (e) {
        console.warn(`[TITAN] Response parse failed: ${e.message}`);
        return null;
    }
}

/** Reset circuit breaker (for testing) */
export function resetCircuitBreaker() { _consecutiveFailures = 0; }
