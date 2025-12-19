/**
 * HuggingFace Adapter
 * 
 * Fetches models from HuggingFace Hub API with complete data:
 * - Full README content
 * - Model metadata (params, framework, size)
 * - Asset extraction (architecture/demo images)
 * - Relationship discovery (GitHub, ArXiv)
 * 
 * @module ingestion/adapters/huggingface-adapter
 */

import { BaseAdapter } from './base-adapter.js';

const HF_API_BASE = 'https://huggingface.co/api';
const HF_RAW_BASE = 'https://huggingface.co';

/**
 * V4.3.1 Multi-Strategy Collection
 * Use different sort strategies to collect more models
 */
const COLLECTION_STRATEGIES = [
    { sort: 'likes', direction: -1, name: 'Most Liked' },
    { sort: 'downloads', direction: -1, name: 'Most Downloaded' },
    { sort: 'lastModified', direction: -1, name: 'Recently Updated' },
    { sort: 'createdAt', direction: -1, name: 'Newest Created' },
];

/**
 * HuggingFace Adapter Implementation
 * V4.1: Added HF_TOKEN support and rate limiting
 * V4.3.1: Added multi-strategy collection for bypassing API limits
 */
export class HuggingFaceAdapter extends BaseAdapter {
    constructor() {
        super('huggingface');
        this.entityTypes = ['model', 'dataset', 'space'];
        this.hfToken = process.env.HF_TOKEN || null;
    }

    /**
     * Get headers with optional HF_TOKEN authentication
     */
    getHeaders() {
        const headers = {
            'Accept': 'application/json',
            'User-Agent': 'Free2AITools/1.0'
        };
        if (this.hfToken) {
            headers['Authorization'] = `Bearer ${this.hfToken}`;
        }
        return headers;
    }

    /**
     * Fetch models from HuggingFace API
     * @param {Object} options
     * @param {number} options.limit - Number of models to fetch (default: 500)
     * @param {string} options.sort - Sort field (default: 'likes')
     * @param {boolean} options.full - Fetch full details including README
     */
    async fetch(options = {}) {
        const {
            limit = 500,
            sort = 'likes',
            direction = -1,
            full = true
        } = options;

        console.log(`📥 [HuggingFace] Fetching top ${limit} models by ${sort}...`);

        const listUrl = `${HF_API_BASE}/models?sort=${sort}&direction=${direction}&limit=${limit}`;
        const response = await fetch(listUrl, { headers: this.getHeaders() });

        if (!response.ok) {
            throw new Error(`HuggingFace API error: ${response.status}`);
        }

        const models = await response.json();
        console.log(`📦 [HuggingFace] Got ${models.length} models from list`);
        if (this.hfToken) {
            console.log(`🔑 [HuggingFace] Using authenticated requests (HF_TOKEN)`);
        }

        if (!full) {
            return models;
        }

        // Fetch full details for each model (with rate limiting)
        console.log(`🔄 [HuggingFace] Fetching full details with LOW & SLOW rate limiting...`);
        const fullModels = [];
        // V4.1 Operation 10k: Reduced concurrency and increased delay to avoid 429s
        const batchSize = this.hfToken ? 5 : 2; // Lower concurrency for stability
        const delayMs = this.hfToken ? 800 : 1500; // Slower but avoids rate limits

        for (let i = 0; i < models.length; i += batchSize) {
            const batch = models.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(m => this.fetchFullModel(m.modelId || m.id))
            );
            fullModels.push(...batchResults.filter(m => m !== null));

            // Progress log
            if ((i + batchSize) % 50 === 0 || i + batchSize >= models.length) {
                console.log(`   Progress: ${Math.min(i + batchSize, models.length)}/${models.length}`);
            }

            // Rate limiting delay
            if (i + batchSize < models.length) {
                await this.delay(delayMs);
            }
        }

