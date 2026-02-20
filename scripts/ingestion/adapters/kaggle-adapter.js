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

        console.log(`📥 [Kaggle] Fetching up to ${limit} entities (datasets only)...`);

        const datasets = await this.fetchDatasets(limit);

        console.log(`✅ [Kaggle] Total: ${datasets.length} datasets`);
        return datasets;
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
     */
    async fetchModels(limit) {
        console.log(`   🤖 Fetching models (limit: ${limit})...`);
        const allModels = [];
        let page = 1;

        while (allModels.length < limit) {
            const url = `${KAGGLE_API_BASE}/models/list?sortBy=hottest&page=${page}&pageSize=20`;

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

                const models = await response.json();

                if (!models || models.length === 0) {
                    console.log('   No more models');
                    break;
                }

                // Filter safe models
                const safe = models.filter(m => this.isSafeForWork(m));
                allModels.push(...safe);

                console.log(`   Page ${page}: ${safe.length}/${models.length} models (total: ${allModels.length})`);

                page++;
                await this.delay(2000); // Rate limiting

            } catch (error) {
                console.error(`   ❌ Error: ${error.message}`);
                break;
            }
        }

        // Return raw entities with _entityType marker for normalize()
        return allModels.slice(0, limit).map(m => ({ ...m, _entityType: 'model' }));
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
        const [authorName, slugName] = ref.split('/');
        const id = this.generateId(authorName, slugName, 'dataset');

        const entity = {
            id,
            type: 'dataset',
            source: 'kaggle',
            source_url: `https://www.kaggle.com/datasets/${ref}`,
            title: dataset.title || dataset.slug,
            author: dataset.ownerRef || dataset.ownerName,
            description: dataset.subtitle || '',
            body_content: dataset.description || '',
            tags: dataset.tags || [],
            license_spdx: this.normalizeLicense(dataset.licenseName),
            meta_json: {
                size: dataset.totalBytes,
                usability: dataset.usabilityRating,
                views: dataset.viewCount,
                kernels: dataset.kernelCount,
                topics: dataset.topicCount
            },
            created_at: dataset.createdDate,
            updated_at: dataset.lastUpdated,
            popularity: dataset.voteCount || 0,
            downloads: dataset.downloadCount || 0,
            raw_image_url: null,
            relations: [],
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
        const [authorName, slugName] = ref.split('/');
        const id = this.generateId(authorName, slugName, 'model');

        const entity = {
            id,
            type: 'model',
            source: 'kaggle',
            source_url: `https://www.kaggle.com/models/${ref}`,
            title: model.title || model.slug,
            author: model.owner,
            description: model.subtitle || '',
            body_content: model.description || '',
            tags: model.tags || [],
            license_spdx: this.normalizeLicense(model.licenseName),
            pipeline_tag: this.inferCategory(model),
            created_at: model.createdDate,
            updated_at: model.lastUpdated,
            popularity: model.voteCount || 0,
            downloads: model.downloadCount || 0,
            raw_image_url: null,
            meta_json: {
                framework: model.framework,
                instances: model.instanceCount,
                variations: model.variationCount
            },
            relations: [],
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
