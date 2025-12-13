// src/utils/summary-generator.js
/**
 * AI Summary Generator V4.3.2
 * Constitution V4.3.2 Compliant - Incremental AI summary generation
 * 
 * Uses Cloudflare Workers AI @cf/meta/llama-3-8b-instruct
 * Implements rate limiting strategy per Constitution:
 * - New Arrivals: 50/day (real-time)
 * - Trending Top 100: 100/day (priority)
 * - Legacy Backfill: 500/day (background)
 * - Reserve: 350/day (buffer)
 */

// Rate Limit Configuration (Constitution V4.3.2)
const DAILY_QUOTA = 10000;
const RATE_LIMITS = {
    newArrivals: 50,      // Real-time generation for new models
    trending: 100,        // Priority completion for top models
    backfill: 500,        // Background job for legacy models
    reserve: 350          // Buffer for errors/retries
};

// Track daily usage (resets at midnight UTC)
let dailyUsage = {
    date: new Date().toISOString().split('T')[0],
    count: 0,
    errors: 0
};

/**
 * Reset daily counter if date has changed
 */
function checkDailyReset() {
    const today = new Date().toISOString().split('T')[0];
    if (dailyUsage.date !== today) {
        dailyUsage = { date: today, count: 0, errors: 0 };
    }
}

/**
 * Check if we can make an AI call based on quota
 * @param {string} category - 'newArrivals' | 'trending' | 'backfill'
 * @returns {{allowed: boolean, remaining: number}}
 */
export function checkQuota(category = 'backfill') {
    checkDailyReset();

    const limit = RATE_LIMITS[category] || RATE_LIMITS.backfill;
    const remaining = DAILY_QUOTA - dailyUsage.count;

    // Reserve buffer for emergencies
    const effectiveRemaining = remaining - RATE_LIMITS.reserve;

    return {
        allowed: effectiveRemaining > 0 && dailyUsage.count < limit,
        remaining: Math.max(0, effectiveRemaining),
        dailyCount: dailyUsage.count,
        dailyLimit: limit,
        category
    };
}

/**
 * Record an AI call usage
 * @param {boolean} success - Whether the call succeeded
 */
function recordUsage(success = true) {
    dailyUsage.count++;
    if (!success) {
        dailyUsage.errors++;
    }
}

/**
 * Generate a model summary using Cloudflare Workers AI
 * @param {Object} AI - Cloudflare AI binding
 * @param {Object} model - Model data
 * @param {string} category - Rate limit category
 * @returns {Promise<{summary: string|null, success: boolean, error?: string}>}
 */
export async function generateModelSummary(AI, model, category = 'backfill') {
    // Check quota
    const quota = checkQuota(category);
    if (!quota.allowed) {
        return {
            summary: null,
            success: false,
            error: `Daily quota exceeded (${quota.dailyCount}/${quota.dailyLimit})`
        };
    }

    if (!AI) {
        return {
            summary: null,
            success: false,
            error: 'AI binding not available'
        };
    }

    const prompt = buildSummaryPrompt(model);

    try {
        const result = await AI.run('@cf/meta/llama-3-8b-instruct', {
            messages: [
                { role: 'system', content: 'You are a helpful AI assistant that writes concise, SEO-friendly model descriptions. Keep responses under 150 words.' },
                { role: 'user', content: prompt }
            ],
            max_tokens: 200,
            temperature: 0.7
        });

        const summary = result?.response || null;
        recordUsage(true);

        return {
            summary,
            success: true,
            tokens: result?.usage?.total_tokens || 0
        };
    } catch (error) {
        recordUsage(false);
        console.error('[SummaryGenerator] AI call failed:', error.message);

        return {
            summary: null,
            success: false,
            error: error.message
        };
    }
}

/**
 * Build prompt for model summary generation
 * @param {Object} model - Model data
 * @returns {string}
 */
function buildSummaryPrompt(model) {
    const name = model.name || model.id || 'Unknown Model';
    const author = model.author || 'Unknown Author';
    const pipelineTag = model.pipeline_tag || 'AI model';
    const description = (model.description || '').slice(0, 500);

    return `Write a 150-word SEO description for the AI model "${name}" by ${author}.

Model type: ${pipelineTag}
${description ? `Original description: ${description}` : ''}

Focus on:
1. What the model does
2. Key capabilities
3. Use cases
4. Target audience

Write in third person, present tense. Be concise and informative.`;
}

/**
 * Batch generate summaries for models (respects rate limits)
 * @param {Object} AI - Cloudflare AI binding
 * @param {Array} models - Array of model objects
 * @param {string} category - Rate limit category
 * @param {Function} onProgress - Optional progress callback
 * @returns {Promise<{processed: number, succeeded: number, failed: number, results: Array}>}
 */
export async function batchGenerateSummaries(AI, models, category = 'backfill', onProgress = null) {
    const results = [];
    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const model of models) {
        const quota = checkQuota(category);
        if (!quota.allowed) {
            console.log(`[SummaryGenerator] Quota exhausted after ${processed} models`);
            break;
        }

        const result = await generateModelSummary(AI, model, category);
        results.push({ model: model.id || model.umid, ...result });

        processed++;
        if (result.success) {
            succeeded++;
        } else {
            failed++;
        }

        if (onProgress) {
            onProgress({ processed, succeeded, failed, total: models.length });
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    return { processed, succeeded, failed, results };
}

/**
 * Get current usage statistics
 * @returns {Object}
 */
export function getUsageStats() {
    checkDailyReset();
    return {
        date: dailyUsage.date,
        count: dailyUsage.count,
        errors: dailyUsage.errors,
        remaining: DAILY_QUOTA - dailyUsage.count,
        quota: DAILY_QUOTA,
        limits: RATE_LIMITS
    };
}

/**
 * Reset usage (for testing)
 */
export function resetUsage() {
    dailyUsage = {
        date: new Date().toISOString().split('T')[0],
        count: 0,
        errors: 0
    };
}

// Export constants for external use
export { DAILY_QUOTA, RATE_LIMITS };
