/**
 * Daily Report AI Module V1.0
 * Extracted from daily-report.js to comply with CES Art 5.1
 */

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';

// V25.8 Titan Armor V3: Exponential backoff + circuit breaker
const TITAN_CONFIG = {
    STAGGER_DELAY_MS: 35000,    // 35s mandatory delay between AI tasks
    BACKOFF_BASE_MS: 10000,     // 10s initial backoff
    BACKOFF_MULTIPLIER: 2,      // Doubles: 10s, 20s, 40s
    MAX_RETRIES: 3,
    CIRCUIT_BREAKER_THRESHOLD: 5,
};

let _consecutiveFailures = 0;

/**
 * V25.8: Physical staggering delay between AI tasks.
 */
export async function enforceStaggerDelay() {
    console.log(`[AI] V25.8: Enforcing ${TITAN_CONFIG.STAGGER_DELAY_MS / 1000}s stagger delay...`);
    await new Promise(resolve => setTimeout(resolve, TITAN_CONFIG.STAGGER_DELAY_MS));
}

/**
 * V25.8 Titan V3: Retry with exponential backoff.
 */
async function fetchWithTitan(url, options, attempt = 0) {
    if (_consecutiveFailures >= TITAN_CONFIG.CIRCUIT_BREAKER_THRESHOLD) {
        console.error(`[AI] Circuit breaker OPEN: ${_consecutiveFailures} consecutive failures. Aborting.`);
        return null;
    }

    // V25.8 §4.2: Jittered Ingestion — 0-3s random delay on external requests
    const jitterMs = Math.floor(Math.random() * 3000);
    if (jitterMs > 0) await new Promise(r => setTimeout(r, jitterMs));

    try {
        const response = await fetch(url, options);

        if (response.status === 429 && attempt < TITAN_CONFIG.MAX_RETRIES) {
            const backoffMs = TITAN_CONFIG.BACKOFF_BASE_MS * Math.pow(TITAN_CONFIG.BACKOFF_MULTIPLIER, attempt);
            console.warn(`[AI] 429 Rate Limited. Backoff ${backoffMs / 1000}s (attempt ${attempt + 1}/${TITAN_CONFIG.MAX_RETRIES})...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            return fetchWithTitan(url, options, attempt + 1);
        }

        if (response.ok) {
            _consecutiveFailures = 0;
            return response;
        }

        _consecutiveFailures++;
        console.warn(`[AI] API error: ${response.status} (failures: ${_consecutiveFailures})`);
        return null;
    } catch (e) {
        _consecutiveFailures++;
        console.warn(`[AI] Network error: ${e.message} (failures: ${_consecutiveFailures})`);
        if (attempt < TITAN_CONFIG.MAX_RETRIES) {
            const backoffMs = TITAN_CONFIG.BACKOFF_BASE_MS * Math.pow(TITAN_CONFIG.BACKOFF_MULTIPLIER, attempt);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
            return fetchWithTitan(url, options, attempt + 1);
        }
        return null;
    }
}

/**
 * Generate AI content using Gemini
 */
export async function generateAIContent(topEntities) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn('[AI] GEMINI_API_KEY not set, using fallback template');
        return null;
    }

    const top3 = topEntities.slice(0, 3).map((e, i) =>
        `${i + 1}. ${e.name} (FNI: ${e.fni_score?.toFixed(1) || 'N/A'}, type: ${e.type || 'model'})`
    ).join('\n');

    const systemInstruction = `You are the lead AI analyst at a top-tier tech consulting firm (e.g., Gartner/McKinsey), representing the free2aitools brand.
Your style must be professional, objective, data-driven, and hardcore.
Mandatory use of high-frequency industry terminology (e.g., RAG, Agentic Workflows, Inference Scaling, KV Cache, Mixture of Experts).
You must act as a strict data formatter. Return ONLY valid JSON.`;

    const prompt = `Based on the following data, generate today's artificial intelligence industry insight report.

Top 3 entities today:
${top3}

A total of ${topEntities.length} high-value entities made it to today's list.

Strict Requirements:
1. title: MUST use exactly this format: "free2aitools Daily Report: [Core Tech Breakthrough/Trend Keyword]". Example: "free2aitools Daily Report: DeepSeek-V3 Architecture Analysis & Long-Context Reasoning Breakthrough"
2. subtitle: 15-25 words, summarizing today's core data points and advancements.
3. summary: 100-150 words. Your analysis must contain three parts: (1) Objective summary of today's major breakthroughs, (2) Industry Implications, (3) Technical Outlook.
4. Explicitly point out what changed compared to "yesterday" and cite specific model/paper names.

Return exactly this JSON format:
{"title": "...", "subtitle": "...", "summary": "..."}`;

    try {
        // V25.8: Titan V3 replaces the old 4.1s throttle with 35s stagger + exponential backoff
        await enforceStaggerDelay();

        const response = await fetchWithTitan(
            `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    contents: [{ parts: [{ text: prompt }] }],
                    generationConfig: {
                        temperature: 0.2,
                        maxOutputTokens: 512,
                        responseMimeType: 'application/json'
                    }
                })
            }
        );

        if (!response) {
            return null;
        }

        const data = await response.json();
        let aiContent = null;
        try {
            const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
            let cleanText = rawText.trim();
            // RISK-R1: Reject empty, blocked, or non-JSON responses from Gemini
            if (!cleanText || cleanText.length < 10) {
                console.warn(`[AI] Empty/blocked response (${cleanText.length} chars). Rejecting.`);
                return null;
            }
            if (cleanText.startsWith('```')) {
                const match = cleanText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                if (match) cleanText = match[1];
            }
            aiContent = JSON.parse(cleanText);
        } catch (parseError) {
            console.warn(`[AI] JSON parse failed: ${parseError.message}`);
            return null;
        }

        // RISK-R1: Validate required fields exist and are non-empty
        if (!aiContent?.title || !aiContent?.summary || aiContent.summary.length < 50) {
            console.warn(`[AI] Content validation failed: missing or truncated fields. Rejecting.`);
            return null;
        }

        console.log(`[AI] Generated Daily Title: "${aiContent.title}"`);
        return aiContent;
    } catch (e) {
        console.warn(`[AI] Generation failed: ${e.message}`);
        return null;
    }
}
