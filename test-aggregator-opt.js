import { mergePartitionedShard } from './scripts/factory/lib/aggregator-utils.js';
import fs from 'fs/promises';
import path from 'path';

async function testMerge() {
    console.log("🧪 testing Hash-Join Merge Logic...");

    // Mock Data
    const baseline = [
        { id: 'hf-model--meta-llama--llama-3-8b', name: 'Llama 3 8B', fni_score: 80 },
        { id: 'hf-model--google--gemma-7b', name: 'Gemma 7B', fni_score: 75 }
    ];

    const update = {
        id: 'hf-model--meta-llama--llama-3-8b',
        fni_score: 95,
        metrics: { downloads: 1000 }
    };

    const rankingsMap = new Map([
        ['hf-model--meta-llama--llama-3-8b', 99],
        ['hf-model--google--gemma-7b', 98]
    ]);

    // Setup temp delta file
    const deltaDir = './cache/deltas';
    await fs.mkdir(deltaDir, { recursive: true });
    await fs.writeFile(path.join(deltaDir, 'reg-0.jsonl'), JSON.stringify(update) + '\n');

    try {
        const result = await mergePartitionedShard(baseline, 0, rankingsMap, { slim: false });

        console.log("Result entities:", result.entities.length);
        const merged = result.entities.find(e => e.id === 'hf-model--meta-llama--llama-3-8b');

        if (merged && merged.fni_score === 95 && merged.fni_percentile === 99) {
            console.log("✅ Update correctly applied.");
        } else {
            console.error("❌ Update failed!", merged);
        }

        const untouched = result.entities.find(e => e.id === 'hf-model--google--gemma-7b');
        if (untouched && untouched.fni_score === 75 && untouched.fni_percentile === 98) {
            console.log("✅ Untouched entity preserved with correct ranking.");
        } else {
            console.error("❌ Untouched entity corrupted!", untouched);
        }

    } catch (e) {
        console.error("❌ Test failed with error:", e);
    } finally {
        // Cleanup
        await fs.unlink(path.join(deltaDir, 'reg-0.jsonl')).catch(() => { });
    }
}

testMerge();
