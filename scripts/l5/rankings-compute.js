/**
 * L5 Rankings Compute Script
 * 
 * B.11 Heavy Computation Migration
 * Generates category rankings from FNI results
 * V1.1-LOCK: Manifest enforcement enabled
 * 
 * @module l5/rankings-compute
 */

import fs from 'fs';
import path from 'path';
import { enforceUpstreamComplete } from './manifest-utils.js';

// V1.1-LOCK: Enforce upstream manifest completeness
const L1_MANIFEST = 'data/manifest.json';
if (fs.existsSync(L1_MANIFEST)) {
    try { enforceUpstreamComplete(L1_MANIFEST); }
    catch (e) { console.error('⛔ Manifest Enforcement:', e.message); process.exit(1); }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // V6 Constitution limit

/**
 * Load FNI results from batch files
 */
function loadFNIResults(computedDir) {
    const results = [];
    const files = fs.readdirSync(computedDir)
        .filter(f => f.startsWith('fni_batch_') && f.endsWith('.json'));

    for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(computedDir, file), 'utf8'));
        results.push(...data);
    }

    console.log(`📦 Loaded ${results.length} FNI results from ${files.length} batch files`);
    return results;
}

/**
 * Generate rankings for a specific category
 */
function generateCategoryRankings(entities, category, outputDir) {
    const categoryDir = path.join(outputDir, category);
    if (!fs.existsSync(categoryDir)) {
        fs.mkdirSync(categoryDir, { recursive: true });
    }

    // Sort by FNI score
    const sorted = entities.sort((a, b) => b.fni_score - a.fni_score);

    // Paginate
    const totalPages = Math.min(MAX_PAGES, Math.ceil(sorted.length / PAGE_SIZE));

    for (let page = 1; page <= totalPages; page++) {
        const start = (page - 1) * PAGE_SIZE;
        const end = start + PAGE_SIZE;
        const pageData = sorted.slice(start, end);

        const pageFile = path.join(categoryDir, `p${page}.json`);
        fs.writeFileSync(pageFile, JSON.stringify({
            page,
            total_pages: totalPages,
            total_items: sorted.length,
            items: pageData
        }, null, 2));
    }

    console.log(`   ✅ ${category}: ${totalPages} pages, ${sorted.length} entities`);
    return { category, pages: totalPages, entities: sorted.length };
}

/**
 * Compute all rankings from FNI results
 */
