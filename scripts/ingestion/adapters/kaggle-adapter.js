/**
 * Kaggle Adapter
 * 
 * B.1 New Data Source Integration
 * Fetches datasets and models from Kaggle API
 * 
 * API: GET https://www.kaggle.com/api/v1/datasets/list
 *      GET https://www.kaggle.com/api/v1/models/list
 * Expected: +200K datasets/models
 * 
 * Auth: Requires KAGGLE_USERNAME + KAGGLE_KEY
 * 
 * @module ingestion/adapters/kaggle-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const KAGGLE_API_BASE = 'https://www.kaggle.com/api/v1';

/**
 * Kaggle Adapter Implementation
 */
export class KaggleAdapter extends BaseAdapter {
    constructor() {
        super('kaggle');
        this.entityTypes = ['dataset', 'model'];
        this.username = process.env.KAGGLE_USERNAME;
        this.apiKey = process.env.KAGGLE_KEY;
    }

    /**
     * Get auth headers (Basic Auth)
     */
    getHeaders() {
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Free2AITools/1.0'
        };

        if (this.username && this.apiKey) {
            const auth = Buffer.from(`${this.username}:${this.apiKey}`).toString('base64');
            headers['Authorization'] = `Basic ${auth}`;
        }

        return headers;
    }

    /**
     * Fetch datasets and models from Kaggle
     * @param {Object} options
     * @param {number} options.limit - Number of entities to fetch (default: 10000)
     */
    async fetch(options = {}) {
        const { limit = 10000 } = options;

        if (!this.username || !this.apiKey) {
            console.warn('⚠️ [Kaggle] No credentials (KAGGLE_USERNAME + KAGGLE_KEY), skipping');
            return [];
        }

        console.log(`📥 [Kaggle] Fetching up to ${limit} entities...`);

        // V14.5.2: Split between datasets (70%) and models (30%)
        const datasetLimit = Math.ceil(limit * 0.7);
        const modelLimit = Math.floor(limit * 0.3);

        const [datasets, models] = await Promise.all([
            this.fetchDatasets(datasetLimit),
            this.fetchModels(modelLimit)
        ]);

        const all = [...datasets, ...models];
        console.log(`✅ [Kaggle] Total: ${all.length} entities (${datasets.length} datasets, ${models.length} models)`);
        return all;
    }

    /**
     * Fetch datasets from Kaggle
     */
    async fetchDatasets(limit) {
        console.log(`   📦 Fetching datasets (limit: ${limit})...`);
        const allDatasets = [];
        let page = 1;

        while (allDatasets.length < limit) {
            const url = `${KAGGLE_API_BASE}/datasets/list?sortBy=hottest&page=${page}&pageSize=20`;

            try {
                const response = await fetch(url, { headers: this.getHeaders() });

                if (!response.ok) {
                    if (response.status === 429) {
                        console.warn('   ⚠️ Rate limited, waiting 60s...');
                        await this.delay(60000);
                        continue;
                    }
                    if (response.status === 401) {
                        console.error('   ❌ Auth failed - check KAGGLE_USERNAME/KAGGLE_KEY');
                        break;
                    }
                    throw new Error(`Kaggle API error: ${response.status}`);
                }

                const datasets = await response.json();

                if (!datasets || datasets.length === 0) {
                    console.log('   No more datasets');
                    break;
                }

                // Filter safe datasets
                const safe = datasets.filter(d => this.isSafeForWork(d));
                allDatasets.push(...safe);

                console.log(`   Page ${page}: ${safe.length}/${datasets.length} datasets (total: ${allDatasets.length})`);

                page++;
                await this.delay(2000); // Rate limiting

            } catch (error) {
                console.error(`   ❌ Error: ${error.message}`);
                break;
            }
        }

        // Return raw entities with _entityType marker for normalize()
        return allDatasets.slice(0, limit).map(d => ({ ...d, _entityType: 'dataset' }));
    }

    /**
     * Fetch models from Kaggle
     * V14.5.2: Kaggle Models API requires search parameter
     */
    async fetchModels(limit) {
        console.log(`   🤖 Fetching models (limit: ${limit})...`);
        const allModels = [];

        // V14.5.2: Kaggle Models API needs search terms to return results
        // API returns 400 without search parameter
        const searchTerms = ['llm', 'transformer', 'bert', 'gpt', 'diffusion', 'stable-diffusion', 'llama', 'gemma'];
        const perTermLimit = Math.ceil(limit / searchTerms.length);

        for (const term of searchTerms) {
            if (allModels.length >= limit) break;

            let page = 1;
            const termModels = [];

            while (termModels.length < perTermLimit && page <= 5) {
                // V14.5.2: Add search parameter required by Kaggle Models API
                const url = `${KAGGLE_API_BASE}/models/list?search=${encodeURIComponent(term)}&page=${page}&pageSize=20`;

                try {
                    const response = await fetch(url, { headers: this.getHeaders() });

                    if (!response.ok) {
                        if (response.status === 404 || response.status === 400) {
                            console.log(`   Models search '${term}' not available`);
                            break;
                        }
                        if (response.status === 429) {
                            console.warn('   ⚠️ Rate limited, waiting 60s...');
                            await this.delay(60000);
                            continue;
                        }
                        break;
                    }

                    const models = await response.json();
                    if (!models || models.length === 0) break;

                    const safe = models.filter(m => this.isSafeForWork(m));
                    termModels.push(...safe);
                    page++;
                    await this.delay(2000);

                } catch (error) {
                    console.warn(`   ⚠️ Models search '${term}' error: ${error.message}`);
                    break;
                }
            }

            console.log(`   Search '${term}': ${termModels.length} models`);
            allModels.push(...termModels);
        }

        // Deduplicate by model ID
        const seen = new Set();
        const unique = allModels.filter(m => {
            const id = m.id || m.ref || m.name;
            if (seen.has(id)) return false;
            seen.add(id);
            return true;
        });

        console.log(`   📊 Total unique models: ${unique.length}`);

        // Return raw entities with _entityType marker for normalize()
        return unique.slice(0, limit).map(m => ({ ...m, _entityType: 'model' }));
    }

    /**
     * Check NSFW content
     */
    isSafeForWork(item) {
        const text = `${item.title || ''} ${item.subtitle || ''} ${item.description || ''}`.toLowerCase();
        return !NSFW_KEYWORDS.some(kw => text.includes(kw));
    }

    /**
     * Override normalize() - delegates based on entity type marker
     * Items from fetchDatasets have _entityType='dataset', fetchModels have _entityType='model'
     */
    normalize(raw) {
        if (raw._entityType === 'model') {
            return this.normalizeModel(raw);
        }
        return this.normalizeDataset(raw);
    }

    /**
     * Normalize Kaggle dataset to UnifiedEntity
     */
    normalizeDataset(dataset) {
        const ref = dataset.ref || `${dataset.ownerRef}/${dataset.slug}`;

        return {
            id: `kaggle:dataset:${ref}`,
            source: 'kaggle',
            entity_type: 'dataset',
            name: dataset.title || dataset.slug,
            author: dataset.ownerRef || dataset.ownerName,
            description: dataset.subtitle || '',
            source_url: `https://www.kaggle.com/datasets/${ref}`,

            // Metrics
            downloads: dataset.downloadCount || 0,
            likes: dataset.voteCount || 0,

            // Metadata
            tags: dataset.tags || [],
            license: dataset.licenseName,
            primary_category: 'dataset',

            // Timestamps
            created_at: dataset.createdDate,
            last_modified: dataset.lastUpdated,

            // Full metadata
            meta_json: {
                size: dataset.totalBytes,
                usability: dataset.usabilityRating,
                views: dataset.viewCount,
                kernels: dataset.kernelCount,
                topics: dataset.topicCount
            },

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Normalize Kaggle model to UnifiedEntity
     */
    normalizeModel(model) {
        const ref = model.ref || `${model.owner}/${model.slug}`;

        return {
            id: `kaggle:model:${ref}`,
            source: 'kaggle',
            entity_type: 'model',
            name: model.title || model.slug,
            author: model.owner,
            description: model.subtitle || '',
            source_url: `https://www.kaggle.com/models/${ref}`,

            downloads: model.downloadCount || 0,
            likes: model.voteCount || 0,

            tags: model.tags || [],
            license: model.licenseName,
            primary_category: this.inferCategory(model),

            created_at: model.createdDate,
            last_modified: model.lastUpdated,

            meta_json: {
                framework: model.framework,
                instances: model.instanceCount,
                variations: model.variationCount
            },

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Infer category from model
     */
    inferCategory(model) {
        const text = `${model.title || ''} ${model.subtitle || ''}`.toLowerCase();

        if (text.includes('llm') || text.includes('language')) return 'text-generation';
        if (text.includes('image') || text.includes('vision')) return 'image-classification';
        if (text.includes('audio') || text.includes('speech')) return 'audio';

        return 'other';
    }
}

export default KaggleAdapter;
