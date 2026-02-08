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

        // 1. Core Score Calculation
        const fniScore = calculateFNI(entity);
        const finalType = entity.type || entity.entity_type || 'model';
        const finalFni = fniScore;

        // 2. VRAM Estimation
        let vramEstimate = null;
        if (finalType === 'model' && entity.params_billions) {
            vramEstimate = estimateVRAM(entity.params_billions, 'q4', entity.context_length || 8192);
        }

        // 3. 7-Day Trend Embedding
        const historyEntries = fniHistory[id] || fniHistory[entity.id] || [];
        const trend = Array.isArray(historyEntries) ? historyEntries.slice(-7).map(h => h.score) : [];

        // 4. Semantic HTML Pre-rendering
        const readme = entity.description || '';
        const htmlFragment = readme ? marked.parse(readme) : '';

        // 5. Use Cases & Insights
        const tags = Array.isArray(entity.tags) ? entity.tags : [];
        const useCases = getUseCases(tags, entity.pipeline_tag || '', finalType, finalFni);
        const quickInsights = getQuickInsights({ ...entity, fni_score: finalFni, vram_gb: vramEstimate }, finalType);

        // 6. Metadata Normalization
        const normalizedAuthor = entity.author || (entity.id?.includes('/') ? entity.id.split('/')[0] : 'Community');
        const displayDescription = entity.seo_summary?.description || (readme ? readme.slice(0, 200).replace(/\s+/g, ' ') + '...' : '');

        // V14.5.2: Stable _updated detection
        const entityHash = crypto.createHash('sha256')
            .update(JSON.stringify({ ...entity, type: finalType, fni: finalFni }))
            .digest('hex');

        const isChanged = entityChecksums[id] !== entityHash;
        const currentUpdated = entity._updated || new Date().toISOString();

        const enriched = {
            ...entity,
            id: id,
            type: finalType,
            fni_score: finalFni,
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
            enriched: registryEntry,
            html: htmlFragment
        };
    } catch (error) {
        console.error(`[ERROR] ${entity.id}:`, error.message);
        return { id: entity.id, success: false, error: error.message };
    }
}
