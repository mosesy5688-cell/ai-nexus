/**
 * HuggingFace Normalizer
 * 
 * B.1 CES Refactor: Extracted from huggingface-adapter.js
 * Contains normalization logic for models and spaces
 * 
 * @module ingestion/adapters/hf-normalizer
 */

import { parseModelId, inferType, normalizeTags, buildMetaJson, detectGGUF, extractAssets } from './hf-utils.js';

/**
 * Normalize raw HuggingFace model to UnifiedEntity
 * @param {Object} raw - Raw model data from HuggingFace API
 * @param {Object} adapter - Adapter instance for helper methods
 * @returns {Object} Normalized entity
 */
export function normalizeModel(raw, adapter) {
    const modelId = raw.modelId || raw.id;
    const [author, name] = parseModelId(modelId);

    const entity = {
        // Identity
        id: adapter.generateId(author, name),
        type: inferType(raw),
        source: 'huggingface',
        source_url: `https://huggingface.co/${modelId}`,

        // Content
        title: name,
        description: adapter.extractDescription(raw.readme),
        body_content: raw.readme || '',
        tags: normalizeTags(raw.tags),

        // Metadata
        author: author,
        license_spdx: adapter.normalizeLicense(raw.cardData?.license),
        meta_json: buildMetaJson(raw),
        created_at: raw.createdAt,
        updated_at: raw.lastModified,

        // Metrics
        popularity: raw.likes || 0,
        downloads: raw.downloads || 0,

        // V6.0: Pipeline tag for category assignment
        pipeline_tag: raw.pipeline_tag || null,

        // Assets
        raw_image_url: null,

        // Relations (discovered later)
        relations: [],

        // System fields (calculated)
        content_hash: null,
        compliance_status: null,
        quality_score: null
    };

    // Extract assets
    const assets = extractAssets(raw);
    if (assets.length > 0) {
        entity.raw_image_url = assets[0].url;
    }

    // Discover relations
    entity.relations = adapter.discoverRelations(entity);

    // Calculate system fields
    entity.content_hash = adapter.generateContentHash(entity);
    entity.compliance_status = adapter.getComplianceStatus(entity);
    entity.quality_score = adapter.calculateQualityScore(entity);

    // V3.3 Data Expansion: GGUF Detection
    const ggufInfo = detectGGUF(raw);
    entity.has_gguf = ggufInfo.hasGGUF;
    entity.gguf_variants = ggufInfo.variants;

    return entity;
}

/**
 * Build space-specific metadata JSON
 * @param {Object} raw - Raw space data
 * @returns {Object} Space metadata
 */
export function buildSpaceMetaJson(raw) {
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
 * @param {Object} raw - Raw space data
 * @returns {Object[]} Array of asset objects
 */
export function extractSpaceAssets(raw) {
    const assets = [];

    // Priority 1: Space screenshot/thumbnail
    if (raw.cardData?.thumbnail) {
        assets.push({ type: 'thumbnail', url: raw.cardData.thumbnail });
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
 * Normalize raw HuggingFace space to UnifiedEntity
 * @param {Object} raw - Raw space data from HuggingFace API
 * @param {Object} adapter - Adapter instance for helper methods
 * @returns {Object} Normalized entity
 */
export function normalizeSpace(raw, adapter) {
    const spaceId = raw.id;
    const [author, name] = parseModelId(spaceId);

    const entity = {
        // Identity
        id: `hf-space--${adapter.sanitizeName(author)}--${adapter.sanitizeName(name)}`,
        type: 'space',
        source: 'huggingface',
        source_url: `https://huggingface.co/spaces/${spaceId}`,

        // Content
        title: name,
        description: adapter.extractDescription(raw.readme),
        body_content: raw.readme || '',
        tags: normalizeTags(raw.tags),

        // Metadata
        author: author,
        license_spdx: adapter.normalizeLicense(raw.cardData?.license),
        meta_json: buildSpaceMetaJson(raw),
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
    const assets = extractSpaceAssets(raw);
    if (assets.length > 0) {
        entity.raw_image_url = assets[0].url;
    }

    // Discover relations
    entity.relations = adapter.discoverRelations(entity);

    // Calculate system fields
    entity.content_hash = adapter.generateContentHash(entity);
    entity.compliance_status = adapter.getComplianceStatus(entity);
    entity.quality_score = adapter.calculateQualityScore(entity);

    return entity;
}
