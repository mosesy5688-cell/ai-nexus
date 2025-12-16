/**
 * SEO Compliance Audit Script
 * Per V5.2.1 Art 6.1-6.3
 * 
 * Checks:
 * - Art 6.1: Schema.org structured data presence
 * - Art 6.2: Title length, meta description, OG tags
 * - Art 6.3: Sitemap accessibility and lastmod
 */

const fs = require('fs');
const path = require('path');

console.log('📊 SEO Compliance Audit V5.2.1 Starting...\n');

let passed = 0;
let failed = 0;
let warnings = 0;

// Helper to walk directory
function walkSync(dir, filelist = []) {
    if (!fs.existsSync(dir)) return filelist;
    fs.readdirSync(dir).forEach(file => {
        const dirFile = path.join(dir, file);
        try {
            if (fs.statSync(dirFile).isDirectory()) {
                if (!dirFile.includes('node_modules') && !dirFile.includes('.git')) {
                    filelist = walkSync(dirFile, filelist);
                }
            } else {
                filelist.push(dirFile);
            }
        } catch (e) { /* ignore */ }
    });
    return filelist;
}

// ============================================
// Art 6.1: Schema.org Structured Data Check
// ============================================
console.log('🔍 Art 6.1: Checking Schema.org Structured Data...');

const schemaFiles = [
    'src/utils/seo-schema.js',
    'src/components/seo/SEOSchema.astro',
    'src/lib/schema.ts'
];

let schemaFound = false;
for (const file of schemaFiles) {
    const fullPath = path.join(__dirname, '..', file);
    if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes('schema.org')) {
            console.log(`   ✅ Schema.org found in ${file}`);
            schemaFound = true;
            passed++;
        }
    }
}

if (!schemaFound) {
    console.log('   ❌ No Schema.org implementation found');
    failed++;
}

// Check pages for ld+json script tags
const pagesDir = path.join(__dirname, '..', 'src/pages');
const layoutsDir = path.join(__dirname, '..', 'src/layouts');
let ldJsonFound = false;

const layoutFiles = walkSync(layoutsDir).filter(f => f.endsWith('.astro'));
for (const file of layoutFiles) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('application/ld+json')) {
        console.log(`   ✅ JSON-LD script found in layouts`);
        ldJsonFound = true;
        passed++;
        break;
    }
}

if (!ldJsonFound) {
    console.log('   ⚠️  JSON-LD not found in layout templates (may be page-specific)');
    warnings++;
}

// ============================================
// Art 6.2: SEO Meta Tags Check
// ============================================
console.log('\n🔍 Art 6.2: Checking SEO Meta Tags...');

const mainLayout = path.join(__dirname, '..', 'src/layouts/Layout.astro');
if (fs.existsSync(mainLayout)) {
    const content = fs.readFileSync(mainLayout, 'utf8');

    // Check for title tag
    if (content.includes('<title>') || content.includes('title=')) {
        console.log('   ✅ Title tag present');
        passed++;
    } else {
        console.log('   ❌ Title tag missing');
        failed++;
    }

    // Check for meta description
    if (content.includes('name="description"') || content.includes('description=')) {
        console.log('   ✅ Meta description present');
        passed++;
    } else {
        console.log('   ❌ Meta description missing');
        failed++;
    }

    // Check for Open Graph
    if (content.includes('og:title')) {
        console.log('   ✅ Open Graph (og:title) present');
        passed++;
    } else {
        console.log('   ❌ Open Graph tags missing');
        failed++;
    }

    // Check for canonical
    if (content.includes('rel="canonical"') || content.includes('canonical')) {
        console.log('   ✅ Canonical URL handling present');
        passed++;
    } else {
        console.log('   ⚠️  Canonical URL not found in layout');
        warnings++;
    }
} else {
    console.log('   ❌ Main layout file not found');
    failed++;
}

// ============================================
// Art 6.3: Sitemap Check
// ============================================
console.log('\n🔍 Art 6.3: Checking Sitemap...');

const robotsPath = path.join(__dirname, '..', 'src/pages/robots.txt.js');
if (fs.existsSync(robotsPath)) {
    const content = fs.readFileSync(robotsPath, 'utf8');
    if (content.includes('sitemap') || content.includes('Sitemap')) {
        console.log('   ✅ Sitemap reference in robots.txt');
        passed++;
    } else {
        console.log('   ⚠️  No sitemap reference in robots.txt');
        warnings++;
    }
}

// Check for @astrojs/sitemap in package.json
const packagePath = path.join(__dirname, '..', 'package.json');
if (fs.existsSync(packagePath)) {
    const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (deps['@astrojs/sitemap']) {
        console.log('   ✅ @astrojs/sitemap installed');
        passed++;
    } else {
        console.log('   ⚠️  @astrojs/sitemap not found in dependencies');
        warnings++;
    }
}

// Check for sitemap in dist after build
const sitemapPath = path.join(__dirname, '..', 'dist/sitemap-index.xml');
if (fs.existsSync(sitemapPath)) {
    const content = fs.readFileSync(sitemapPath, 'utf8');
    if (content.includes('lastmod')) {
        console.log('   ✅ Sitemap includes lastmod timestamps');
        passed++;
    } else {
        console.log('   ⚠️  Sitemap missing lastmod timestamps');
        warnings++;
    }
} else {
    console.log('   ⚠️  Sitemap not found in dist/ (run build first)');
    warnings++;
}

// ============================================
// Summary
// ============================================
console.log('\n═══════════════════════════════════════');
console.log('📊 SEO AUDIT SUMMARY');
console.log('═══════════════════════════════════════');
console.log(`   ✅ Passed:   ${passed}`);
console.log(`   ⚠️  Warnings: ${warnings}`);
console.log(`   ❌ Failed:   ${failed}`);
console.log('═══════════════════════════════════════\n');

if (failed > 0) {
    console.log('⛔ SEO AUDIT FAILED - Fix issues above');
    process.exit(1);
} else if (warnings > 0) {
    console.log('⚠️  SEO AUDIT PASSED WITH WARNINGS');
    process.exit(0);
} else {
    console.log('✅ SEO AUDIT PASSED');
    process.exit(0);
}
