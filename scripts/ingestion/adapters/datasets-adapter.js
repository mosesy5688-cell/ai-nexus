/**
 * HuggingFace Datasets Adapter
 * Fetches datasets from HuggingFace Hub API with complete data.
 * V25.9: expand[]=siblings eliminates per-dataset API detail requests.
 * @module ingestion/adapters/datasets-adapter
 */

import { BaseAdapter, NSFW_KEYWORDS } from './base-adapter.js';
import { extractSchemaInfo, extractDatasetAssets, buildDatasetMetaJson, parseDatasetId, normalizeDatasetTags } from './datasets-helpers.js';

const HF_API_BASE = 'https://huggingface.co/api';
const HF_RAW_BASE = 'https://huggingface.co';

export class DatasetsAdapter extends BaseAdapter {
    constructor() {
        super('huggingface');
        this.entityTypes = ['dataset'];
        this.hfToken = process.env.HF_TOKEN || null;
    }

    async fetch(options = {}) {
        const { limit = 500, sort = 'downloads', direction = -1, full = true } = options;
        console.log(`📥 [HF Datasets] Fetching top ${limit} datasets by ${sort}...`);

        const expandParams = [
            'author', 'cardData', 'createdAt', 'downloads',
            'likes', 'lastModified', 'tags', 'siblings'
        ].map(e => `expand[]=${e}`).join('&');

        const pageSize = 1000;
        const datasets = [];
        for (let offset = 0; offset < limit; offset += pageSize) {
            const fetchLimit = Math.min(pageSize, limit - offset);
            const listUrl = `${HF_API_BASE}/datasets?sort=${sort}&direction=${direction}&limit=${fetchLimit}&offset=${offset}&${expandParams}`;
            const response = await fetch(listUrl);
            if (!response.ok) { console.warn(`   ⚠️ HF Datasets API error at offset ${offset}: ${response.status}`); break; }
            const batch = await response.json();
            if (!batch.length) break;
            datasets.push(...batch);
            console.log(`   📦 Fetched ${datasets.length} dataset listings (offset: ${offset})...`);
            if (batch.length < fetchLimit) break;
            await this.delay(500);
        }
        console.log(`📦 [HF Datasets] Got ${datasets.length} datasets from paginated list`);

        if (!full) return datasets;

        console.log(`🔄 [HF Datasets] Fetching full details...`);
        const fullDatasets = [];
        const batchSize = this.hfToken ? 5 : 2;
        const batchDelay = this.hfToken ? 500 : 1000;

        for (let i = 0; i < datasets.length; i += batchSize) {
            const batch = datasets.slice(i, i + batchSize);
            const safeBatch = batch.filter(d => this.isSafeForWork(d));
            if (safeBatch.length === 0) { console.log(`   ⏭️ Skipping batch ${i / batchSize} (No safe datasets)`); continue; }

            const batchResults = await Promise.all(
                safeBatch.map(d => this.fetchFullDataset(d.id, 0, d, options.registryManager))
            );
            const validResults = batchResults.filter(d => d !== null);
            if (options.onBatch) { await options.onBatch(validResults); } else { fullDatasets.push(...validResults); }

            if ((i + batchSize) % 50 === 0 || i + batchSize >= datasets.length) {
                console.log(`   Progress: ${Math.min(i + batchSize, datasets.length)}/${datasets.length}`);
            }
            if (i + batchSize < datasets.length) await this.delay(batchDelay);
        }

        console.log(`✅ [HF Datasets] Fetched ${options.onBatch ? datasets.length : fullDatasets.length} complete datasets`);
        return options.onBatch ? [] : fullDatasets;
    }

