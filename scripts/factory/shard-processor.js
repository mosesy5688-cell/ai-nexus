/**
 * Factory Shard Processor V16.8.7 (CES Compliant)
 * 
 * Constitution: Art 3.1-3.4 (Factory Pipeline)
 * V16.8.7: Uses cache-manager for persistent entity checksums (cross-run diff)
 * 
 * Usage: node scripts/factory/shard-processor.js --shard=N --total=20
 */

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { marked } from 'marked';
import { calculateFNI } from './lib/fni-score.js';
import { hasValidCachePath } from '../l5/entity-validator.js';
import { smartWriteWithVersioning } from './lib/smart-writer.js';
import { loadEntityChecksums, saveEntityChecksums, loadFniHistory } from './lib/cache-manager.js';
import { normalizeId, getNodeSource } from '../utils/id-normalizer.js';
import { estimateVRAM } from '../../src/utils/vram-calculator.js';
import { getUseCases, getQuickInsights } from '../../src/utils/inference.js';

// V16.12: Configure marked for semantic HTML (Art 6.2 Advisory)
marked.setOptions({
    gfm: true,
    breaks: true
});

// Configuration (Art 3.1)
const CONFIG = {
    TOTAL_SHARDS: 20,
    CHECKPOINT_THRESHOLD_HOURS: 5.5,
    CACHE_DIR: process.env.CACHE_DIR || './cache'
};

// ... (skipping processEntity changes for now, will handle below)

// ... (parseArgs remains same)

// Atomic entity processing (Art 3.2)
async function processEntity(entity, globalStats, entityChecksums, fniHistory = {}) {
    try {
        const id = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);

        if (!hasValidCachePath(entity)) {
            console.warn(`[WARN] Skipping ${entity.id || 'unknown'} - Invalid cache path`);
            return { id: id || entity.id, success: false, error: 'Invalid cache path' };
        }

        // 1. Core FNI & Type Promotion
        const fniScore = calculateFNI(entity);
        const finalType = entity.type || entity.entity_type || 'model';
        const finalFni = fniScore;

        // 2. [DEEP ENRICHMENT] VRAM Estimation
        let vramEstimate = null;
        if (finalType === 'model' && entity.params_billions) {
            vramEstimate = estimateVRAM(entity.params_billions, 'q4', entity.context_length || 8192);
        }

        // 3. [DEEP ENRICHMENT] 7-Day Trend Embedding
        const historyEntries = fniHistory[id] || fniHistory[entity.id] || [];
        const trend = Array.isArray(historyEntries) ? historyEntries.slice(-7).map(h => h.score) : [];

        // 4. [DEEP ENRICHMENT] Semantic HTML Pre-rendering
        const readme = entity.description || '';
        const htmlFragment = readme ? marked.parse(readme) : '';

        // 5. [DEEP ENRICHMENT] Use Cases & Quick Insights
        const tags = Array.isArray(entity.tags) ? entity.tags : [];
        const useCases = getUseCases(tags, entity.pipeline_tag || '', finalType, finalFni);
        const quickInsights = getQuickInsights({ ...entity, fni_score: finalFni, vram_gb: vramEstimate }, finalType);

        // 6. [DEEP ENRICHMENT] Metadata Normalization
        const normalizedAuthor = entity.author || (entity.id?.includes('/') ? entity.id.split('/')[0] : 'Community');
        const displayDescription = entity.seo_summary?.description || (readme ? readme.slice(0, 200).replace(/\s+/g, ' ') + '...' : '');

        // V14.5.2: Stable _updated - only update if content changed
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

        // Output 1: Atomic Processed Entity (Registry Entry)
        // Sanitization: Remove original heavy text to keep registry lean
        const registryEntry = { ...enriched };
        delete registryEntry.description;

        const key = `entities/${finalType}/${id}.json`;
        await smartWriteWithVersioning(key, registryEntry, CONFIG.CACHE_DIR);

        // Output 2: HTML Fragment (Satellite Storage)
        if (htmlFragment && isChanged) {
            const htmlKey = `html/${id}.json`;
            await smartWriteWithVersioning(htmlKey, { html: htmlFragment, id }, CONFIG.CACHE_DIR);
        }

        return {
            id: id,
            slug: enriched.slug,
            name: enriched.name,
            type: enriched.type,
            source: enriched.source || enriched.source_platform,
            fni: finalFni,
            vram: vramEstimate,
            lastModified: enriched._updated,
            success: true,
            _checksum: entityHash,
        };
    } catch (error) {
        console.error(`[ERROR] ${entity.id}:`, error.message);
        return { id: entity.id, success: false, error: error.message };
    }
}

/**
 * Utility: Parse CLI arguments (Art 3.1)
 */