export async function computeAllRankings(computedDir, outputDir) {
    console.log(`📊 Computing rankings...`);
    const startTime = Date.now();

    // Load FNI results
    const fniResults = loadFNIResults(computedDir);

    // Ensure output directory exists
    const rankingsDir = path.join(outputDir, 'rankings');
    if (!fs.existsSync(rankingsDir)) {
        fs.mkdirSync(rankingsDir, { recursive: true });
    }

    // Group by category
    const byCategory = {};
    const byEntityType = {};

    for (const entity of fniResults) {
        // By category
        const cat = entity.primary_category || 'uncategorized';
        if (!byCategory[cat]) byCategory[cat] = [];
        byCategory[cat].push(entity);

        // By entity type
        const type = entity.entity_type || 'model';
        if (!byEntityType[type]) byEntityType[type] = [];
        byEntityType[type].push(entity);
    }

    const categoryStats = [];

    // Generate category rankings
    console.log('\n📁 Category Rankings:');
    for (const [category, entities] of Object.entries(byCategory)) {
        const stats = generateCategoryRankings(entities, category, rankingsDir);
        categoryStats.push(stats);
    }

    // Generate entity type rankings
    console.log('\n📁 Entity Type Rankings:');
    for (const [type, entities] of Object.entries(byEntityType)) {
        generateCategoryRankings(entities, `_type_${type}`, rankingsDir);
    }

    // Generate overall trending (top 1000 by FNI - models/agents only)
    // Phase B.8: ≥3 knowledge links required for recommendation eligibility
    console.log('\n📁 Trending (Models/Agents only):');
    const FNI_ENTITY_TYPES = ['model', 'agent'];
    const MIN_RELATIONS_FOR_RECOMMENDATION = 3; // Constitution: Knowledge linking requirement

    const trendingModels = fniResults
        .filter(e => FNI_ENTITY_TYPES.includes(e.entity_type) || !e.entity_type)
        .sort((a, b) => b.fni_score - a.fni_score)
        .slice(0, 1000);

    // Separate into recommended (≥3 links) and standard
    const recommendedModels = trendingModels.filter(e =>
        (e.relations_count || 0) >= MIN_RELATIONS_FOR_RECOMMENDATION
    );
    const standardModels = trendingModels.filter(e =>
        (e.relations_count || 0) < MIN_RELATIONS_FOR_RECOMMENDATION
    );

    console.log(`   📊 Knowledge Linking: ${recommendedModels.length} models have ≥${MIN_RELATIONS_FOR_RECOMMENDATION} relations (recommendation eligible)`);
    console.log(`   📊 Standard: ${standardModels.length} models have <${MIN_RELATIONS_FOR_RECOMMENDATION} relations`);

    fs.writeFileSync(

        path.join(outputDir, 'trending.json'),
        JSON.stringify(trendingModels, null, 2)
    );
    console.log(`   ✅ trending.json: ${trendingModels.length} models/agents`);

    // V6.0.1: Category metadata for frontend display
    const CATEGORY_METADATA = {
        'text-generation': { label: 'Text Generation & Content Creation', icon: '💬', color: '#6366f1' },
        'knowledge-retrieval': { label: 'Knowledge Retrieval & Data Analysis', icon: '🔍', color: '#10b981' },
        'vision-multimedia': { label: 'Vision & Multimedia Processing', icon: '🎨', color: '#f59e0b' },
        'automation-workflow': { label: 'Automation & Workflow Integration', icon: '⚡', color: '#8b5cf6' },
        'infrastructure-ops': { label: 'Infrastructure & Optimization', icon: '🔧', color: '#64748b' },
        'uncategorized': { label: 'Uncategorized', icon: '📦', color: '#9ca3af' }
    };

    // Generate V6.0.1 category stats with full metadata
    const categoryStatsV6 = categoryStats.map(s => {
        const meta = CATEGORY_METADATA[s.category] || CATEGORY_METADATA['uncategorized'];
        const categoryEntities = byCategory[s.category] || [];
        const fniScores = categoryEntities.map(e => e.fni_score || 0).filter(f => f > 0);
        const avgFni = fniScores.length > 0
            ? Math.round((fniScores.reduce((a, b) => a + b, 0) / fniScores.length) * 10) / 10
            : 0;
        const topFni = fniScores.length > 0 ? Math.max(...fniScores) : 0;

        return {
            category: s.category,
            label: meta.label,
            icon: meta.icon,
            color: meta.color,
            count: s.entities,
            trending: s.entities,
            avgFni,
            topFni
        };
    });

    const classifiedCount = fniResults.filter(e => e.primary_category && e.primary_category !== 'uncategorized').length;

    const stats = {
        generated_at: new Date().toISOString(),
        version: 'V6.0.1',
        categories: categoryStatsV6.filter(c => c.category !== 'uncategorized'),
        classified_count: classifiedCount,
        total_models: fniResults.length,
        total_categories: categoryStatsV6.filter(c => c.category !== 'uncategorized').length,
        pending_classification: {
            count: fniResults.length - classifiedCount,
            reason: 'missing_pipeline_tag',
            note: 'High-confidence classification only. Semantic inference in V6.1'
        }
    };

    fs.writeFileSync(
        path.join(outputDir, 'category_stats.json'),
        JSON.stringify(stats, null, 2)
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n✅ Rankings complete in ${elapsed}s`);

    return stats;
}

// CLI execution
if (process.argv[1].includes('rankings-compute')) {
    const computedDir = process.argv[2] || 'data/computed';
    const outputDir = process.argv[3] || 'data/cache';

    computeAllRankings(computedDir, outputDir)
        .then(stats => {
            console.log('\n📊 Summary:');
            console.log(`   Total: ${stats.total_entities}`);
            console.log(`   Categories: ${stats.categories.length}`);
        })
        .catch(err => {
            console.error('❌ Error:', err.message);
            process.exit(1);
        });
}

export default { computeAllRankings };