        console.log(`✅ [HuggingFace] Fetched ${fullModels.length} complete models`);
        return fullModels;
    }

    /**
     * V4.3.1 Multi-Strategy Collection
     * Fetches models using multiple sort strategies to collect more unique models
     * @param {Object} options
     * @param {number} options.limitPerStrategy - Models per strategy (default: 1000)
     * @param {number[]} options.strategyIndices - Which strategies to use (default: all)
     * @param {Set} options.existingIds - Skip models already collected
     * @param {boolean} options.full - Fetch full details (default: true)
     */
    async fetchMultiStrategy(options = {}) {
        const {
            limitPerStrategy = 1000,
            strategyIndices = [0, 1, 2, 3],
            existingIds = new Set(),
            full = true
        } = options;

        const collectedIds = new Set(existingIds);
        const allModels = [];

        for (const strategyIndex of strategyIndices) {
            if (strategyIndex >= COLLECTION_STRATEGIES.length) continue;

            const strategy = COLLECTION_STRATEGIES[strategyIndex];
            console.log(`\n📥 [HuggingFace] Strategy ${strategyIndex + 1}/4: ${strategy.name}`);
            console.log(`   Sort: ${strategy.sort}, Direction: ${strategy.direction}`);

            try {
                const listUrl = `${HF_API_BASE}/models?sort=${strategy.sort}&direction=${strategy.direction}&limit=${limitPerStrategy}`;
                const response = await fetch(listUrl, { headers: this.getHeaders() });

                if (!response.ok) {
                    console.warn(`   ⚠️ API error: ${response.status}, skipping strategy`);
                    continue;
                }

                const models = await response.json();
                console.log(`   📦 Got ${models.length} models from API`);

                // Filter out duplicates
                const newModels = models.filter(m => {
                    const id = m.modelId || m.id;
                    if (collectedIds.has(id)) return false;
                    collectedIds.add(id);
                    return true;
                });

                console.log(`   🆕 ${newModels.length} unique models (${models.length - newModels.length} duplicates skipped)`);

                if (full && newModels.length > 0) {
                    // Fetch full details with rate limiting
                    const batchSize = this.hfToken ? 5 : 2;
                    const delayMs = this.hfToken ? 800 : 1500;

                    for (let i = 0; i < newModels.length; i += batchSize) {
                        const batch = newModels.slice(i, i + batchSize);
                        const batchResults = await Promise.all(
                            batch.map(m => this.fetchFullModel(m.modelId || m.id))
                        );
                        allModels.push(...batchResults.filter(m => m !== null));

                        if ((i + batchSize) % 100 === 0) {
                            console.log(`   Progress: ${Math.min(i + batchSize, newModels.length)}/${newModels.length}`);
                        }

                        if (i + batchSize < newModels.length) {
                            await this.delay(delayMs);
                        }
                    }
                } else {
                    allModels.push(...newModels);
                }

                // Delay between strategies to avoid rate limits
                await this.delay(2000);

            } catch (error) {
                console.error(`   ❌ Strategy ${strategy.name} failed: ${error.message}`);
            }
        }

        console.log(`\n✅ [HuggingFace] Multi-strategy total: ${allModels.length} unique models`);
        return {
            models: allModels,
            collectedIds: Array.from(collectedIds),
            stats: {
                strategies_used: strategyIndices.length,
                unique_models: allModels.length,
                duplicates_skipped: collectedIds.size - allModels.length
            }
        };
    }

    // ============================================================
    // V6.2 Spaces Support (Universal Entity Protocol)
    // ============================================================

    /**
     * Fetch spaces from HuggingFace API
     * @param {Object} options
     * @param {number} options.limit - Number of spaces to fetch (default: 200)
     * @param {string} options.sort - Sort field (default: 'likes')
     * @param {boolean} options.full - Fetch full details including README
     */
    async fetchSpaces(options = {}) {
        const { limit = 200, sort = 'likes', direction = -1, full = true } = options;

        console.log(`📥 [HuggingFace] Fetching top ${limit} spaces by ${sort}...`);

        const listUrl = `${HF_API_BASE}/spaces?sort=${sort}&direction=${direction}&limit=${limit}`;
        const response = await fetch(listUrl, { headers: this.getHeaders() });

        if (!response.ok) {
            throw new Error(`HuggingFace Spaces API error: ${response.status}`);
        }

        const spaces = await response.json();
        console.log(`📦 [HuggingFace] Got ${spaces.length} spaces from list`);

        if (!full) return spaces;

        // Fetch full details for each space (with rate limiting)
        console.log(`🔄 [HuggingFace] Fetching full space details...`);
        const fullSpaces = [];
        const batchSize = this.hfToken ? 5 : 2;
        const delayMs = this.hfToken ? 800 : 1500;

        for (let i = 0; i < spaces.length; i += batchSize) {
            const batch = spaces.slice(i, i + batchSize);
            const batchResults = await Promise.all(
                batch.map(s => this.fetchFullSpace(s.id))
            );
            fullSpaces.push(...batchResults.filter(s => s !== null));

            if ((i + batchSize) % 50 === 0 || i + batchSize >= spaces.length) {
                console.log(`   Progress: ${Math.min(i + batchSize, spaces.length)}/${spaces.length}`);
            }

            if (i + batchSize < spaces.length) {
                await this.delay(delayMs);
            }
        }

        console.log(`✅ [HuggingFace] Fetched ${fullSpaces.length} complete spaces`);
        return fullSpaces;
    }

    /**
     * Fetch complete space details including README
     */
    async fetchFullSpace(spaceId) {
        try {
            const apiUrl = `${HF_API_BASE}/spaces/${spaceId}`;
            const apiResponse = await fetch(apiUrl, { headers: this.getHeaders() });

            if (!apiResponse.ok) {
                if (apiResponse.status === 429) {
                    console.warn(`   ⚠️ Rate limited for space ${spaceId}, backing off...`);
                    await this.delay(2000);
                }
                console.warn(`   ⚠️ API failed for space ${spaceId}: ${apiResponse.status}`);
                return null;
            }

            const data = await apiResponse.json();

            // Fetch README content
            const readmeUrl = `${HF_RAW_BASE}/spaces/${spaceId}/raw/main/README.md`;
            let readme = '';
            try {
                const readmeResponse = await fetch(readmeUrl);
                if (readmeResponse.ok) {
                    readme = await readmeResponse.text();
                    if (readme.length > 100000) {
                        readme = readme.substring(0, 100000) + '\n\n[Content truncated...]';
                    }
                }
            } catch (e) {
                // README fetch failed, continue without it
            }

            return {
                ...data,
                readme,
                _fetchedAt: new Date().toISOString(),
                _entityType: 'space'
            };
        } catch (error) {
            console.warn(`   ⚠️ Error fetching space ${spaceId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Normalize raw HuggingFace space to UnifiedEntity
     */
    normalizeSpace(raw) {
        const spaceId = raw.id;
        const [author, name] = this.parseModelId(spaceId);

        const entity = {
            // Identity
            id: `hf-space--${this.sanitizeName(author)}--${this.sanitizeName(name)}`,
            type: 'space',
            source: 'huggingface',
            source_url: `https://huggingface.co/spaces/${spaceId}`,

            // Content
            title: name,
            description: this.extractDescription(raw.readme),
            body_content: raw.readme || '',
            tags: this.normalizeTags(raw.tags),

            // Metadata
            author: author,
            license_spdx: this.normalizeLicense(raw.cardData?.license),
            meta_json: this.buildSpaceMetaJson(raw),
            created_at: raw.createdAt,
            updated_at: raw.lastModified,

            // Metrics
            popularity: raw.likes || 0,
            downloads: 0, // Spaces don't have downloads

            // Space-specific
            sdk: raw.sdk || 'unknown',
            running_status: raw.runtime?.stage || 'unknown',

            // Assets
            raw_image_url: null,

            // Relations
            relations: [],

            // System fields
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Extract assets
        const assets = this.extractSpaceAssets(raw);
        if (assets.length > 0) {
            entity.raw_image_url = assets[0].url;
        }

        // Discover relations
        entity.relations = this.discoverRelations(entity);

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        return entity;
    }

    /**
     * Build space-specific metadata JSON
     */
    buildSpaceMetaJson(raw) {
        return {
            sdk: raw.sdk || null,
            sdk_version: raw.cardData?.sdk_version || null,
            app_file: raw.cardData?.app_file || 'app.py',
            runtime_stage: raw.runtime?.stage || null,
            runtime_hardware: raw.runtime?.hardware?.current || null,
            emoji: raw.cardData?.emoji || null,
            colorFrom: raw.cardData?.colorFrom || null,
            colorTo: raw.cardData?.colorTo || null,
            pinned: raw.cardData?.pinned || false,
        };
    }

    /**
     * Extract meaningful images from HuggingFace space
     */
    extractSpaceAssets(raw) {
        const assets = [];

        // Priority 1: Space screenshot/thumbnail
        if (raw.cardData?.thumbnail) {
            assets.push({
                type: 'thumbnail',
                url: raw.cardData.thumbnail
            });
        }

        // Priority 2: Look for screenshot in siblings
        const siblings = raw.siblings || [];
        const screenshot = siblings.find(f =>
            /screenshot|preview|demo/i.test(f.rfilename) &&
            /\.(webp|png|jpg|jpeg)$/i.test(f.rfilename)
        );
        if (screenshot) {
            assets.push({
                type: 'screenshot',
                url: `https://huggingface.co/spaces/${raw.id}/resolve/main/${screenshot.rfilename}`
            });
        }

        return assets;
    }


    /**
     * Fetch complete model details including README
     */
    async fetchFullModel(modelId) {
        try {
            // Fetch API data with auth headers
            const apiUrl = `${HF_API_BASE}/models/${modelId}`;
            const apiResponse = await fetch(apiUrl, { headers: this.getHeaders() });

            if (!apiResponse.ok) {
                if (apiResponse.status === 429) {
                    console.warn(`   ⚠️ Rate limited for ${modelId}, backing off...`);
                    await this.delay(2000); // Extra delay on rate limit
                }
                console.warn(`   ⚠️ API failed for ${modelId}: ${apiResponse.status}`);
                return null;
            }

            const data = await apiResponse.json();

            // Fetch README content
            const readmeUrl = `${HF_RAW_BASE}/${modelId}/raw/main/README.md`;
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

            return {
                ...data,
                readme,
                _fetchedAt: new Date().toISOString()
            };
        } catch (error) {
            console.warn(`   ⚠️ Error fetching ${modelId}: ${error.message}`);
            return null;
        }
    }

    /**
     * Normalize raw HuggingFace model to UnifiedEntity
     */
    normalize(raw) {
        const modelId = raw.modelId || raw.id;
        const [author, name] = this.parseModelId(modelId);

        const entity = {
            // Identity
            id: this.generateId(author, name),
            type: this.inferType(raw),
            source: 'huggingface',
            source_url: `https://huggingface.co/${modelId}`,

            // Content
            title: name,
            description: this.extractDescription(raw.readme),
            body_content: raw.readme || '',
            tags: this.normalizeTags(raw.tags),

            // Metadata
            author: author,
            license_spdx: this.normalizeLicense(raw.cardData?.license),
            meta_json: this.buildMetaJson(raw),
            created_at: raw.createdAt,
            updated_at: raw.lastModified,

            // Metrics
            popularity: raw.likes || 0,
            downloads: raw.downloads || 0,

            // V6.0: Pipeline tag for category assignment
            pipeline_tag: raw.pipeline_tag || null,

            // Assets
            raw_image_url: null, // Will be set by extractAssets

            // Relations (discovered later)
            relations: [],

            // System fields (calculated)
            content_hash: null,
            compliance_status: null,
            quality_score: null
        };

        // Extract assets
        const assets = this.extractAssets(raw);
        if (assets.length > 0) {
            entity.raw_image_url = assets[0].url;
        }

        // Discover relations
        entity.relations = this.discoverRelations(entity);

        // Calculate system fields
        entity.content_hash = this.generateContentHash(entity);
        entity.compliance_status = this.getComplianceStatus(entity);
        entity.quality_score = this.calculateQualityScore(entity);

        // V3.3 Data Expansion: GGUF Detection
        const ggufInfo = this.detectGGUF(raw);
        entity.has_gguf = ggufInfo.hasGGUF;
        entity.gguf_variants = ggufInfo.variants;

        return entity;
    }

    /**
     * Detect GGUF files in model repository
     * V3.3 Data Expansion - "Runtime First" Strategy
     */
    detectGGUF(raw) {
        const siblings = raw.siblings || [];
        const ggufFiles = siblings.filter(f =>
            f.rfilename && f.rfilename.toLowerCase().endsWith('.gguf')
        );

        if (ggufFiles.length === 0) {
            return { hasGGUF: false, variants: [] };
        }

        // Extract quantization variants from filenames
        // e.g., "model-Q4_K_M.gguf" -> "Q4_K_M"
        const variants = [];
        const quantPattern = /[_-](Q[0-9]+[_A-Z]*|F16|F32|BF16)/gi;

        for (const file of ggufFiles) {
            const matches = file.rfilename.match(quantPattern);
            if (matches) {
                matches.forEach(m => {
                    const variant = m.replace(/^[_-]/, '').toUpperCase();
                    if (!variants.includes(variant)) {
                        variants.push(variant);
                    }
                });
            }
        }

        // Sort by quality (F16 > Q8 > Q6 > Q5 > Q4 > Q3 > Q2)
        const quantOrder = ['F32', 'F16', 'BF16', 'Q8', 'Q6', 'Q5', 'Q4', 'Q3', 'Q2'];
        variants.sort((a, b) => {
            const aOrder = quantOrder.findIndex(q => a.startsWith(q));
            const bOrder = quantOrder.findIndex(q => b.startsWith(q));
            return aOrder - bOrder;
        });

        return {
            hasGGUF: true,
            variants: variants.slice(0, 10), // Limit to 10 variants
            fileCount: ggufFiles.length
        };
    }

    /**
     * Extract meaningful images from HuggingFace model
     */
    extractAssets(raw) {
        const assets = [];
        const siblings = raw.siblings || [];

        // Priority 1: Card data image
        if (raw.cardData?.image) {
            assets.push({
                type: 'card_image',
                url: raw.cardData.image
            });
        }

        // Priority 2: Assets folder images with meaningful names
        const meaningfulKeywords = ['architecture', 'benchmark', 'demo', 'structure',
            'diagram', 'overview', 'model', 'pipeline'];

        for (const file of siblings) {
            const filename = file.rfilename || '';
            if (/\.(webp|png|jpg|jpeg|gif)$/i.test(filename)) {
                const isAsset = filename.startsWith('assets/') || filename.includes('/assets/');
                const isMeaningful = meaningfulKeywords.some(kw =>
                    filename.toLowerCase().includes(kw)
                );

                if (isAsset || isMeaningful) {
                    assets.push({
                        type: 'readme_image',
                        url: `https://huggingface.co/${raw.modelId}/resolve/main/${filename}`,
                        filename: filename
                    });
                }
            }
        }

        // Priority 3: First image from assets folder
        if (assets.length === 0) {
            const firstImage = siblings.find(f =>
                /\.(webp|png|jpg|jpeg)$/i.test(f.rfilename) &&
                f.rfilename.startsWith('assets/')
            );
            if (firstImage) {
                assets.push({
                    type: 'fallback_image',
                    url: `https://huggingface.co/${raw.modelId}/resolve/main/${firstImage.rfilename}`
                });
            }
        }

        return assets;
    }

    // ============================================================
    // Helper Methods
    // ============================================================

    parseModelId(modelId) {
        const parts = (modelId || '').split('/');
        if (parts.length >= 2) {
            return [parts[0], parts.slice(1).join('-')];
        }
        return ['unknown', modelId || 'unknown'];
    }

    inferType(raw) {
        const pipelineTag = raw.pipeline_tag || '';

        // Dataset indicators
        if (raw.cardData?.datasets || pipelineTag === 'dataset') {
            return 'dataset';
        }

        // Tool/library indicators
        if (raw.library_name === 'transformers' && !pipelineTag) {
            return 'tool';
        }

        return 'model';
    }

    normalizeTags(tags) {
        if (!Array.isArray(tags)) return [];
        return tags
            .filter(t => typeof t === 'string')
            .map(t => t.toLowerCase().trim())
            .filter(t => t.length > 0 && t.length < 50);
    }

    buildMetaJson(raw) {
        return {
            pipeline_tag: raw.pipeline_tag || null,
            library_name: raw.library_name || null,
            framework: raw.library_name || null,
            params: raw.safetensors?.total || null,
            storage_bytes: raw.usedStorage || null,
            files_count: raw.siblings?.length || 0,
            spaces_count: raw.spaces?.length || 0,
            gated: raw.gated || false,
            private: raw.private || false,
            config: raw.config || null
        };
    }

    delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default HuggingFaceAdapter;
