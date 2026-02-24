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
import { execSync } from 'child_process';

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
    /**
     * Fetch datasets and models from Kaggle
     * @param {Object} options
     * @param {number} options.limit - Number of entities to fetch (default: 10000)
     */
    async fetch(options = {}) {
        const { limit = 10000, onBatch } = options;

        if (!this.username || !this.apiKey) {
            console.warn('⚠️ [Kaggle] No credentials (KAGGLE_USERNAME + KAGGLE_KEY), skipping');
            return [];
        }

        console.log(`📥 [Kaggle] Fetching up to ${limit} entities (datasets & models)...`);

        const dLimit = Math.floor(limit / 2);
        const mLimit = limit - dLimit;

        const datasets = await this.fetchDatasets(dLimit, onBatch);
        const models = await this.fetchModels(mLimit, onBatch);

        if (onBatch) return [];

        const combined = [...datasets, ...models];
        console.log(`✅ [Kaggle] Total: ${datasets.length} datasets, ${models.length} models`);
        return combined;
    }

    /**
     * Fetch datasets from Kaggle
     */
    async fetchDatasets(limit, onBatch) {
        console.log(`   📦 Fetching datasets (limit: ${limit})...`);
        const allDatasets = [];
        let page = 1;
        const pageSize = 100; // V22.3: Increased from 20 to 100 for efficiency

        while (true) {
            const url = `${KAGGLE_API_BASE}/datasets/list?sortBy=hottest&page=${page}&pageSize=${pageSize}`;

            try {
                const response = await fetch(url, { headers: this.getHeaders() });

                if (!response.ok) {
                    if (response.status === 429) {
                        console.warn('   ⚠️ Rate limited, waiting 60s...');
                        await this.delay(60000);
                        continue;
                    }
                    console.error(`   ❌ Kaggle API error: ${response.status}`);
                    break;
                }

                const datasets = await response.json();
                if (!datasets || datasets.length === 0) break;

                // Filter safe datasets
                const safe = datasets.filter(d => this.isSafeForWork(d));
                const marked = safe.map(d => ({ ...d, _entityType: 'dataset' }));

                if (onBatch) {
                    await onBatch(marked);
                } else {
                    allDatasets.push(...marked);
                }

                console.log(`   Page ${page}: +${safe.length} datasets (total: ${onBatch ? 'Streaming' : allDatasets.length})`);

                if (!onBatch && allDatasets.length >= limit) break;

                // Safety: Stop if we are making too many requests
                if (page > 100) break;

                page++;
                await this.delay(1000); // Respectful delay

            } catch (error) {
                console.error(`   ❌ Error: ${error.message}`);
                break;
            }
        }

        return onBatch ? [] : allDatasets.slice(0, limit);
    }

    /**
     * Fetch models from Kaggle
     */
    async fetchModels(limit, onBatch) {
        console.log(`   🤖 Fetching models (limit: ${limit}) via Kaggle CLI Sidecar...`);
        const allModels = [];
        let page = 1;
        const pageSize = 100;

        while (true) {
            try {
                // V22.3: Multi-page CLI pagination
                const command = `kaggle models list --page-size ${pageSize} --page ${page}`;
                const output = execSync(command, { encoding: 'utf-8', env: { ...process.env, KAGGLE_USERNAME: this.username, KAGGLE_KEY: this.apiKey } });

                if (!output || output.includes('No models found')) break;

                // Parse Kaggle's table output
                const lines = output.split('\n').filter(l => l.trim() && !l.includes('---'));
                if (lines.length < 2) break;

                const models = [];
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i];
                    const parts = line.split(/\s{2,}/);
                    if (parts.length < 2) continue;

                    const ref = parts[0].trim();
                    const title = parts[1]?.trim() || '';

                    models.push({
                        ref,
                        title,
                        slug: ref.split('/')[1],
                        owner: ref.split('/')[0]
                    });
                }

                if (models.length === 0) break;

                const safe = models.filter(m => this.isSafeForWork(m));
                const marked = safe.map(m => ({ ...m, _entityType: 'model' }));

                if (onBatch) {
                    await onBatch(marked);
                } else {
                    allModels.push(...marked);
                }

                console.log(`   Page ${page}: +${safe.length} models (total: ${onBatch ? 'Streaming' : allModels.length})`);

                if (!onBatch && allModels.length >= limit) break;
                if (page > 50) break; // Safety cap

                page++;
                await this.delay(1000);

            } catch (error) {
                console.error(`   ❌ Kaggle CLI Error: ${error.message}`);
                break;
            }
        }

        return onBatch ? [] : allModels.slice(0, limit);
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
