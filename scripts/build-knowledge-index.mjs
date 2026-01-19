/**
 * Build Knowledge Search Index (Robust Version)
 * V15.5: Generates a static JSON index for unified search using regex to avoid TS dependencies.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = path.join(__dirname, '../src/data/knowledge-base-config.ts');
const OUTPUT_PATH = path.join(__dirname, '../public/data/knowledge-index.json');

async function buildIndex() {
    console.log('🔍 Building Knowledge Search Index (Regex Mode)...');

    if (!fs.existsSync(CONFIG_PATH)) {
        console.error(`❌ Config not found at ${CONFIG_PATH}`);
        process.exit(1);
    }

    const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const index = [];

    // Simple regex-based parser for the specific structure of knowledge-base-config.ts
    // This is more reliable than trying to execute TS in a node environment without setup.

    // Find category blocks
    const categoryRegex = /id:\s*'([^']+)',\s*title:\s*'([^']+)',\s*icon:\s*'[^']+',\s*description:\s*'([^']+)',\s*articles:\s*\[([\s\S]+?)\]/g;
    let categoryMatch;

    while ((categoryMatch = categoryRegex.exec(content)) !== null) {
        const [_, catId, catTitle, catDesc, articlesBlock] = categoryMatch;

        // Find article blocks within category
        const articleRegex = /\{\s*slug:\s*'([^']+)',\s*title:\s*'([^']+)',\s*description:\s*'([^']+)'/g;
        let articleMatch;

        while ((articleMatch = articleRegex.exec(articlesBlock)) !== null) {
            const [__, slug, title, description] = articleMatch;
            index.push({
                id: `kb--${slug}`,
                n: title,
                s: slug,
                d: description,
                cat: catId,
                t: 'knowledge'
            });
        }
    }

    if (index.length === 0) {
        console.warn('⚠️ No articles found. Check regex or config structure.');
        // Fallback: search for any slug/title pair if the above failed
        const fallbackRegex = /slug:\s*'([^']+)',\s*title:\s*'([^']+)',\s*description:\s*'([^']+)'/g;
        let m;
        while ((m = fallbackRegex.exec(content)) !== null) {
            index.push({ id: `kb--${m[1]}`, n: m[2], s: m[1], d: m[3], t: 'knowledge' });
        }
    }

    // Ensure directory exists
    const dir = path.dirname(OUTPUT_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(index, null, 2));
    console.log(`✅ Index built: ${index.length} articles -> ${OUTPUT_PATH}`);

    // V16: Generate R2-compatible cache format
    const r2Format = {
        _v: '15.6',
        _ts: new Date().toISOString(),
        articles: index.map(item => ({
            id: item.id,
            title: item.n,
            slug: item.s,
            description: item.d,
            category: item.cat,
            icon: item.id.includes('benchmark') ? '🧪' : '📚'
        }))
    };

    const R2_OUTPUT_PATH = path.join(__dirname, '../public/data/knowledge-cache.json');
    fs.writeFileSync(R2_OUTPUT_PATH, JSON.stringify(r2Format, null, 2));
    console.log(`✅ R2 Cache Format built: ${R2_OUTPUT_PATH}`);

    // Optional R2 Upload (Manual Trigger or CI)
    if (process.argv.includes('--upload')) {
        console.log('📤 Uploading to R2: cache/knowledge/index.json...');
        try {
            const { execSync } = await import('child_process');
            execSync(`npx wrangler r2 object put "ai-nexus-assets/cache/knowledge/index.json" --file="${R2_OUTPUT_PATH}" --remote`, { stdio: 'inherit' });
            console.log('✅ R2 Upload Success');
        } catch (e) {
            console.error('❌ R2 Upload Failed:', e.message);
        }
    }
}

try {
    buildIndex();
} catch (e) {
    console.error('❌ Failed to build index:', e);
    process.exit(1);
}
