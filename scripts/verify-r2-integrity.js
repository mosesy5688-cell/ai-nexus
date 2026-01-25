
/**
 * R2 SSOT Integrity Verifier V1.0
 * V16.32 - Production Truth Audit Component
 */

import { KNOWLEDGE_CATEGORIES } from '../src/data/knowledge-base-config.ts';
import fs from 'fs';
import path from 'path';

const R2_API_BASE = process.env.R2_PUBLIC_URL || 'https://cdn.free2aitools.com';

async function checkR2File(slug) {
    const url = `${R2_API_BASE}/cache/knowledge/articles/${slug}.json`;
    try {
        const response = await fetch(url, { method: 'HEAD' });
        return {
            slug,
            exists: response.status === 200,
            status: response.status
        };
    } catch (e) {
        return { slug, exists: false, error: e.message };
    }
}

async function runAudit() {
    console.log('🔍 Initiating R2 SSOT Integrity Audit...\n');

    const allSlugs = [];
    KNOWLEDGE_CATEGORIES.forEach(cat => {
        cat.articles.forEach(art => {
            allSlugs.push(art.slug);
        });
    });

    console.log(`📊 Found ${allSlugs.length} registered knowledge nodes.`);

    const results = [];
    for (const slug of allSlugs) {
        const result = await checkR2File(slug);
        results.push(result);
        if (!result.exists) {
            console.log(`❌ MISSING: [${slug}] (Status: ${result.status || 'FETCH_ERROR'})`);
        } else {
            process.stdout.write('.');
        }
    }

    const missing = results.filter(r => !r.exists);
    console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║                R2 INTEGRITY AUDIT SUMMARY                    ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');
    console.log(`║ Total Nodes:  ${allSlugs.length.toString().padEnd(47)}║`);
    console.log(`║ R2 Presence:  ${(allSlugs.length - missing.length).toString().padEnd(47)}║`);
    console.log(`║ Missing:      ${missing.length.toString().padEnd(47)}║`);
    console.log(`║ Health:       ${(((allSlugs.length - missing.length) / allSlugs.length) * 100).toFixed(1)}%${' '.repeat(44)}║`);
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    if (missing.length > 0) {
        process.exit(1);
    }
}

runAudit().catch(console.error);
