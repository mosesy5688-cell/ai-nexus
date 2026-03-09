/**
 * HuggingFace Datasets Adapter
 * 
 * Fetches datasets from HuggingFace Hub API with complete data:
 * - Full README/dataset card content
 * - Dataset metadata (size, format, splits)
 * - Asset extraction (sample images, visualizations)
 * - Relationship discovery (used by models)
 * 
 * @module ingestion/adapters/datasets-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';

const HF_API_BASE = 'https://huggingface.co/api';
const HF_RAW_BASE = 'https://huggingface.co';

/**
 * HuggingFace Datasets Adapter Implementation
 */
export class DatasetsAdapter extends BaseAdapter {
    constructor() {
        super('huggingface');
        this.entityTypes = ['dataset'];
    }

    /**
     * Fetch datasets from HuggingFace API
     * @param {Object} options
     * @param {number} options.limit - Number of datasets to fetch (default: 500)
     * @param {string} options.sort - Sort field (default: 'downloads')
     * @param {boolean} options.full - Fetch full details including README
     */
    async fetch(options = {}) {
        const {
            limit = 500,
            sort = 'downloads',
            direction = -1,
            full = true
        } = options;

        console.log(`📥 [HF Datasets] Fetching top ${limit} datasets by ${sort}...`);

        // V22.4: Comprehensive metadata expansion for datasets
        const expandParams = [
            'author', 'cardData', 'createdAt', 'downloads',
            'likes', 'lastModified', 'tags'
        ].map(e => `expand[]=${e}`).join('&');

        // V22.8: Paginated fetch for full coverage (HF caps single calls at ~1000)
        const pageSize = 1000;
        const datasets = [];
        for (let offset = 0; offset < limit; offset += pageSize) {
            const fetchLimit = Math.min(pageSize, limit - offset);
            const listUrl = `${HF_API_BASE}/datasets?sort=${sort}&direction=${direction}&limit=${fetchLimit}&offset=${offset}&${expandParams}`;
            const response = await fetch(listUrl);
            if (!response.ok) {
                console.warn(`   ⚠️ HF Datasets API error at offset ${offset}: ${response.status}`);
                break;
            }
            const batch = await response.json();
            if (!batch.length) break;
            datasets.push(...batch);
            console.log(`   📦 Fetched ${datasets.length} dataset listings (offset: ${offset})...`);
            if (batch.length < fetchLimit) break; // No more results
            await this.delay(500);
        }
        console.log(`📦 [HF Datasets] Got ${datasets.length} datasets from paginated list`);

        if (!full) {
            return datasets;
        }

        // V14.5: Reduced batch size and increased delay to prevent rate limit storms
        console.log(`🔄 [HF Datasets] Fetching full details...`);
        const fullDatasets = [];
        const batchSize = 2; // Reduced from 10 to prevent parallel 429 storms
        const batchDelay = 1000; // Increased from 100ms

        for (let i = 0; i < datasets.length; i += batchSize) {
            const batch = datasets.slice(i, i + batchSize);

            // V22.7: Pre-fetch NSFW Check
            const safeBatch = batch.filter(d => this.isSafeForWork(d));
            if (safeBatch.length === 0) {
                console.log(`   ⏭️ Skipping batch ${i / batchSize} (No safe datasets)`);
                continue;
            }

            const batchResults = await Promise.all(
                safeBatch.map(d => this.fetchFullDataset(d.id, 0, d, options.registryManager))
            );
            const validResults = batchResults.filter(d => d !== null);
            if (options.onBatch) {
                await options.onBatch(validResults);
            } else {
                fullDatasets.push(...validResults);
            }

            // Progress log
            if ((i + batchSize) % 50 === 0 || i + batchSize >= datasets.length) {
                console.log(`   Progress: ${Math.min(i + batchSize, datasets.length)}/${datasets.length}`);
            }

            // Rate limiting delay
            if (i + batchSize < datasets.length) {
                await this.delay(batchDelay);
            }
        }

        console.log(`✅ [HF Datasets] Fetched ${options.onBatch ? datasets.length : fullDatasets.length} complete datasets`);
        return options.onBatch ? [] : fullDatasets;
    }

