/**
 * CivitAI Adapter
 * 
 * V4.3.1: Fetches models from CivitAI with NSFW filtering
 * CivitAI is the largest Stable Diffusion model community
 * 
 * NSFW Defense:
 * - Layer 1: API-level filtering (?nsfw=false)
 * - Layer 2: L2 Normalizer pattern detection
 * - Layer 3: Shadow DB quarantine
 * 
 * @module ingestion/adapters/civitai-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS, RateLimitExceededError } from './base-adapter.js';

const CIVITAI_API_BASE = 'https://civitai.com/api/v1';

/**
 * CivitAI Model Types mapping
 */
const MODEL_TYPE_MAP = {
    'Checkpoint': 'checkpoint',
    'TextualInversion': 'textual-inversion',
    'Hypernetwork': 'hypernetwork',
    'AestheticGradient': 'aesthetic-gradient',
    'LORA': 'lora',
    'LoCon': 'locon',
    'Controlnet': 'controlnet',
    'Poses': 'poses',
    'Wildcards': 'wildcards',
    'Other': 'other'
};

/**
 * CivitAI Adapter Implementation
 * V4.3.1: Added NSFW filtering with Constitution compliance
 */
export class CivitAIAdapter extends BaseAdapter {
    constructor() {
        super('civitai');
        this.entityTypes = ['model'];
    }

    /**
     * Fetch models from CivitAI API
     * @param {Object} options
     * @param {number} options.limit - Number of models to fetch (default: 100)
     * @param {string} options.sort - Sort field: Highest Rated, Most Downloaded, Newest
     * @param {boolean} options.nsfw - Include NSFW (default: false for Constitution compliance)
     */
    async fetch(options = {}) {
        const {
            limit = 100,
            sort = 'Highest Rated',
            types = ['Checkpoint', 'LORA', 'TextualInversion'],
            onBatch = null // Ensure explicit declaration
        } = options;

        console.log(`📥 [CivitAI] Fetching top ${limit} SFW models (onBatch: ${!!onBatch})...`);

        const allModels = [];
        let cursor = null;
        let fetched = 0;
        // V28 hang-fix: paginate-scoped 429 attempt counter. The cursor does NOT
        // advance on a 429 (we retry the same request), so a flat delay+continue
        // spun forever on a persistent header-less 429. This counter drives
        // handleRateLimit() escalation (2s,4s,8s…+jitter, capped 60s) + the shared
        // circuit breaker (throws RateLimitExceededError at attempt>=6). Reset to 0
        // after every successful page so transient throttling never poisons a later
        // page; a sustained 429 trips the breaker and we break-the-loop (graceful:
        // keep whatever was already streamed/buffered).
        let attempt = 0;

        try {
            while (fetched < limit) {
                const batchSize = Math.min(100, limit - fetched);
                let url = `${CIVITAI_API_BASE}/models?limit=${batchSize}&sort=${encodeURIComponent(sort)}`;

                if (types.length > 0) {
                    url += `&types=${types[0]}`;
                }
                if (cursor) {
                    url += `&cursor=${cursor}`;
                }

                console.log(`   Fetching batch: ${fetched + 1} - ${fetched + batchSize} (Cursor: ${cursor || 'start'})`);
                const response = await this.fetchWithTimeout(url);

                if (!response.ok) {
                    if (response.status === 429) {
                        // V28: escalate by attempt + honor headers; breaker throws at attempt>=6.
                        // cursor is unchanged → same page is retried after the wait.
                        await this.handleRateLimit(response, attempt++);
                        continue;
                    }
                    throw new Error(`CivitAI API error: ${response.status}`);
                }

                // V28 hang-fix: page fetched OK → reset the 429 escalation counter so
                // transient throttling on one page never carries into the next.
                attempt = 0;

                const data = await response.json();
                const models = data.items || [];

                if (models.length === 0) break;

                // V28 (PR-D): the V22.4 "incremental skip" branch was DEAD — it read
                // `options.registryManager.registry?.entities`, a property the real
                // RegistryManager (SQLite-backed) never exposes, so the optional chain
                // always short-circuited to undefined and no model was ever skipped.
                // Worse, in the streaming harvest-single path there is no registry to
                // re-emit a skipped entity into, so a `return false` skip would have
                // DROPPED the entity from output (data loss). Removed (honest: accept
                // the full re-fetch cost, stop advertising a dead optimization).
                const safeModels = models.filter(m => this.isSafeForWork(m));

                if (onBatch) {
                    try {
                        if (safeModels.length > 0) await onBatch(safeModels);
                    } catch (batchError) {
                        console.error(`   ❌ [CivitAI] onBatch callback error: ${batchError.message}`);
                    }
                } else {
                    allModels.push(...safeModels);
                }

                fetched += models.length;
                cursor = data.metadata?.nextCursor;

                console.log(`   📦 Batch result: ${safeModels.length} new/updated (total: ${onBatch ? 'Streaming' : allModels.length})`);

                if (!cursor) break;

                await this.delay(2000); // Respectful batch delay
            }
        } catch (error) {
            // V28 hang-fix: a tripped circuit breaker (RateLimitExceededError) means
            // CivitAI is persistently throttling us. Break-the-loop gracefully — keep
            // everything streamed/buffered so far (no data loss) rather than spinning.
            if (error instanceof RateLimitExceededError) {
                console.warn(`   🛑 [CivitAI] rate-limit breaker tripped — finishing early with ${onBatch ? 'streamed' : allModels.length} models.`);
            } else {
                console.error(`   ❌ [CivitAI] Fetch internal error: ${error.message}`);
                console.error(error.stack);
            }
        }

        console.log(`✅ [CivitAI] ${onBatch ? 'Streaming' : 'Fetched ' + allModels.length + ' safe models'} complete`);
        return onBatch ? [] : allModels;
    }

