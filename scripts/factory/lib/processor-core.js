/**
 * Shard Processor Core Enrichment Logic (CES Compliant)
 * V16.10: Extracted from shard-processor.js to comply with Art 5.1 (250-line limit)
 */

import crypto from 'crypto';
import { marked } from 'marked';
import { calculateFNI } from './fni-score.js';
import { hasValidCachePath } from '../../l5/entity-validator.js';
import { normalizeId, getNodeSource } from '../../utils/id-normalizer.js';
import { estimateVRAM } from '../../../src/utils/vram-calculator.js';
import { getUseCases, getQuickInsights } from '../../../src/utils/inference.js';

// Configure marked
marked.setOptions({ gfm: true, breaks: true });

/**
 * Atomic entity processing (Art 3.2)
 */
export async function processEntity(entity, globalStats, entityChecksums, fniHistory = {}, config) {
    try {
        const id = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);

        if (!hasValidCachePath(entity)) {
            console.warn(`[WARN] Skipping ${entity.id || 'unknown'} - Invalid cache path`);
            return { id: id || entity.id, success: false, error: 'Invalid cache path' };
        }

        // 1. Metric Promotion (V25.1.2: AOT Promotion for FNI Calibration)
        // We MUST extract these BEFORE calculateFNI so the ranker sees the data.
        let meta = {};
        try {
            meta = typeof entity.meta_json === 'string' ? JSON.parse(entity.meta_json || '{}') : (entity.meta_json || {});
        } catch (e) { }

        // Core Ranking Metrics
        entity.stars = entity.stars || meta.stars || meta.stargazers_count || 0;
        entity.forks = entity.forks || meta.forks || meta.forks_count || 0;
        entity.citations = entity.citations || entity.citation_count || meta.citations || meta.citation_count || 0;
        entity.downloads = entity.downloads || meta.downloads || meta.download_count || 0;
        entity.likes = entity.likes || meta.likes || meta.like_count || 0;

        // Space Specific Metrics
        entity.hardware = entity.hardware || meta.runtime_hardware || meta.hardware || '';
        entity.runtime_status = entity.runtime_status || entity.running_status || meta.runtime_stage || meta.runtime_status || '';

        // 2. Core Score Calculation
        const fniResult = calculateFNI(entity, { includeMetrics: true });
        const finalType = entity.type || entity.entity_type || 'model';
        const finalFni = fniResult.score;
        const fniMetrics = fniResult.metrics;

        // 3. VRAM Estimation
        let vramEstimate = null;
        if (finalType === 'model' && (entity.params_billions || entity.params)) {
            vramEstimate = estimateVRAM(entity.params_billions || entity.params, 'q4', entity.context_length || 8192);
        }

        // 4. 7-Day Trend Embedding
        const historyEntries = fniHistory[id] || fniHistory[entity.id] || [];
        const trend = Array.isArray(historyEntries) ? historyEntries.slice(-7).map(h => h.score) : [];

        // 5. Semantic HTML Pre-rendering (V22.8 FIX: Inclusive Long-text extraction)
        const fullContent = entity.body_content || entity.readme_content || entity.readme || entity.content || entity.description || '';
        const htmlFragment = fullContent ? marked.parse(fullContent) : '';

        // 6. Use Cases & Insights
        const tags = Array.isArray(entity.tags) ? entity.tags : [];
        const useCases = getUseCases(tags, entity.pipeline_tag || '', finalType, finalFni);
        const quickInsights = getQuickInsights({ ...entity, fni_score: finalFni, vram_gb: vramEstimate }, finalType);

        // 7. Metadata Normalization
        const normalizedAuthor = entity.author || (entity.id?.includes('/') ? entity.id.split('/')[0] : 'Community');
        const displayDescription = entity.seo_summary?.description || (fullContent ? fullContent.slice(0, 200).replace(/\s+/g, ' ') + '...' : '');

        // V14.5.2: Stable _updated detection
        const entityHash = crypto.createHash('sha256')
            .update(JSON.stringify({ ...entity, type: finalType, fni: finalFni, html_checksum: crypto.createHash('md5').update(htmlFragment).digest('hex') }))
            .digest('hex');

        const isChanged = entityChecksums[id] !== entityHash;
        const currentUpdated = entity._updated || new Date().toISOString();

        const enriched = {
            ...entity,
            id: id,
            type: finalType,
            fni_score: finalFni,
            fni_metrics: fniMetrics,
            fni_p: fniMetrics.p,
            fni_v: fniMetrics.f ?? fniMetrics.v,
            fni_c: fniMetrics.c,
            fni_u: fniMetrics.u,
            vram_estimate_gb: vramEstimate,
            trend_7d: trend,
            use_cases: useCases,
            quick_insights: quickInsights,
            author: normalizedAuthor,
            display_description: displayDescription,
            _html_checksum: crypto.createHash('md5').update(htmlFragment).digest('hex'),
            _version: '16.5.0-fusion',
            _updated: isChanged ? new Date().toISOString() : currentUpdated,
            _checksum: entityHash,
        };

        // V16.11 Optimization: Stop writing individual files to disk in Stage 2/4.
        // Data is now carried by the Monolithic Shard.

        return {
            id,
            slug: enriched.slug,
            name: enriched.name,
            type: enriched.type,
            source: enriched.source || enriched.source_platform,
            fni: finalFni,
            vram: vramEstimate,
            lastModified: enriched._updated,
            success: true,
            _checksum: entityHash,
            // Return full payload for monolithic bundling
            enriched: enriched,
            html_readme: htmlFragment
        };
    } catch (error) {
        console.error(`[ERROR] ${entity.id}:`, error.message);
        return { id: entity.id, success: false, error: error.message };
    }
}
