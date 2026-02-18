/**
 * Ingestion Pipeline Orchestrator V19.0 — Streaming Architecture
 * Coordinates fetch → normalize → merge PER SOURCE (streaming)
 * 
 * V19.0 Changes:
 *   - Replaced fetchAll() accumulator with per-source streaming merge
 *   - Each source is fetched, normalized, deduped, and merged immediately
 *   - Peak memory: single_source + registry (vs. all_sources combined)
 *   - Zero data loss: RegistryManager UPSERT preserves all existing entities
 * 
 * @module ingestion/orchestrator
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { adapters } from './adapters/index.js';
import { deduplicateEntities } from './deduplicator.js';
import { fetchSource } from './lib/source-fetcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Output paths
const OUTPUT_DIR = path.join(__dirname, '../../data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'merged.json');
const STATE_FILE = path.join(OUTPUT_DIR, '.harvest-state.json');

// Config and output
import { DEFAULT_CONFIG } from './ingestion-config.js';
import { saveOutput } from './output-mapper.js';
import { RegistryManager } from '../factory/lib/registry-manager.js';
import { loadState, saveState } from './state-helper.js';

/** Orchestrator Class — V19.0 Streaming */
export class Orchestrator {
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.mode = config.mode || 'full';
        this.state = loadState(STATE_FILE);
        this.stats = { fetched: {}, normalized: 0, deduplicated: 0, blocked: 0, output: 0 };
    }

    /** Run the complete ingestion pipeline (V19.0 Streaming) */
    async run() {
        console.log('═'.repeat(60));
        console.log(`🚀 V19.0 Streaming Ingestion Pipeline [${this.mode.toUpperCase()}]`);
        console.log('═'.repeat(60));
        const startTime = Date.now();

        // Phase 0: Load Global Registry (all existing entities as 'archived')
        console.log('\n🧠 Phase 0: Loading Global Registry...');
        const registryManager = new RegistryManager();
        await registryManager.load();
        console.log(`   ✅ Registry loaded: ${registryManager.count} existing entities preserved.`);

        // Phase 1-3: Stream-Merge per source
        console.log('\n📥 Phase 1-3: Stream-Fetch-Merge per source...');
        await this.streamFetchAndMerge(registryManager);

        // Phase 4: Save merged registry (ALL entities: active + archived)
        console.log('\n💾 Phase 4: Persisting full registry...');
        await registryManager.save();

        // Phase 5: Export compliant entities for downstream
        console.log('\n🛡️ Phase 5: Compliance filtering & sharded output...');
        const allEntities = await this.loadFinalEntities();
        const compliantEntities = this.filterCompliance(allEntities);
        this.stats.output = await saveOutput(compliantEntities, OUTPUT_DIR, OUTPUT_FILE);

        // Save harvest state
        this.state.lastRun.global = new Date().toISOString();
        saveState(STATE_FILE, this.state);

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log('\n' + '═'.repeat(60));
        console.log(`📊 Pipeline Summary (${this.mode} — V19.0 Streaming):`);
        Object.entries(this.stats.fetched).forEach(([s, c]) => console.log(`   ${s}: ${c}`));
        console.log(`   Normalized: ${this.stats.normalized} | Blocked: ${this.stats.blocked}`);
        console.log(`   Final Output: ${this.stats.output} | Time: ${duration}s`);
        console.log(`   Registry Total: ${registryManager.count} (active + archived)`);
        console.log('═'.repeat(60));
        return compliantEntities;
    }

    /**
     * V19.0: Stream-Fetch-Merge — process one source at a time
     * Data preservation: mergeCurrentBatch() does UPSERT, entities not
     * re-fetched remain as 'archived' with FNI decay applied.
     */
    async streamFetchAndMerge(registryManager) {
        for (const [sourceName, sourceConfig] of Object.entries(this.config.sources)) {
            if (!sourceConfig.enabled) {
                console.log(`   ⏭️ Skipping ${sourceName} (disabled)`);
                continue;
            }
            try {
                // Step 1: Fetch (only this source in RAM)
                console.log(`\n   📥 [${sourceName}] Fetching...`);
                const rawEntities = await fetchSource(sourceName, sourceConfig, this.state, registryManager);
                this.stats.fetched[sourceName] = rawEntities.length;

                if (rawEntities.length === 0) {
                    console.log(`   ⏭️ [${sourceName}] No entities fetched, skipping.`);
                    continue;
                }

                // Step 2: Normalize in-flight
                console.log(`   🔄 [${sourceName}] Normalizing ${rawEntities.length} entities...`);
                const adapter = adapters[sourceName];
                const normalized = [];
                for (const raw of rawEntities) {
                    try { normalized.push(adapter.normalize(raw)); } catch (_) { /* skip malformed */ }
                }
                this.stats.normalized += normalized.length;

                // Step 3: Deduplicate within this source
                const unique = deduplicateEntities(normalized, this.config.deduplication);
                console.log(`   ✨ [${sourceName}] Dedup: ${normalized.length} → ${unique.length}`);

                // Step 4: Merge into registry (UPSERT — preserves old data)
                console.log(`   🔗 [${sourceName}] Merging ${unique.length} into registry...`);
                await registryManager.mergeCurrentBatch(unique);
                console.log(`   ✅ [${sourceName}] Complete. Registry: ${registryManager.count} total.`);
            } catch (error) {
                console.error(`   ❌ Error processing ${sourceName}: ${error.message}`);
                this.stats.fetched[sourceName] = 0;
            }
        }
    }

    /** Load final entities from registry shards for output */
    async loadFinalEntities() {
        const { loadRegistryShardsSequentially } = await import('../factory/lib/registry-loader.js');
        const entities = [];
        await loadRegistryShardsSequentially(async (batch) => {
            entities.push(...batch);
        }, { slim: false });
        console.log(`   📦 Loaded ${entities.length} entities for compliance filter.`);
        return entities;
    }

    /** Filter entities by compliance status */
    filterCompliance(entities) {
        if (!this.config.compliance.blockNSFW) return entities;
        const compliant = entities.filter(e => {
            if (e.compliance_status === 'blocked') { this.stats.blocked++; return false; }
            return true;
        });
        console.log(`   ✓ Blocked ${this.stats.blocked} NSFW entities`);
        return compliant;
    }
}

/** Main entry point */
async function main() {
    const orchestrator = new Orchestrator();
    await orchestrator.run();
}

main().catch(err => { console.error('❌ Fatal error:', err); process.exit(1); });
export default Orchestrator;