    /**
     * Fetch complete dataset details including README.
     * V25.9: Skips /api/datasets/{id} when expandedData has siblings.
     * V14.5: 429 retry with exponential backoff preserved.
     */
    async fetchFullDataset(datasetId, retryCount = 0, expandedData = null, registryManager = null) {
        const MAX_RETRIES = 3;
        try {
            if (registryManager && expandedData && expandedData.lastModified) {
                const normId = this.generateId(null, datasetId, 'dataset');
                const existing = registryManager.registry?.entities?.find(e => e.id === normId);
                if (existing && new Date(existing.updated_at || 0) >= new Date(expandedData.lastModified)) {
                    existing.popularity = expandedData.downloads || existing.popularity;
                    existing.downloads = expandedData.downloads || existing.downloads;
                    existing.likes = expandedData.likes || existing.likes;
                    existing.updated_at = expandedData.lastModified;
                    return existing;
                }
            }

            // V25.9: Skip /api/datasets/{id} if expandedData already has siblings
            let data;
            if (expandedData?.siblings) {
                data = expandedData;
            } else {
                const apiResponse = await fetch(`${HF_API_BASE}/datasets/${datasetId}`);
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
                if (!apiResponse.ok) { console.warn(`   ⚠️ API failed for ${datasetId}: ${apiResponse.status}`); return null; }
                data = await apiResponse.json();
            }

            // Fetch README content
            let readme = '';
            try {
                const readmeResponse = await fetch(`${HF_RAW_BASE}/datasets/${datasetId}/raw/main/README.md`);
                if (readmeResponse.ok) {
                    readme = await readmeResponse.text();
                    if (readme.length > 100000) readme = readme.substring(0, 100000) + '\n\n[Content truncated...]';
                }
            } catch (e) { }

            // V25.9: Only fetch schema for datasets with >100 downloads
            let schemaData = null;
            if ((data?.downloads || expandedData?.downloads || 0) > 100) {
                try {
                    const schemaRes = await fetch(`https://datasets-server.huggingface.co/info?dataset=${datasetId}`, { signal: AbortSignal.timeout(2000) });
                    if (schemaRes.ok) { schemaData = (await schemaRes.json()).dataset_info || null; }
                } catch (e) { }
            }

            const extractedAssets = extractDatasetAssets({ ...data, readme });
            return {
                id: data.id, author: data.author, lastModified: data.lastModified, createdAt: data.createdAt,
                likes: data.likes, downloads: data.downloads, tags: data.tags,
                cardData: {
                    license: data.cardData?.license, size_category: data.cardData?.size_category,
                    task_categories: data.cardData?.task_categories, task_ids: data.cardData?.task_ids,
                    language: data.cardData?.language, multilinguality: data.cardData?.multilinguality,
                    source_datasets: data.cardData?.source_datasets, citation: data.cardData?.citation
                },
                readme, _extractedAssets: extractedAssets, _schemaData: schemaData,
                _filesCount: data.siblings?.length || 0, _fetchedAt: new Date().toISOString()
            };
        } catch (error) {
            console.warn(`   ⚠️ Error fetching dataset ${datasetId}: ${error.message}`);
            return null;
        }
    }

    /** Normalize raw HuggingFace dataset to UnifiedEntity */
    normalize(raw) {
        const datasetId = raw.id;
        const [author, name] = parseDatasetId(datasetId);
        const { schemaMarkdown, totalRows } = extractSchemaInfo(raw._schemaData);

        const entity = {
            id: this.generateId(author, name, 'dataset'),
            type: 'dataset', source: 'huggingface',
            source_url: `https://huggingface.co/datasets/${datasetId}`,
            title: name,
            description: this.extractDescription(raw.readme || raw.description),
            body_content: (raw.readme || '') + schemaMarkdown,
            tags: normalizeDatasetTags(raw.tags),
            author, license_spdx: this.normalizeLicense(raw.cardData?.license),
            meta_json: buildDatasetMetaJson(raw),
            created_at: raw.createdAt, updated_at: raw.lastModified,
            task_categories: Array.isArray(raw.cardData?.task_categories) ? raw.cardData.task_categories.join(', ') : '',
            num_rows: totalRows || 0,
            primary_language: Array.isArray(raw.cardData?.language) ? raw.cardData.language[0] : (raw.cardData?.language || ''),
            popularity: raw.downloads || 0, downloads: raw.downloads || 0, likes: raw.likes || 0,
            raw_image_url: null, relations: [],
            content_hash: null, compliance_status: null, quality_score: null
        };

        const assets = raw._extractedAssets || extractDatasetAssets(raw);
        if (assets.length > 0) entity.raw_image_url = assets[0].url;

        entity.relations = this.discoverRelations(entity);
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);
        return entity;
    }

    extractAssets(raw) { return extractDatasetAssets(raw); }
    parseDatasetId(id) { return parseDatasetId(id); }
    normalizeTags(tags) { return normalizeDatasetTags(tags); }
    buildMetaJson(raw) { return buildDatasetMetaJson(raw); }
    delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
}

export default DatasetsAdapter;
