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
     * V14.5.2: Uses Python sidecar since REST API is deprecated (2025H2)
     */
    async fetchModels(limit) {
        console.log(`   🤖 Fetching models via Python sidecar (limit: ${limit})...`);

        // V14.5.2: Kaggle REST API is deprecated, use Python CLI wrapper
        const { spawn } = await import('child_process');
        const path = await import('path');
        const fs = await import('fs/promises');

        const sidecarPath = path.join(process.cwd(), 'scripts', 'sidecar', 'kaggle_models_fetch.py');
        const outputPath = path.join(process.cwd(), 'output', 'kaggle_models_temp.json');

        try {
            // Check if sidecar script exists
            await fs.access(sidecarPath);

            // Run Python sidecar
            const result = await new Promise((resolve, reject) => {
                const proc = spawn('python', [sidecarPath, '--limit', String(limit), '--output', outputPath], {
                    env: { ...process.env },
                    stdio: ['ignore', 'pipe', 'pipe']
                });

                let stderr = '';
                proc.stderr.on('data', (data) => {
                    stderr += data.toString();
                    // Print progress to console
                    process.stderr.write(data);
                });

                proc.on('close', (code) => {
                    if (code === 0) {
                        resolve({ success: true });
                    } else {
                        reject(new Error(`Sidecar exited with code ${code}: ${stderr}`));
                    }
                });

                proc.on('error', (err) => reject(err));

                // Timeout after 5 minutes
                setTimeout(() => {
                    proc.kill();
                    reject(new Error('Sidecar timeout'));
                }, 5 * 60 * 1000);
            });

            // Read output file
            const data = await fs.readFile(outputPath, 'utf-8');
            const models = JSON.parse(data);

            // Cleanup temp file
            await fs.unlink(outputPath).catch(() => { });

            console.log(`   ✅ Sidecar returned ${models.length} models`);
            return models.slice(0, limit);

        } catch (error) {
            console.warn(`   ⚠️ Python sidecar failed: ${error.message}`);
            console.log('   Falling back to datasets-only mode (models API deprecated)');
            return [];
        }
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
