/**
 * ModelScope Adapter
 * 
 * V4.3.1: Fetches models from Alibaba ModelScope
 * ModelScope is China's largest open-source AI model platform
 * 
 * Features:
 * - Alibaba DAMO Academy models
 * - Large collection of Chinese language models
 * - Multi-modal models
 * 
 * @module ingestion/adapters/modelscope-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const MODELSCOPE_API_BASE = 'https://www.modelscope.ai/api/v1';

/**
 * ModelScope Task Type mapping
 */
const TASK_TYPE_MAP = {
    'text-generation': 'text-generation',
    'text-classification': 'text-classification',
    'token-classification': 'token-classification',
    'question-answering': 'question-answering',
    'translation': 'translation',
    'summarization': 'summarization',
    'text-to-image': 'text-to-image',
    'image-to-text': 'image-to-text',
    'image-classification': 'image-classification',
    'object-detection': 'object-detection',
    'image-segmentation': 'image-segmentation',
    'speech-recognition': 'automatic-speech-recognition',
    'text-to-speech': 'text-to-speech',
    'audio-classification': 'audio-classification',
    'video-classification': 'video-classification',
    'multimodal': 'multimodal'
};

/**
 * ModelScope Adapter Implementation
 * V4.3.1: Full support for Chinese model ecosystem
 */
export class ModelScopeAdapter extends BaseAdapter {
    constructor() {
        super('modelscope');
        this.entityTypes = ['model'];
    }

    /**
     * Fetch models from ModelScope API
     * Note: ModelScope may require authentication for full API access
     * This implementation uses their public model hub endpoint
     * @param {Object} options
     * @param {number} options.limit - Number of models to fetch (default: 100)
     * @param {string} options.sortBy - Sort field: Downloads, Stars, UpdateTime
     */
    async fetch(options = {}) {
        const {
            limit = 100,
            sortBy = 'downloads',
            page = 1
        } = options;

        console.log(`📥 [ModelScope] Fetching top ${limit} models by ${sortBy}...`);

        const allModels = [];
        let currentPage = page;
        const pageSize = Math.min(20, limit);

        // Try different API endpoints
        const endpoints = [
            `https://www.modelscope.ai/api/v1/models?page=${currentPage}&page_size=${pageSize}&sort=${sortBy}`,
            `https://www.modelscope.ai/api/v1/hub/models?page=${currentPage}&page_size=${pageSize}`,
        ];

        while (allModels.length < limit) {
            let success = false;

            for (const baseUrl of endpoints) {
                const url = baseUrl.replace('page=1', `page=${currentPage}`);

                try {
                    console.log(`   Fetching page ${currentPage}...`);

                    // V6.2: Add token authentication if available
                    const headers = {
                        'Accept': 'application/json',
                        'User-Agent': 'Free2AITools/1.0'
                    };
                    if (process.env.MODELSCOPE_API_TOKEN) {
                        headers['Authorization'] = `Bearer ${process.env.MODELSCOPE_API_TOKEN}`;
                        if (currentPage === 1) {
                            console.log(`   🔑 Using authenticated requests (MODELSCOPE_API_TOKEN)`);
                        }
                    }

                    const response = await fetch(url, { headers });

                    if (!response.ok) {
                        if (response.status === 429) {
                            console.warn('   ⚠️ Rate limited, waiting 30s...');
                            await this.delay(30000);
                            continue;
                        }
                        throw new Error(`ModelScope API error: ${response.status}`);
                    }

                    const data = await response.json();
                    const models = data.Data?.Models || data.models || [];

                    if (models.length === 0) break;

                    // Filter safe models
                    const safeModels = models.filter(m => this.isSafeForWork(m));
                    allModels.push(...safeModels);

                    console.log(`   📦 Got ${safeModels.length}/${models.length} models`);

                    if (models.length < pageSize) break;

                    currentPage++;

                    // Rate limiting - V4.3.1 Constitution: Be respectful to source APIs
                    // ModelScope recommended: 2 seconds between requests
                    await this.delay(2000);

                } catch (error) {
                    console.error(`   ❌ Fetch error: ${error.message}`);
                    break;
                }
            }

            console.log(`✅ [ModelScope] Fetched ${allModels.length} models`);
            return allModels.slice(0, limit);
        }

        console.log(`✅ [ModelScope] Fetched ${allModels.length} models`);
        return allModels.slice(0, limit);
    }

    /**
     * V4.3.1: Check if model is safe for work
     */
    isSafeForWork(model) {
        const text = `${model.Name || ''} ${model.Description || ''} ${model.ChineseName || ''}`.toLowerCase();

        for (const keyword of NSFW_KEYWORDS) {
            if (text.includes(keyword.toLowerCase())) {
                return false;
            }
        }

        // Check tags if present
        const tags = model.Tags || [];
        for (const tag of tags) {
            const tagName = typeof tag === 'string' ? tag : tag.Name || '';
            if (NSFW_KEYWORDS.includes(tagName.toLowerCase())) {
                return false;
            }
        }

        return true;
    }

    /**
     * Normalize ModelScope model to UnifiedEntity
     */
    normalize(raw) {
        // Build ID
        const modelPath = raw.Path || raw.Name || `${raw.Namespace}/${raw.Name}`;
        const id = `modelscope:${modelPath}`;
        const slug = `modelscope-${this.slugify(modelPath)}`;

        // Extract tags
        const rawTags = raw.Tags || [];
        const tags = rawTags.map(t => typeof t === 'string' ? t : t.Name).filter(Boolean);
        tags.push('modelscope');
        if (raw.ChineseName) tags.push('chinese');

        // Determine pipeline_tag
        const taskType = raw.Task || raw.Tasks?.[0] || 'unknown';
        const pipelineTag = TASK_TYPE_MAP[taskType] || taskType;

        // Get cover image
        const coverImage = raw.CoverUrl || raw.Avatar || null;

        // Build description (prefer English, fallback to Chinese)
        const description = this.truncate(
            raw.Description || raw.ChineseDescription || raw.Summary || '',
            500
        );

        return {
            id,
            slug,
            name: raw.Name || raw.ChineseName,
            author: raw.Namespace || raw.Owner || 'modelscope',
            description,
            body_content: raw.Description || raw.ChineseDescription || '',
            tags: JSON.stringify(tags),
            pipeline_tag: pipelineTag,

            // Source tracking (V4.3.1 Constitution)
            source: 'modelscope',
            source_url: `https://modelscope.cn/models/${modelPath}`,
            source_trail: JSON.stringify({
                source: 'modelscope',
                source_id: modelPath,
                harvested_at: new Date().toISOString(),
                harvester_version: 'L1-v4.3.1'
            }),

            // Metrics
            downloads: raw.Downloads || raw.DownloadCount || 0,
            likes: raw.Stars || raw.Likes || 0,

            // Model info
            license: raw.License || 'apache-2.0',

            // Media
            cover_image_url: coverImage,

            // Version info
            last_updated: raw.UpdateTime || raw.LastModifiedTime,
            created_at: raw.CreatedTime,

            // Chinese model flag
            is_chinese: !!raw.ChineseName,
            chinese_name: raw.ChineseName || null,

            // Compliance
            compliance_status: 'approved'
        };
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

export default ModelScopeAdapter;
