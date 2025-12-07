/**
 * Multi-Source Fetcher with V3.1 Schema Support
 * 
 * This is the Logic Layer of the Hybrid Ingestion Pipeline.
 * It orchestrates collectors, generates source_trail for audit,
 * and calculates commercial_slots for monetization.
 * 
 * Features:
 * - Imports existing collectors (HuggingFace, GitHub, PyTorch)
 * - Generates source_trail JSON for each model
 * - Calculates commercial_slots based on affiliate_rules.json
 * - Outputs processed data to data/merged.json
 * 
 * Usage: node scripts/multi-source-fetcher.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { collect as collectHuggingFace } from './collectors/huggingface.js';
import { collect as collectPyTorch } from './collectors/pytorch.js';
import { collect as collectGitHub } from './collectors/github.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Paths
const OUTPUT_FILE = path.join(__dirname, '../data/merged.json');
const RULES_FILE = path.join(__dirname, '../config/affiliate_rules.json');

// Load affiliate rules
function loadAffiliateRules() {
    try {
        const data = fs.readFileSync(RULES_FILE, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.warn('⚠️  Could not load affiliate_rules.json, using defaults:', error.message);
        return { rules: [], defaults: { fallback_slot: null }, settings: {} };
    }
}

/**
 * Generate source_trail for a model
 * This creates an audit trail of data origin
 */
function generateSourceTrail(model, collectorName) {
    const trail = [
        {
            source_platform: model.source || collectorName,
            source_url: model.source_url || null,
            fetched_at: new Date().toISOString(),
            raw_data_hash: hashString(JSON.stringify(model)),
            collector_version: '3.1.0'
        }
    ];
    return JSON.stringify(trail);
}

/**
 * Simple hash function for data integrity
 */
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(16);
}

/**
 * Check if a model matches a rule condition
 */
function checkCondition(model, condition) {
    const { field, operator, value } = condition;
    const fieldValue = model[field];

    switch (operator) {
        case 'equals':
            return fieldValue === value;
        case 'contains':
            if (Array.isArray(fieldValue)) {
                return fieldValue.some(v =>
                    typeof v === 'string' && v.toLowerCase().includes(value.toLowerCase())
                );
            }
            return typeof fieldValue === 'string' &&
                fieldValue.toLowerCase().includes(value.toLowerCase());
        case 'gt':
            return typeof fieldValue === 'number' && fieldValue > value;
        case 'lt':
            return typeof fieldValue === 'number' && fieldValue < value;
        case 'gte':
            return typeof fieldValue === 'number' && fieldValue >= value;
        case 'lte':
            return typeof fieldValue === 'number' && fieldValue <= value;
        default:
            return false;
    }
}

/**
 * Check if a model matches a rule
 */
function matchesRule(model, rule) {
    if (!rule.enabled) return false;

    const { operator, conditions } = rule.match;

    if (operator === 'AND') {
        return conditions.every(c => checkCondition(model, c));
    } else if (operator === 'OR') {
        return conditions.some(c => checkCondition(model, c));
    }
    return false;
}

/**
 * Calculate commercial_slots for a model based on affiliate rules
 */
function calculateCommercialSlots(model, rulesConfig) {
    const { rules, defaults, settings } = rulesConfig;
    const maxSlots = settings.max_slots_per_model || 2;
    const matchedSlots = [];

    // Sort rules by priority (higher first)
    const sortedRules = [...rules].sort((a, b) => b.priority - a.priority);

    for (const rule of sortedRules) {
        if (matchedSlots.length >= maxSlots) break;

        if (matchesRule(model, rule)) {
            matchedSlots.push({
                rule_id: rule.id,
                ...rule.slot,
                matched_at: new Date().toISOString()
            });
        }
    }

    // Add fallback slot if no matches and fallback exists
    if (matchedSlots.length === 0 && defaults?.fallback_slot) {
        matchedSlots.push({
            rule_id: 'fallback',
            ...defaults.fallback_slot,
            matched_at: new Date().toISOString()
        });
    }

    return matchedSlots.length > 0 ? JSON.stringify(matchedSlots) : null;
}

/**
 * Estimate model size from metadata
 */
function estimateModelSize(model) {
    // Try to extract size from various fields
    if (model.safetensors?.total) {
        return model.safetensors.total;
    }
    if (model.size_bytes) {
        return model.size_bytes;
    }
    // Estimate based on downloads/likes (rough heuristic)
    // Large models tend to have fewer downloads relative to likes
    return 0;
}

/**
 * Normalize and enrich a single model with V3.1 fields
 */
