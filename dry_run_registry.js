import fs from 'fs/promises';
import path from 'path';
import { normalizeId, getNodeSource } from './scripts/utils/id-normalizer.js';
import { mergeEntities } from './scripts/ingestion/lib/entity-merger.js';

async function dryRunRegistryMerge() {
    console.log('🧪 [DRY RUN] Starting Registry Baseline Analysis...');

    // 1. Load the same monolith baseline the pipeline uses
    const registryPath = './cache/global-registry.json';
    const data = await fs.readFile(registryPath, 'utf-8');
    const registry = JSON.parse(data);
    const entities = registry.entities || [];

    console.log(`📊 Baseline Count: ${entities.length}`);

    const registryMap = new Map();
    let collisionCount = 0;

    // 2. Simulate the fixed "Merge-on-Seed" logic
    for (const e of entities) {
        const source = getNodeSource(e.id, e.type);
        const id = normalizeId(e.id, source, e.type);

        if (registryMap.has(id)) {
            const existing = registryMap.get(id);
            // Simulate merging
            registryMap.set(id, mergeEntities(existing, e));
            collisionCount++;
        } else {
            registryMap.set(id, { ...e, id });
        }
    }

    const finalCount = registryMap.size;
    console.log(`\n📈 Results:`);
    console.log(`   - Potential Collisions (ArXiv Versions): ${collisionCount}`);
    console.log(`   - Final UNIQUE Total: ${finalCount}`);
    console.log(`   - Net Reduction: ${entities.length - finalCount}`);

    if (finalCount < 85000) {
        console.log(`\n⚠️  The "Clean Total" (${finalCount}) is below the current 85k safety floor.`);
        console.log(`    Recommendation: Adjust AGGREGATE_FLOOR to ~${Math.floor(finalCount * 0.95)}.`);
    } else {
        console.log(`\n✅ The "Clean Total" (${finalCount}) is still above the 85k floor.`);
        console.log(`    Confirming that the previous failure was PURELY due to Overwriting, not Deduplication.`);
    }
}

dryRunRegistryMerge().catch(console.error);
