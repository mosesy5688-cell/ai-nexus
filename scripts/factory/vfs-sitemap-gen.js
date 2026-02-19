/**
 * VFS Sitemap Generator CLI Wrapper
 * Usage: node scripts/factory/vfs-sitemap-gen.js --db=./output/data/content.db --out=./output
 */

import { generateSitemap } from './lib/sitemap-generator.js';
import path from 'path';

const ARGS = process.argv.slice(2);
const dbArg = ARGS.find(a => a.startsWith('--db='))?.split('=')[1] || './output/data/content.db';
const outArg = ARGS.find(a => a.startsWith('--out='))?.split('=')[1] || './output';

async function main() {
    console.log(`[SITEMAP-VFS] Target DB: ${dbArg}`);
    console.log(`[SITEMAP-VFS] Output Dir: ${outArg}`);

    try {
        await generateSitemap(dbArg, outArg);
        process.exit(0);
    } catch (err) {
        console.error('[SITEMAP-VFS] ❌ Generation failed:', err);
        process.exit(1);
    }
}

main();
