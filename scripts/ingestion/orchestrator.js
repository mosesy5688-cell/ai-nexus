/**
 * Ingestion Pipeline Orchestrator
 * 
 * Coordinates the complete data ingestion pipeline:
 * 1. Fetch from multiple sources via adapters
 * 2. Normalize to unified schema
 * 3. Deduplicate and merge
 * 4. Check compliance
 * 5. Output for Rust processing
 * 
 * @module ingestion/orchestrator
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { adapters, getAdapterNames } from './adapters/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output paths
const OUTPUT_DIR = path.join(__dirname, '../../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'merged.json');

/**
 * Default ingestion configuration
 * Sprint 3 Phase 0: Grand Reset & Core Ingestion (5,000 entities)
 * Target: HF Models 3000 + GitHub 1500 + Datasets 500 = 5000
 */
const DEFAULT_CONFIG = {
    sources: {
        // V4.1 Phase 3: Operation 10K
        // Target: 15,500 raw → ~10,000 after dedup
        huggingface: { enabled: true, options: { limit: 8000 } },
        'huggingface-datasets': { enabled: true, options: { limit: 1500 } },
        github: { enabled: true, options: { limit: 3000 } },

        // Academic Sources (3s delay required)
        arxiv: { enabled: true, options: { limit: 2000, category: 'cs.AI OR cs.LG OR cs.CL OR cs.CV' } },

        // Ollama Registry (NEW for Phase 3)
        ollama: { enabled: true, options: { limit: 1000 } },

        // PWC disabled (Cloudflare protection)
        paperswithcode: { enabled: false, options: { limit: 200 } }
    },
    deduplication: {
        enabled: true,
        mergeStats: true
    },
    compliance: {
        blockNSFW: true
    }
};

/**
 * Orchestrator Class
 */