function enrichModel(model, collectorName, rulesConfig) {
    // Estimate size for commercial matching
    const estimatedSize = estimateModelSize(model);
    const enrichedModel = {
        ...model,
        size_bytes: estimatedSize
    };

    return {
        // Original fields
        id: model.id,
        name: model.name || model.modelId,
        author: model.author || model.owner?.login || 'unknown',
        description: model.description || '',
        likes: model.likes || model.stargazers_count || 0,
        downloads: model.downloads || 0,
        tags: model.tags || [],
        pipeline_tag: model.pipeline_tag || 'other',
        source: model.source || collectorName,
        source_url: model.source_url || null,

        // V3.1 New Fields
        source_trail: generateSourceTrail(model, collectorName),
        commercial_slots: calculateCommercialSlots(enrichedModel, rulesConfig),
        notebooklm_summary: null, // To be filled by Loop 2 Enricher
        velocity_score: null,     // To be calculated by Loop 5 Analyst
        last_commercial_at: null  // To be updated by Loop 6 Merchant
    };
}

/**
 * Filter NSFW content
 */
const NSFW_KEYWORDS = [
    'nsfw', 'porn', 'sexy', 'explicit', 'erotic',
    'nude', 'naked', 'adult', 'xxx', 'hentai'
];

function isNsfw(model) {
    const name = (model.name || '').toLowerCase();
    const description = (model.description || '').toLowerCase();
    const tags = (model.tags || []).map(t => typeof t === 'string' ? t.toLowerCase() : '');

    for (const keyword of NSFW_KEYWORDS) {
        if (name.includes(keyword) || description.includes(keyword) || tags.includes(keyword)) {
            return true;
        }
    }
    return false;
}

/**
 * Deduplicate models by ID
 */
function deduplicateModels(models) {
    const seen = new Map();

    for (const model of models) {
        if (!model.id) continue;

        if (seen.has(model.id)) {
            const existing = seen.get(model.id);
            // Merge stats
            existing.likes = (existing.likes || 0) + (model.likes || 0);
            existing.downloads = (existing.downloads || 0) + (model.downloads || 0);
            // Merge tags
            const tagSet = new Set([...(existing.tags || []), ...(model.tags || [])]);
            existing.tags = Array.from(tagSet);
            // Keep longer description
            if ((model.description || '').length > (existing.description || '').length) {
                existing.description = model.description;
            }
        } else {
            seen.set(model.id, model);
        }
    }

    return Array.from(seen.values());
}

/**
 * Main function
 */
async function main() {
    console.log('🚀 Starting Multi-Source Fetcher (V3.1 Hybrid Pipeline)');
    console.log('─'.repeat(60));

    // Load affiliate rules
    const rulesConfig = loadAffiliateRules();
    console.log(`📋 Loaded ${rulesConfig.rules?.length || 0} affiliate rules`);

    // Run collectors in parallel
    console.log('\n📥 Fetching from all sources...');
    const results = await Promise.allSettled([
        collectHuggingFace().then(data => ({ source: 'huggingface', data })),
        collectPyTorch().then(data => ({ source: 'pytorch', data })),
        collectGitHub().then(data => ({ source: 'github', data }))
    ]);

    // Process results
    let allModels = [];
    const stats = { huggingface: 0, pytorch: 0, github: 0 };

    for (const result of results) {
        if (result.status === 'fulfilled') {
            const { source, data } = result.value;
            stats[source] = data.length;
            allModels.push(...data.map(m => ({ ...m, source })));
        } else {
            console.error('❌ Collector failed:', result.reason);
        }
    }

    console.log('\n📊 Collection Summary:');
    console.log(`   HuggingFace: ${stats.huggingface} models`);
    console.log(`   PyTorch:     ${stats.pytorch} models`);
    console.log(`   GitHub:      ${stats.github} models`);
    console.log(`   Total Raw:   ${allModels.length} models`);

    // Filter NSFW
    const safeModels = allModels.filter(m => !isNsfw(m));
    console.log(`\n🛡️ NSFW Filter: Removed ${allModels.length - safeModels.length} models`);

    // Deduplicate
    const uniqueModels = deduplicateModels(safeModels);
    console.log(`✨ Deduplication: ${uniqueModels.length} unique models`);

    // Enrich with V3.1 fields
    console.log('\n🔄 Enriching with V3.1 Schema fields...');
    const enrichedModels = uniqueModels.map(m =>
        enrichModel(m, m.source, rulesConfig)
    );

    // Count commercial slots
    const withCommercial = enrichedModels.filter(m => m.commercial_slots).length;
    console.log(`💰 Commercial Slots: ${withCommercial}/${enrichedModels.length} models matched rules`);

    // Ensure output directory exists
    const outputDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Write output
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(enrichedModels, null, 2));
    console.log(`\n✅ Saved ${enrichedModels.length} models to ${OUTPUT_FILE}`);

    // Summary
    console.log('\n' + '─'.repeat(60));
    console.log('📦 Output Schema V3.1 Fields:');
    console.log('   ├─ source_trail: ✅ Generated for all models');
    console.log('   ├─ commercial_slots: ✅ Calculated based on rules');
    console.log('   ├─ notebooklm_summary: ⏳ Pending (Loop 2)');
    console.log('   ├─ velocity_score: ⏳ Pending (Loop 5)');
    console.log('   └─ last_commercial_at: ⏳ Pending (Loop 6)');
}

main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});