    /**
 * Fetch complete dataset details including README
 * V14.5: Added 429 retry logic with exponential backoff
 */
    async fetchFullDataset(datasetId, retryCount = 0, expandedData = null, registryManager = null) {
        const MAX_RETRIES = 3;

        try {
            // V22.4 Industrial Refit: Skip network if expandedData is fresh
            if (registryManager && expandedData && expandedData.lastModified) {
                const normId = this.generateId(null, datasetId, 'dataset');
                const existing = registryManager.registry?.entities?.find(e => e.id === normId);

                if (existing && new Date(existing.updated_at || 0) >= new Date(expandedData.lastModified)) {
                    // console.log(`   ⏭️  [HF Datasets] Skipping detail fetch for ${datasetId} (No change)`);
                    existing.popularity = expandedData.downloads || existing.popularity;
                    existing.downloads = expandedData.downloads || existing.downloads;
                    existing.likes = expandedData.likes || existing.likes;
                    existing.updated_at = expandedData.lastModified;
                    return existing;
                }
            }

            // Fetch API data
            const apiUrl = `${HF_API_BASE}/datasets/${datasetId}`;
            // If we have expandedData, we can technically skip apiUrl similar to models, 
            // but datasets API often has additional siblings/files list info we might want.
            // However, for industrial throughput, if we don't need files_count to be ultra-accurate 
            // (siblings is not in expand list), we could skip.
            // For now, only skip if we have registry hit above.

            const apiResponse = await fetch(apiUrl);

            // V14.5: Handle rate limiting with exponential backoff
            if (apiResponse.status === 429) {
                if (retryCount < MAX_RETRIES) {
                    const backoff = Math.min(2000 * Math.pow(2, retryCount), 30000);
                    console.log(`   ⚠️ Rate limited (429) for ${datasetId}, retry ${retryCount + 1}/${MAX_RETRIES} after ${backoff}ms...`);
                    await this.delay(backoff);
                    return this.fetchFullDataset(datasetId, retryCount + 1);
                }
                console.warn(`   ❌ Max retries exceeded for ${datasetId}`);
                return null;
            }

            if (!apiResponse.ok) {
                console.warn(`   ⚠️ API failed for ${datasetId}: ${apiResponse.status}`);
                return null;
            }

            const data = await apiResponse.json();

            // Fetch README content
            const readmeUrl = `${HF_RAW_BASE}/datasets/${datasetId}/raw/main/README.md`;
            let readme = '';
            try {
                const readmeResponse = await fetch(readmeUrl);
                if (readmeResponse.ok) {
                    readme = await readmeResponse.text();
                    // Truncate to 100KB
                    if (readme.length > 100000) {
                        readme = readme.substring(0, 100000) + '\n\n[Content truncated...]';
                    }
                }
            } catch (e) {
                // README fetch failed, continue without it
            }

            // V19.5 Mode B Phase 2: Zero-fabrication Schema Extraction via datasets-server
            let schemaData = null;
            try {
                const schemaUrl = `https://datasets-server.huggingface.co/info?dataset=${datasetId}`;
                const schemaRes = await fetch(schemaUrl, { signal: AbortSignal.timeout(3000) });
                if (schemaRes.ok) {
                    const infoData = await schemaRes.json();
                    schemaData = infoData.dataset_info || null;
                }
            } catch (e) {
                // Datasets-server might not be ready or unsupported for this dataset. Fail open.
            }

            // V17.2: Memory Optimization - Target siblings list (OOM Culprit)
            // 1. Extract what we need first
            const extractedAssets = this.extractAssets({ ...data, readme });
            const filesCount = data.siblings?.length || 0;

            // 2. Prune heavy raw metadata before returning to the collector array
            // We keep: basic identity, cardData (tags/license), and our extracted extras
            const pruned = {
                id: data.id,
                author: data.author,
                lastModified: data.lastModified,
                createdAt: data.createdAt,
                likes: data.likes,
                downloads: data.downloads,
                tags: data.tags,
                cardData: {
                    license: data.cardData?.license,
                    size_category: data.cardData?.size_category,
                    task_categories: data.cardData?.task_categories,
                    task_ids: data.cardData?.task_ids,
                    language: data.cardData?.language,
                    multilinguality: data.cardData?.multilinguality,
                    source_datasets: data.cardData?.source_datasets,
                    citation: data.cardData?.citation
                },
                readme,
                _extractedAssets: extractedAssets,
                _schemaData: schemaData,
                _filesCount: filesCount,
                _fetchedAt: new Date().toISOString()
            };

            return pruned;
        } catch (error) {
            console.warn(`   ⚠️ Error fetching dataset ${datasetId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Normalize raw HuggingFace dataset to UnifiedEntity
     */
    normalize(raw) {
        const datasetId = raw.id;
        const [author, name] = this.parseDatasetId(datasetId);

        // V19.5 Mode B: Compile Zero-Fabrication Schema Markdown for Frontend Density
        let schemaMarkdown = '';
        let totalRows = 0;

        if (raw._schemaData) {
            try {
                // Configuration sets are heavily varied; use the prime default set config
                const configKey = Object.keys(raw._schemaData).includes('default') ? 'default' : Object.keys(raw._schemaData)[0];
                if (configKey) {
                    const info = raw._schemaData[configKey];
                    const features = info.features || {};
                    const splits = info.splits || {};

                    Object.values(splits).forEach(s => { totalRows += (s.num_examples || 0); });

                    if (Object.keys(features).length > 0) {
                        schemaMarkdown += '\n\n## 📊 Structured Schema (Zero-Fabrication)\n';
                        schemaMarkdown += '| Feature Key | Data Type |\n| :--- | :--- |\n';
                        Object.entries(features).forEach(([fKey, fVal]) => {
                            let typeStr = fVal.dtype || fVal._type || 'unknown';
                            if (fVal._type === 'Sequence' && fVal.feature) typeStr = `Sequence[${fVal.feature.dtype || fVal.feature._type}]`;
                            schemaMarkdown += `| \`${fKey}\` | \`${typeStr}\` |\n`;
                        });
                        if (totalRows > 0) {
                            schemaMarkdown += `\n**Estimated Rows:** \`${totalRows.toLocaleString()}\`\n`;
                        }
                    }
                }
            } catch (e) { }
        }

        const entity = {
            // Identity
            id: this.generateId(author, name, 'dataset'),
            type: 'dataset',
            source: 'huggingface',
            source_url: `https://huggingface.co/datasets/${datasetId}`,

            // Content
            title: name,
            description: this.extractDescription(raw.readme || raw.description),
            body_content: (raw.readme || '') + schemaMarkdown,
            tags: this.normalizeTags(raw.tags),

            // Metadata
            author: author,
            license_spdx: this.normalizeLicense(raw.cardData?.license),
            meta_json: this.buildMetaJson(raw),
            created_at: raw.createdAt,
            updated_at: raw.lastModified,

            // V24.12: Promoted fields for DB schema expansion
            task_categories: Array.isArray(raw.cardData?.task_categories) ? raw.cardData.task_categories.join(', ') : '',
            num_rows: 0, // Set below after schema extraction
            primary_language: Array.isArray(raw.cardData?.language) ? raw.cardData.language[0] : (raw.cardData?.language || ''),

            // Metrics
            popularity: raw.downloads || 0,
            downloads: raw.downloads || 0,
            likes: raw.likes || 0,

            // Assets (datasets typically don't have cover images)
            raw_image_url: null,

            // Relations
            relations: [],

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // V24.12: Set num_rows from schema extraction
        entity.num_rows = totalRows || 0;

        // Extract any visualization assets
        // V17.2: Use pre-extracted assets if available (from pruned data)
        const assets = raw._extractedAssets || this.extractAssets(raw);
        if (assets.length > 0) {
            entity.raw_image_url = assets[0].url;
        }

        // Discover relations (models that use this dataset)
        entity.relations = this.discoverRelations(entity);

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Extract meaningful images from dataset
     */
    extractAssets(raw) {
        const assets = [];

        // Priority 1: Card data image (V17.2: Disabled per User request - "useless cover/thumbnails")
        /*
        if (raw.cardData?.image) {
            assets.push({
                type: 'card_image',
                url: raw.cardData.image
            });
        }
        */

        // Priority 2: Assets from siblings (visualizations, samples)
        const siblings = raw.siblings || [];
        const meaningfulKeywords = ['sample', 'example', 'visualization',
            'preview', 'demo', 'overview', 'distribution'];

        for (const file of siblings) {
            const filename = file.rfilename || '';
            if (/\.(webp|png|jpg|jpeg|gif)$/i.test(filename)) {
                const isMeaningful = meaningfulKeywords.some(kw =>
                    filename.toLowerCase().includes(kw)
                );

                if (isMeaningful) {
                    assets.push({
                        type: 'visualization',
                        url: `https://huggingface.co/datasets/${raw.id}/resolve/main/${filename}`,
                        filename: filename
                    });
                }
            }
        }

        return assets;
    }

    // ============================================================
    // Helper Methods
    // ============================================================


    parseDatasetId(datasetId) {
        const parts = (datasetId || '').split('/');
        if (parts.length >= 2) {
            return [parts[0], parts.slice(1).join('-')];
        }
        return ['unknown', datasetId || 'unknown'];
    }

    normalizeTags(tags) {
        if (!Array.isArray(tags)) return [];
        return tags
            .filter(t => typeof t === 'string')
            .map(t => t.toLowerCase().trim())
            .filter(t => t.length > 0 && t.length < 50);
    }

    buildMetaJson(raw) {
        // Also inject the fetched totalRows here if we had it. It was calculated in normalize() 
        // but we can recount it for neatness, or just let normalize() append it to strings.
        let metricRows = 0;
        if (raw._schemaData) {
            try {
                const configKey = Object.keys(raw._schemaData).includes('default') ? 'default' : Object.keys(raw._schemaData)[0];
                if (configKey && raw._schemaData[configKey].splits) {
                    Object.values(raw._schemaData[configKey].splits).forEach(s => metricRows += (s.num_examples || 0));
                }
            } catch (e) { }
        }

        return {
            size_category: raw.cardData?.size_category || null,
            task_categories: raw.cardData?.task_categories || [],
            task_ids: raw.cardData?.task_ids || [],
            language: raw.cardData?.language || null,
            multilinguality: raw.cardData?.multilinguality || null,
            source_datasets: raw.cardData?.source_datasets || [],
            paperswithcode_id: raw.cardData?.paperswithcode_id || null,
            // V17.2: Use pre-counted file number
            files_count: raw._filesCount || raw.siblings?.length || 0,
            rows_count: metricRows || null,
            gated: raw.gated || false,
            private: raw.private || false,
            citation: raw.cardData?.citation || null
        };
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default DatasetsAdapter;
