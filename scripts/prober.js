
/**
 * UserJourneyProber (V16.11)
 * Strategic Structural Audit of the Knowledge Mesh.
 * Focus: Icon consistency (Model=🧠 vs Agent=🤖) and 404 Prevention.
 */

import { fetchEntityFromR2 } from '../src/utils/entity-cache-reader-core.js';
import { getMeshProfile } from '../src/utils/mesh-orchestrator.js';
import { getRouteFromId, getTypeFromId } from '../src/utils/mesh-routing-core.js';

const TEST_SAMPLES = [
    { id: 'meta-llama/Llama-3-8B', type: 'model', expectedIcon: '🧠' },
    { id: 'lavague-ai/lavague', type: 'agent', expectedIcon: '🤖' },
    { id: 'deepseek-ai/DeepSeek-V3', type: 'model', expectedIcon: '🧠' },
    { id: 'sciphi-ai/r2r', type: 'agent', expectedIcon: '🤖' },
    { id: 'ncnn', type: 'tool', expectedIcon: '⚙️' },
    { id: 'arxiv:2305.01264', type: 'paper', expectedIcon: '📄' },
    { id: 'knowledge--rag', type: 'knowledge', expectedIcon: '🎓' }
];

async function probeEntity(id, type, expectedIcon) {
    console.log(`\n🔍 PROBING: [${type.toUpperCase()}] ${id}`);

    try {
        // 1. Resolve Profile
        const profile = await getMeshProfile({ runtime: { env: {} } }, id, null, type);

        // 2. Audit Discovery Nodes
        let totalLinks = 0;
        let errors = [];

        Object.entries(profile.tiers).forEach(([tierName, tier]) => {
            tier.nodes.forEach(node => {
                totalLinks++;
                const actualType = getTypeFromId(node.id);
                const actualIcon = node.icon;

                // Consistency Check: Icon vs Type
                if (actualType === 'model' && actualIcon !== '🧠') errors.push(`Mismatch: Model ${node.id} has icon ${actualIcon}`);
                if (actualType === 'agent' && actualIcon !== '🤖') errors.push(`Mismatch: Agent ${node.id} has icon ${actualIcon}`);
                if (actualType === 'knowledge' && actualIcon !== '🎓') errors.push(`Mismatch: Knowledge ${node.id} has icon ${actualIcon}`);
            });
        });

        console.log(`  - Mesh Links Checked: ${totalLinks}`);
        if (errors.length > 0) {
            console.error(`  - ❌ INCONSISTENCIES FOUND:`);
            errors.forEach(e => console.error(`    * ${e}`));
        } else {
            console.log(`  - ✅ Identity Sync: All icons match their respective types.`);
        }

    } catch (e) {
        console.error(`  - 💥 CRASH: ${e.message}`);
    }
}

async function runAudit() {
    console.log("=== KNOWLEDGE MESH STRATEGIC AUDIT V16.11 ===");
    for (const sample of TEST_SAMPLES) {
        await probeEntity(sample.id, sample.type, sample.expectedIcon);
    }
    console.log("\n--- Audit Complete ---");
}

runAudit();
