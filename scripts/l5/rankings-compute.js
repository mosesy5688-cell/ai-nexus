/**
 * L5 Rankings Compute Script
 * 
 * B.11 Heavy Computation Migration
 * Generates category rankings from FNI results
 * 
 * @module l5/rankings-compute
 */

import fs from 'fs';
import path from 'path';

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

    // Generate overall trending (top 1000 by FNI)
    console.log('\n📁 Trending:');
    const trending = fniResults
        .sort((a, b) => b.fni_score - a.fni_score)
        .slice(0, 1000);

    fs.writeFileSync(
        path.join(outputDir, 'trending.json'),
        JSON.stringify(trending, null, 2)
    );
    console.log(`   ✅ trending.json: ${trending.length} entities`);

    // Generate category stats
    const stats = {
        generated_at: new Date().toISOString(),
        total_entities: fniResults.length,
        categories: categoryStats.map(s => ({
            name: s.category,
            count: s.entities,
            pages: s.pages
        }))
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