function parseArgs() {
    const args = process.argv.slice(2);
    const shard = args.find(a => a.startsWith('--shard='))?.split('=')[1];
    const total = args.find(a => a.startsWith('--total='))?.split('=')[1];
    return {
        shardId: parseInt(shard) || 0,
        totalShards: parseInt(total) || 20
    };
}

/**
 * Utility: Save partial results for long-running shards (Art 3.4)
 */
async function saveCheckpoint(shardId, results, lastId) {
    const checkpointPath = `./artifacts/checkpoint-shard-${shardId}.json`;
    await fs.mkdir('./artifacts', { recursive: true });
    await fs.writeFile(checkpointPath, JSON.stringify({
        shardId,
        lastId,
        results,
        timestamp: new Date().toISOString()
    }, null, 2));
}

// Main (V14.5.2: with artifact-based checksum tracking)
async function main() {
    const { shardId, totalShards } = parseArgs();
    console.log(`[SHARD ${shardId}/${totalShards}] Starting...`);

    // V16.2.10: Data Safety Guard - 2/4 stage must NEVER write to R2
    // All persistence in 2/4 is via artifacts/cache
    process.env.ENABLE_R2_BACKUP = 'false';

    // V16.2.3: Load manifest for global stats (Avg Velocity)
    let globalStats = 0;
    try {
        const manifest = JSON.parse(await fs.readFile('./data/manifest.json', 'utf-8'));
        globalStats = manifest.stats?.avgVelocity || 0;
        console.log(`[SHARD ${shardId}] Global Avg Velocity: ${globalStats}`);
    } catch (e) {
        console.warn(`[SHARD ${shardId}] Manifest stats not found, using 0 fallback`);
    }

    // V16.2.3: Load sharded input if available (Memory Optimization)
    let entitiesPath = process.env.ENTITIES_PATH || './data/merged.json';
    const shardedPath = `./data/merged_shard_${shardId}.json`;

    try {
        await fs.access(shardedPath);
        entitiesPath = shardedPath;
        console.log(`[SHARD ${shardId}] Using sharded input: ${entitiesPath}`);
    } catch {
        console.log(`[SHARD ${shardId}] Sharded input not found, falling back to: ${entitiesPath}`);
    }

    // V14.5: Load entity checksums for diff detection
    const entityChecksums = await loadEntityChecksums();

    // V16.12: Load FNI history for 7-day trend embedding
    let fniHistory = {};
    try {
        const historyData = await loadFniHistory();
        fniHistory = historyData.entities || {};
        console.log(`[SHARD ${shardId}] Loaded FNI history for ${Object.keys(fniHistory).length} entities`);
    } catch (e) {
        console.warn(`[SHARD ${shardId}] FNI history load failed, trends will be empty:`, e.message);
    }

    // Load entities for this shard (either sharded file or filtered from merged.json)
    let shardEntities;
    if (entitiesPath === shardedPath) {
        shardEntities = JSON.parse(await fs.readFile(entitiesPath, 'utf-8'));
    } else {
        const allEntitiesFallback = JSON.parse(await fs.readFile(process.env.ENTITIES_PATH || './data/merged.json', 'utf-8'));
        shardEntities = allEntitiesFallback.filter((_, idx) => idx % totalShards === shardId);
    }
    // V16.99: FNI-style Full Processing Guard - Ensure output directories exist
    await fs.mkdir(path.join(CONFIG.CACHE_DIR, 'entities'), { recursive: true });
    await fs.mkdir(path.join(CONFIG.CACHE_DIR, 'html'), { recursive: true });

    // Process
    const results = [];
    const startTime = Date.now();

    for (const entity of shardEntities) {
        // Checkpoint check (Art 3.4)
        const elapsedHours = (Date.now() - startTime) / (1000 * 60 * 60);
        if (elapsedHours >= CONFIG.CHECKPOINT_THRESHOLD_HOURS) {
            console.log(`[SHARD ${shardId}] Checkpoint at 5.5h, saving...`);
            await saveCheckpoint(shardId, results, entity.id);
            break;
        }

        // V16.7.1: Normalize ID FIRST
        const normId = normalizeId(entity.id || entity.slug, getNodeSource(entity.id || entity.slug, entity.type), entity.type);

        // V16.99: Process ALWAYS (FNI-style: no skipping to ensure fragment completeness)
        const result = await processEntity(entity, globalStats, entityChecksums, fniHistory);
        results.push(result);
    }

    // Save shard artifact
    await fs.mkdir('./artifacts', { recursive: true });
    await fs.writeFile(`./artifacts/shard-${shardId}.json`, JSON.stringify({
        shardId,
        totalShards,
        processedCount: results.length,
        successCount: results.filter(r => r.success).length,
        failureCount: results.filter(r => !r.success).length,
        entities: results,
        timestamp: new Date().toISOString(),
    }, null, 2));

    console.log(`[SHARD ${shardId}] Complete. Success: ${results.filter(r => r.success).length}/${results.length}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
