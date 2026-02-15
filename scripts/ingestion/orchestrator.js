/**
 * Ingestion Pipeline Orchestrator
 * Coordinates fetch → normalize → dedup → compliance → output
 * @module ingestion/orchestrator
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { adapters, getAdapterNames } from './adapters/index.js';
import { deduplicateEntities } from './deduplicator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Output paths
const OUTPUT_DIR = path.join(__dirname, '../../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'merged.json');
const STATE_FILE = path.join(OUTPUT_DIR, '.harvest-state.json');  // V16.4.3 Restoration

// Config and output
import { DEFAULT_CONFIG } from './ingestion-config.js';
import { saveOutput } from './output-mapper.js';
import { RegistryManager } from '../factory/lib/registry-manager.js';
import { loadState, saveState } from './state-helper.js'; // V16.4.4: Art 5.1 Compliance Extraction

/** Orchestrator Class */
export class Orchestrator {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        // V6.2: Support incremental mode
        this.mode = config.mode || 'full';  // 'full' | 'incremental'
        this.state = loadState(STATE_FILE);
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
        console.log(`🚀 V16.4.3 Universal Ingestion Pipeline [${this.mode.toUpperCase()}]`);
        console.log('═'.repeat(60));

        const startTime = Date.now();

        // Phase 0: Load Global Registry (V18.2.4: Load before fetch for pre-comparison)
        console.log('\n🧠 Phase 0: Loading Global Registry...');
        const registryManager = new RegistryManager();
        await registryManager.load();

        // Phase 1: Fetch from all sources
        console.log('\n📥 Phase 1: Fetching from sources...');
        const rawEntities = await this.fetchAll(registryManager);

        // Phase 2: Normalize to unified schema
        console.log('\n🔄 Phase 2: Normalizing to unified schema...');
        const normalizedEntities = this.normalizeAll(rawEntities);

        // Phase 2.5: Registry Integration (Already loaded in Phase 0)
        console.log('\n🧠 Phase 2.5: Registry Ready.');

        // Phase 3: Deduplicate
        console.log('\n✨ Phase 3: Deduplicating...');
        const uniqueEntities = this.deduplicate(normalizedEntities);

        // Phase 3.5: Merging batches with Archive (Knowledge Continuity)
        console.log(`\n🔗 Phase 3.5: Merging batches with ${registryManager.entities.length} existing entities...`);
        const registry = await registryManager.mergeCurrentBatch(uniqueEntities);
        const fullEntities = registry.entities;

        // V18.2.1 GA: Persist the full merged registry into sharded parts (V2.0 Core)
        // This ensures unharvested entities are preserved and FNI decay is saved.
        await registryManager.save();

        // Phase 4: Compliance filtering
        console.log('\n🛡️ Phase 4: Compliance check...');
        const compliantEntities = this.filterCompliance(fullEntities);

        // Phase 5: Output (Sharded Persistence)
        // V18.2.1 GA: We restore the full registry output by passing compliantEntities.
        // The saveOutput function now handles sharding internally to bypass V8 string limits.
        console.log('\n💾 Phase 5: Saving sharded output (Full Registry)...');
        this.stats.output = await saveOutput(compliantEntities, OUTPUT_DIR, OUTPUT_FILE);

        // V6.2: Save harvest state for incremental mode
        this.state.lastRun.global = new Date().toISOString();
        saveState(STATE_FILE, this.state);

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
    async fetchAll(registryManager) {
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

                // V18.2.4: Rotational Sampling (Prevent Timeout, Achieve Coverage)
                const currentOffset = this.state.lastRun[sourceName]?.offset || 0;
                const limit = sourceConfig.options.limit || 5000;
                const nextOffset = (currentOffset + limit > 150000) ? 0 : currentOffset + limit;

                console.log(`   🔄 Rotational Offset [${sourceName}]: ${currentOffset} → next: ${nextOffset}`);

                // V6.2: Use multi-strategy for HuggingFace to bypass 1K API limit
                let entities;
                if (sourceName === 'huggingface' && sourceConfig.options.limit > 1000 && adapter.fetchMultiStrategy) {
                    console.log(`   📊 Using multi-strategy for HuggingFace (limit: ${sourceConfig.options.limit})...`);
                    const result = await adapter.fetchMultiStrategy({
                        limitPerStrategy: Math.ceil(sourceConfig.options.limit / 4),
                        full: sourceConfig.options.full !== false,
                        registryManager,
                        offset: currentOffset // Enable wheel rotation
                    });
                    entities = result.models;
                } else {
                    entities = await adapter.fetch({
                        ...sourceConfig.options,
                        registryManager,
                        offset: currentOffset // Enable wheel rotation
                    });
                }

                // Update state
                if (!this.state.lastRun[sourceName]) this.state.lastRun[sourceName] = {};
                this.state.lastRun[sourceName].offset = nextOffset;
                this.state.lastRun[sourceName].timestamp = new Date().toISOString();

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
        const unique = deduplicateEntities(entities, this.config.deduplication);
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
