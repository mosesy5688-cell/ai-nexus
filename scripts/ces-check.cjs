const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log("🛡️  CES V5.1.2 Compliance Check Initiated...");

let failed = false;

// Helper to walk directory
function walkSync(dir, filelist = []) {
    fs.readdirSync(dir).forEach(file => {
        const dirFile = path.join(dir, file);
        try {
            if (fs.statSync(dirFile).isDirectory()) {
                if (!dirFile.includes('node_modules') && !dirFile.includes('.git') && !dirFile.includes('dist')) {
                    filelist = walkSync(dirFile, filelist);
                }
            } else {
                filelist.push(dirFile);
            }
        } catch (e) {
            // Ignore access errors
        }
    });
    return filelist;
}

// 1. Zero D1 Leaks (Art 3.1)
console.log("🔍 Checking Art 3.1: Zero D1 Leaks...");
const pagesDir = path.join(__dirname, '../src/pages');
const componentsDir = path.join(__dirname, '../src/components');
const filesToCheck = [...walkSync(pagesDir), ...walkSync(componentsDir)];

filesToCheck.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('env.DB') || content.includes('D1Database')) {
        console.error(`❌ VIOLATION: D1 usage detected in ${file}`);
        failed = true;
    }
});

// 2. Anti-Monolith (Art 1.3 - Max 250 lines)
console.log("🔍 Checking Art 1.3: Anti-Monolith (Max 250 lines)...");
const srcFiles = walkSync(path.join(__dirname, '../src'));
const workerFiles = walkSync(path.join(__dirname, '../workers'));
const allCodeFiles = [...srcFiles, ...workerFiles].filter(f => f.endsWith('.ts') || f.endsWith('.js') || f.endsWith('.astro'));

allCodeFiles.forEach(file => {
    if (file.endsWith('.d.ts')) return; // Skip types

    // TEMPORARY WHITELIST FOR PHASE 2 (Legacy Code)
    // Normalized to forward slashes for Cross-Platform CI (Linux/Windows)
    const LEGACY_WHITELIST = [
        'src/components/architecture/ArchitectureModule.astro',
        'src/components/entity/EntityShell.astro',
        'src/components/explore/ExploreFilters.astro',
        'src/components/GraphExplorer.astro',
        'src/components/ModelHero.astro',
        'src/components/NeuralGraphExplorer.astro',
        'src/components/specs/FamilyTree.astro',
        'src/data/entity-definitions.ts',



        'src/pages/knowledge.astro',
        'src/pages/leaderboard.astro',

        'src/pages/ranking/[category].astro',


        'src/utils/semantic-matcher.js',
        'src/utils/umid-resolver.js'
    ];

    // Normalize file path to forward slashes for cross-platform matching
    // file comes from path.join which is OS specific, so matching against "/" requires normalization
    const normalizedFile = file.split(path.sep).join('/');
    const isWhitelisted = LEGACY_WHITELIST.some(w => normalizedFile.includes(w));
    const lines = fs.readFileSync(file, 'utf8').split('\n').length;

    if (lines > 250) {
        if (isWhitelisted) {
            console.warn(`⚠️ WARNING: Legacy file exceeds 250 lines (${lines}): ${file}`);
        } else {
            console.error(`❌ VIOLATION: File exceeds 250 lines (${lines}): ${file}`);
            failed = true;
        }
    }
});

// 3. Hot Index Check (Art 2.1)
console.log("🔍 Checking Art 2.1: Hot Index Size...");
const hotIndex = path.join(__dirname, '../cache/index/index_hot.json.gz');
if (fs.existsSync(hotIndex)) {
    const stats = fs.statSync(hotIndex);
    if (stats.size > 500000) { // 500KB
        console.error(`❌ VIOLATION: Hot Index too large (${stats.size} bytes)`);
        failed = true;
    }
}

// 4. Pagination Cap (Art 3.3)
console.log("🔍 Checking Art 3.3: Pagination Cap (Max 50)...");
const rankingsDir = path.join(__dirname, '../cache/rankings/text-generation');
if (fs.existsSync(rankingsDir)) {
    const pages = fs.readdirSync(rankingsDir).filter(f => f.startsWith('p') && f.endsWith('.json.gz'));
    if (pages.length > 50) {
        console.error(`❌ VIOLATION: Too many ranking pages (${pages.length})`);
        failed = true;
    }
}

if (failed) {
    console.error("⛔ CES CHECK FAILED. FIX VIOLATIONS.");
    process.exit(1);
} else {
    console.log("✅ CES COMPLIANCE VERIFIED.");
    process.exit(0);
}
