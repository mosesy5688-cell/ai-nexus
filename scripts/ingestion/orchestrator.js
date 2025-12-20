/**
 * Ingestion Pipeline Orchestrator
 * Coordinates fetch → normalize → dedup → compliance → output
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
const STATE_FILE = path.join(OUTPUT_DIR, '.harvest-state.json');  // V6.2: Track last run

// Config and output
import { DEFAULT_CONFIG } from './ingestion-config.js';
import { saveOutput } from './output-mapper.js';

/** Orchestrator Class */
export class Orchestrator {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        // V6.2: Support incremental mode
        this.mode = config.mode || 'full';  // 'full' | 'incremental'
        this.state = this.loadState();
        this.stats = {
            fetched: {},
            normalized: 0,
            deduplicated: 0,
            blocked: 0,
            output: 0
        };
    }

    /** V6.2: Load harvest state */
    loadState() {
        try {
            if (fs.existsSync(STATE_FILE)) {
                return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
            }
        } catch (e) {
            console.warn('   ⚠️ Could not load harvest state');
        }
        return { lastRun: {}, version: '6.2' };
    }

    /** V6.2: Save harvest state */
    saveState() {
        try {
            fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
        } catch (e) {
            console.warn('   ⚠️ Could not save harvest state');
        }
    }

    /**
     * Run the complete ingestion pipeline
     */
    async run() {
        console.log('═'.repeat(60));
        console.log(`🚀 V6.2 Universal Ingestion Pipeline [${this.mode.toUpperCase()}]`);
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
        this.stats.output = await saveOutput(compliantEntities, OUTPUT_DIR, OUTPUT_FILE);

        // V6.2: Save harvest state for incremental mode
        this.state.lastRun.global = new Date().toISOString();
        this.saveState();

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Summary
        console.log('\n' + '═'.repeat(60));
        console.log(`📊 Pipeline Summary (${this.mode}):`);
        Object.entries(this.stats.fetched).forEach(([s, c]) => console.log(`   ${s}: ${c}`));
        console.log(`   Normalized: ${this.stats.normalized} | Dedup: ${this.stats.deduplicated} | Blocked: ${this.stats.blocked}`);
        console.log(`   Final: ${this.stats.output} | Time: ${duration}s`);
        console.log('═'.repeat(60));

        return compliantEntities;
    }

    /** Fetch from all enabled sources */
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

                // V6.2: Use multi-strategy for HuggingFace to bypass 1K API limit
                let entities;
                if (sourceName === 'huggingface' && sourceConfig.options.limit > 1000 && adapter.fetchMultiStrategy) {
                    console.log(`   📊 Using multi-strategy for HuggingFace (limit: ${sourceConfig.options.limit})...`);
                    const result = await adapter.fetchMultiStrategy({
                        limitPerStrategy: Math.ceil(sourceConfig.options.limit / 4),
                        full: sourceConfig.options.full !== false
                    });
                    entities = result.models;
                } else {
                    entities = await adapter.fetch(sourceConfig.options);
                }

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

    /** Normalize all fetched entities */
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

    /** Deduplicate entities by ID */
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

    /** Filter entities by compliance status */
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
