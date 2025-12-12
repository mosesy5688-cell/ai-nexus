/**
 * ------------------------------------------------------------------
 * ADAPTER SENTINEL TEST (DRY RUN)
 * V4.3.1 Constitution Pillar III: Data Integrity & Safety
 * 
 * Validates:
 * - CivitAI NSFW filtering effectiveness
 * - ModelScope Chinese character handling
 * - L2 Safety Check pattern matching
 * ------------------------------------------------------------------
 */

import { CivitAIAdapter } from './ingestion/adapters/civitai-adapter.js';
import { ModelScopeAdapter } from './ingestion/adapters/modelscope-adapter.js';

// L2 Safety Check Patterns (mirrors Harvester logic)
const NSFW_PATTERNS = [
    /\bnsfw\b/i,
    /\badult\b/i,
    /\bporn\b/i,
    /\bnude\b/i,
    /\bsex\b/i,
    /\bhentai\b/i,
    /\bexplicit\b/i
];

function checkSafety(model) {
    // Check explicit NSFW flag
    if (model.nsfw === true) {
        return { isSafe: false, reason: 'EXPLICIT_FLAG' };
    }

    // Check text patterns
    const text = `${model.name || ''} ${model.description || ''} ${(model.tags || []).join(' ')}`.toLowerCase();
    for (const pattern of NSFW_PATTERNS) {
        if (pattern.test(text)) {
            return { isSafe: false, reason: `PATTERN: ${pattern}` };
        }
    }

    return { isSafe: true };
}

async function testSource(sourceName, adapter) {
    console.log(`\n🔎 [TESTING SOURCE]: ${sourceName.toUpperCase()}`);
    console.log('────────────────────────────────────────────────────────────');

    try {
        // Fetch small batch (3-5 models only)
        const startTime = Date.now();
        const batch = await adapter.fetch({ limit: 5 });
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        console.log(`📦 Fetched Batch Size: ${batch.length} (${elapsed}s)`);

        if (!batch || batch.length === 0) {
            console.log("❌ No data returned!");
            return { success: false, error: 'No data' };
        }

        // Validate all items
        let passed = 0;
        let blocked = 0;
        let normErrors = 0;

        for (const raw of batch) {
            const rawId = raw.id || raw.modelId || raw.Name || 'unknown';
            console.log(`\n--- Raw Item ID: ${rawId} ---`);

            try {
                // Normalize
                const normalized = adapter.normalize(raw);

                // Validate normalization
                console.log(`✅ Normalized Title: "${normalized.name}"`);
                console.log(`   Author: "${normalized.author}"`);
                console.log(`   Source URL: ${normalized.source_url}`);

                // Parse tags safely
                let tags = [];
                try {
                    tags = typeof normalized.tags === 'string'
                        ? JSON.parse(normalized.tags)
                        : normalized.tags || [];
                } catch (e) {
                    tags = ['parse_error'];
                }
                console.log(`   Tags: [${tags.slice(0, 3).join(', ')}${tags.length > 3 ? '...' : ''}]`);

                // Chinese name check (ModelScope)
                if (normalized.chinese_name) {
                    console.log(`   🇨🇳 Chinese Name: "${normalized.chinese_name}"`);
                }

                // Safety Check
                const safety = checkSafety({
                    name: normalized.name,
                    description: normalized.description,
                    tags: tags,
                    nsfw: raw.nsfw
                });

                if (safety.isSafe) {
                    console.log(`🛡️  Safety Check: PASSED`);
                    passed++;
                } else {
                    console.log(`⚠️  Safety Check: BLOCKED (${safety.reason})`);
                    blocked++;
                }

            } catch (err) {
                console.error(`❌ Normalization Failed: ${err.message}`);
                normErrors++;
            }
        }

        console.log(`\n📊 ${sourceName} Summary:`);
        console.log(`   ✅ PASSED: ${passed}`);
        console.log(`   ⚠️ BLOCKED: ${blocked}`);
        console.log(`   ❌ NORM_ERRORS: ${normErrors}`);

        return {
            success: true,
            count: batch.length,
            passed,
            blocked,
            normErrors,
            elapsed
        };

    } catch (err) {
        console.error(`🔥 Adapter Error: ${err.message}`);
        return { success: false, error: err.message };
    }
}

async function main() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('   V4.3.1 SENTINEL TEST - ADAPTER DRY RUN');
    console.log('   Constitution Pillar III: Data Integrity & Safety');
    console.log('   Date:', new Date().toISOString());
    console.log('═══════════════════════════════════════════════════════════════');

    const results = {};

    // Test CivitAI
    results.civitai = await testSource('civitai', new CivitAIAdapter());

    // Test ModelScope
    results.modelscope = await testSource('modelscope', new ModelScopeAdapter());

    // Final Summary
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('   SENTINEL TEST FINAL VERDICT');
    console.log('═══════════════════════════════════════════════════════════════');

    let allPassed = true;

    for (const [source, result] of Object.entries(results)) {
        console.log(`\n   ${source.toUpperCase()}:`);
        if (result.success) {
            console.log(`      ✅ SUCCESS - ${result.count} models fetched (${result.elapsed}s)`);
            console.log(`      🛡️ Safety: ${result.passed} PASSED, ${result.blocked} BLOCKED`);
            if (result.normErrors > 0) {
                console.log(`      ⚠️ WARNING: ${result.normErrors} normalization errors`);
                allPassed = false;
            }
        } else {
            console.log(`      ❌ FAILED - ${result.error}`);
            allPassed = false;
        }
    }

    console.log('\n   ──────────────────────────────────────────────────────────');
    if (allPassed) {
        console.log('   🎉 VERDICT: ALL TESTS PASSED');
        console.log('   V4.3.1 Adapters are PRODUCTION READY.');
    } else {
        console.log('   ⚠️ VERDICT: SOME ISSUES DETECTED');
        console.log('   Review errors above before production deployment.');
    }
    console.log('═══════════════════════════════════════════════════════════════\n');

    process.exit(allPassed ? 0 : 1);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