export class Orchestrator {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.stats = {
            fetched: {},
            normalized: 0,
            deduplicated: 0,
            blocked: 0,
            output: 0
        };
    }

    /**
     * Run the complete ingestion pipeline
     */
    async run() {
        console.log('═'.repeat(60));
        console.log('🚀 V3.2 Universal Ingestion Pipeline');
        console.log('═'.repeat(60));

        const startTime = Date.now();

        // Phase 1: Fetch from all sources
        console.log('\n📥 Phase 1: Fetching from sources...');
        const rawEntities = await this.fetchAll();

        // Phase 2: Normalize to unified schema
        console.log('\n🔄 Phase 2: Normalizing to unified schema...');
        const normalizedEntities = this.normalizeAll(rawEntities);

        // Phase 3: Deduplicate
        console.log('\n✨ Phase 3: Deduplicating...');
        const uniqueEntities = this.deduplicate(normalizedEntities);

        // Phase 4: Compliance filtering
        console.log('\n🛡️ Phase 4: Compliance check...');
        const compliantEntities = this.filterCompliance(uniqueEntities);

        // Phase 5: Output
        console.log('\n💾 Phase 5: Saving output...');
        await this.saveOutput(compliantEntities);

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Summary
        console.log('\n' + '═'.repeat(60));
        console.log('📊 Pipeline Summary:');
        console.log('─'.repeat(60));
        for (const [source, count] of Object.entries(this.stats.fetched)) {
            console.log(`   ${source}: ${count} fetched`);
        }
        console.log(`   Total normalized: ${this.stats.normalized}`);
        console.log(`   After dedup: ${this.stats.deduplicated}`);
        console.log(`   Blocked (NSFW): ${this.stats.blocked}`);
        console.log(`   Final output: ${this.stats.output}`);
        console.log(`   Duration: ${duration}s`);
        console.log('═'.repeat(60));

        return compliantEntities;
    }

    /**
     * Fetch from all enabled sources
     */
    async fetchAll() {
        const results = [];

        for (const [sourceName, sourceConfig] of Object.entries(this.config.sources)) {
            if (!sourceConfig.enabled) {
                console.log(`   ⏭️ Skipping ${sourceName} (disabled)`);
                continue;
            }

            try {
                const adapter = adapters[sourceName];
                if (!adapter) {
                    console.warn(`   ⚠️ Unknown adapter: ${sourceName}`);
                    continue;
                }

                const entities = await adapter.fetch(sourceConfig.options);
                this.stats.fetched[sourceName] = entities.length;

                results.push({
                    source: sourceName,
                    adapter: adapter,
                    entities: entities
                });
            } catch (error) {
                console.error(`   ❌ Error fetching ${sourceName}: ${error.message}`);
                this.stats.fetched[sourceName] = 0;
            }
        }

        return results;
    }

    /**
     * Normalize all fetched entities
     */
    normalizeAll(fetchResults) {
        const normalized = [];

        for (const { source, adapter, entities } of fetchResults) {
            console.log(`   Processing ${entities.length} from ${source}...`);

            for (const raw of entities) {
                try {
                    const entity = adapter.normalize(raw);
                    normalized.push(entity);
                } catch (error) {
                    console.warn(`   ⚠️ Normalization error: ${error.message}`);
                }
            }
        }

        this.stats.normalized = normalized.length;
        console.log(`   ✓ Normalized ${normalized.length} entities`);

        return normalized;
    }

    /**
     * Deduplicate entities by ID
     */
    deduplicate(entities) {
        if (!this.config.deduplication.enabled) {
            this.stats.deduplicated = entities.length;
            return entities;
        }

        const seen = new Map();

        for (const entity of entities) {
            if (!entity.id) continue;

            if (seen.has(entity.id)) {
                if (this.config.deduplication.mergeStats) {
                    const existing = seen.get(entity.id);
                    // Merge popularity
                    existing.popularity = Math.max(existing.popularity || 0, entity.popularity || 0);
                    // Merge tags
                    const tagSet = new Set([...(existing.tags || []), ...(entity.tags || [])]);
                    existing.tags = Array.from(tagSet);
                    // Keep longer content
                    if ((entity.body_content?.length || 0) > (existing.body_content?.length || 0)) {
                        existing.body_content = entity.body_content;
                        existing.description = entity.description;
                    }
                }
            } else {
                seen.set(entity.id, entity);
            }
        }

        const unique = Array.from(seen.values());
        this.stats.deduplicated = unique.length;
        console.log(`   ✓ Deduplicated: ${entities.length} → ${unique.length}`);

        return unique;
    }

    /**
     * Filter entities by compliance status
     */
    filterCompliance(entities) {
        if (!this.config.compliance.blockNSFW) {
            return entities;
        }

        const compliant = entities.filter(e => {
            if (e.compliance_status === 'blocked') {
                this.stats.blocked++;
                return false;
            }
            return true;
        });

        console.log(`   ✓ Blocked ${this.stats.blocked} NSFW entities`);

        return compliant;
    }

    /**
     * Save output to JSON file
     */
    async saveOutput(entities) {
        // Ensure output directory exists
        if (!fs.existsSync(OUTPUT_DIR)) {
            fs.mkdirSync(OUTPUT_DIR, { recursive: true });
        }

        // Transform to output format (matching Rust processor expectations)
        const output = entities.map(e => ({
            id: e.id,
            name: e.title,
            author: e.author,
            description: e.description,
            tags: e.tags,
            pipeline_tag: e.meta_json?.pipeline_tag || 'other',
            likes: e.popularity || 0,
            downloads: e.downloads || 0,
            source: e.source,
            source_url: e.source_url,
            image_url: e.raw_image_url,
            // V3.2 fields
            type: e.type,
            body_content: e.body_content,
            meta_json: JSON.stringify(e.meta_json || {}),
            assets_json: JSON.stringify(e.assets || []),
            relations_json: JSON.stringify(e.relations || []),
            canonical_id: e.canonical_id || null,
            license_spdx: e.license_spdx,
            compliance_status: e.compliance_status,
            quality_score: e.quality_score,
            content_hash: e.content_hash,
            velocity: e.velocity || null,
            raw_image_url: e.raw_image_url,
            // Legacy V3.1 fields
            source_trail: JSON.stringify([{
                source_platform: e.source,
                source_url: e.source_url,
                fetched_at: new Date().toISOString(),
                adapter_version: '3.2.0'
            }]),
            commercial_slots: null, // Will be calculated by existing logic
            notebooklm_summary: null,
            velocity_score: e.velocity || 0,
            last_commercial_at: null
        }));

        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
        this.stats.output = output.length;

        console.log(`   ✓ Saved ${output.length} entities to ${OUTPUT_FILE}`);
    }
}

/**
 * Main entry point
 */
async function main() {
    const orchestrator = new Orchestrator();
    await orchestrator.run();
}

// Run if executed directly
main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

export default Orchestrator;