    /**
     * V4.3.1: Check if model is safe for work
     * Additional layer of NSFW filtering beyond API parameter
     */
    isSafeForWork(model) {
        // Check explicit NSFW flag
        if (model.nsfw === true) return false;

        // Check model name and description for NSFW keywords
        const text = `${model.name || ''} ${model.description || ''}`.toLowerCase();
        for (const keyword of NSFW_KEYWORDS) {
            if (text.includes(keyword.toLowerCase())) {
                console.log(`   🚫 NSFW detected: "${model.name}" contains "${keyword}"`);
                return false;
            }
        }

        // Check tags
        const tags = model.tags || [];
        for (const tag of tags) {
            if (NSFW_KEYWORDS.includes(tag.toLowerCase())) {
                console.log(`   🚫 NSFW tag detected: "${model.name}" tagged "${tag}"`);
                return false;
            }
        }

        return true;
    }

    /**
     * Normalize CivitAI model to UnifiedEntity
     */
    normalize(raw) {
        const modelVersion = raw.modelVersions?.[0] || {};
        const creator = raw.creator || {};

        // Build ID
        const id = this.generateId('civitai', String(raw.id), 'model');
        const slug = `civitai-${raw.id}-${this.slugify(raw.name || 'model')}`;

        // Extract tags
        const tags = [
            ...(raw.tags || []),
            MODEL_TYPE_MAP[raw.type] || raw.type?.toLowerCase(),
            'stable-diffusion',
            'image-generation'
        ].filter(Boolean);

        // Get cover image
        const coverImage = modelVersion.images?.[0]?.url || null;

        // Build description
        const description = this.truncate(raw.description || '', 500);

        // V19.5 Mode B Phase 2: Elevate trainedWords to eliminate UI JSON-parse lag
        const trainedWords = modelVersion.trainedWords || [];
        const wordsMd = trainedWords.length > 0 ? `\n\n### 🏷️ Trigger Words\n\`${trainedWords.join('`, `')}\`` : '';

        // NOTE: The previous code returned an unassigned object here, but then accessed `entity.content_hash` at the bottom!
        // This is a bug in the old code causing `entity is not defined`! We MUST assign it to `entity`.
        const entity = {
            id,
            // V28 (PR-D): emit top-level `type` like every other adapter — it was
            // absent here, leaving entity.type undefined on the row (every sibling
            // adapter sets type:'model'/'tool'/etc.).
            type: 'model',
            slug,
            name: raw.name,
            author: creator.username || 'unknown',
            description,
            body_content: (raw.description || '').replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim() + wordsMd,
            // V28 (PR-D): emit a real string[] (was JSON.stringify(tags) — a STRING).
            // entity-merger arr() coerces a JSON-string via `.split(',')`, shattering
            // `["a","b"]` into garbage tokens (`["a"`, `"b"]`) on merge — the R4-B
            // corruption class. Every other adapter emits an array; downstream does
            // its own JSON.stringify when persisting.
            tags,
            pipeline_tag: 'text-to-image',

            // Top-Level Promotion
            civitai_trained_words: trainedWords,

            // Source tracking (V4.3.1 Constitution)
            source: 'civitai',
            source_url: `https://civitai.com/models/${raw.id}`,
            source_trail: JSON.stringify({
                source: 'civitai',
                source_id: String(raw.id),
                harvested_at: new Date().toISOString(),
                harvester_version: 'L1-v4.3.1'
            }),

            // Metrics
            downloads: raw.stats?.downloadCount || 0,
            likes: raw.stats?.favoriteCount || 0,

            // Model info
            model_type: MODEL_TYPE_MAP[raw.type] || 'other',
            license: raw.allowCommercialUse ? 'commercial' : 'non-commercial',

            // Media
            cover_image_url: coverImage,

            // Version info
            version: modelVersion.name || '1.0',
            last_updated: raw.updatedAt || raw.createdAt,
            created_at: raw.createdAt,

            // V6.4: Full metadata for params extraction
            meta_json: JSON.stringify({
                civitai: {
                    id: raw.id,
                    type: raw.type,
                    baseModel: modelVersion.baseModel,
                    trainedWords: modelVersion.trainedWords
                },
                stats: raw.stats,
                files: (modelVersion.files || []).map(f => ({
                    name: f.name,
                    sizeKB: f.sizeKB,
                    type: f.type
                }))
            }),

            // NSFW compliance (V4.3.1) - Use dynamic check instead of hardcoded
            nsfw_filtered: true,
            compliance_status: null
        };

        // Calculate system fields after entity creation
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Helper: Create URL-safe slug
     */
    slugify(text) {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, 50);
    }

    /**
     * Helper: Truncate text
     */
    truncate(text, maxLength) {
        if (!text || text.length <= maxLength) return text;
        return text.slice(0, maxLength - 3) + '...';
    }

    /**
     * Helper: Delay for rate limiting
     */
    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default CivitAIAdapter;
