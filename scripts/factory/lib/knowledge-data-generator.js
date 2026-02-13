/**
 * Knowledge Data Generator V16.2
 * SPEC: SPEC-KNOWLEDGE-MESH-V16.2 Section 5.4, 6.3, 13
 * 
 * Generates cache/knowledge/ structure from:
 * - knowledge-links.json (entity→concept mapping)
 * - Knowledge templates (meta/knowledge-templates/)
 * - Existing markdown articles (src/pages/knowledge/)
 * 
 * Runs in Factory 3.5/4 Linker Job 4
 * 
 * @module scripts/factory/lib/knowledge-data-generator
 */

import fs from 'fs/promises';
import path from 'path';
import { smartWriteWithVersioning } from './smart-writer.js';
import { getCategory, parseFrontmatter, extractSections } from './knowledge-utils.js';

const CONFIG = {
    KNOWLEDGE_LINKS_PATH: './output/cache/relations/knowledge-links.json.gz',
    TEMPLATES_DIR: './meta/knowledge-templates',
    MARKDOWN_DIR: './src/pages/knowledge',
    OUTPUT_DIR: './output/cache/knowledge',
    VERSION: '16.2'
};

// Knowledge categories
const CATEGORIES = {
    benchmarks: ['mmlu', 'humaneval', 'gsm8k', 'hellaswag', 'arc'],
    architectures: ['transformer', 'moe', 'attention', 'gguf', 'llm-architecture'],
    techniques: ['lora', 'rlhf', 'dpo', 'quantization', 'fine-tuning', 'prompt-engineering'],
    concepts: ['context-length', 'vram', 'fni', 'deploy-score', 'multimodal', 'agents']
};

/**
 * Load knowledge links from relations
 */
async function loadKnowledgeLinks() {
    try {
        let content = await fs.readFile(CONFIG.KNOWLEDGE_LINKS_PATH);
        if (CONFIG.KNOWLEDGE_LINKS_PATH.endsWith('.gz') || (content[0] === 0x1f && content[1] === 0x8b)) {
            const zlib = await import('zlib');
            content = zlib.gunzipSync(content);
        }
        return JSON.parse(content.toString('utf-8'));
    } catch (e) {
        // Try .gz fallback
        if (!CONFIG.KNOWLEDGE_LINKS_PATH.endsWith('.gz')) {
            try {
                let content = await fs.readFile(CONFIG.KNOWLEDGE_LINKS_PATH + '.gz');
                const zlib = await import('zlib');
                content = zlib.gunzipSync(content);
                return JSON.parse(content.toString('utf-8'));
            } catch (e2) { }
        }
        console.warn(`  [WARN] knowledge-links.json not found: ${e.message}`);
        return { links: [] };
    }
}

// Utility functions extracted to knowledge-utils.js per Art 5.1

/**
 * Count entity references for a knowledge slug
 * V16.5: Fixed to use correct data structure from knowledge-linker
 */
function countEntityRefs(knowledgeLinks, slug) {
    if (!knowledgeLinks?.links) return 0;

    let count = 0;
    for (const link of knowledgeLinks.links) {
        if (link.knowledge?.some(k => k.slug === slug)) {
            count++;
        }
    }
    return count;
}

/**
 * Generate knowledge articles from markdown files
 */
export async function generateKnowledgeData(outputDir = './output') {
    console.log('[KNOWLEDGE-DATA V16.2] Generating knowledge articles...');

    const knowledgeDir = path.join(outputDir, 'cache', 'knowledge');
    const articlesDir = path.join(knowledgeDir, 'articles');

    await fs.mkdir(articlesDir, { recursive: true });

    // Load knowledge links
    const knowledgeLinks = await loadKnowledgeLinks();

    // Scan markdown files
    const articles = [];
    const categorized = {};

    try {
        const files = await fs.readdir(CONFIG.MARKDOWN_DIR);
        const mdFiles = files.filter(f => f.endsWith('.md') && f !== '[slug].astro');

        for (const file of mdFiles) {
            try {
                const slug = file.replace('.md', '');
                const filePath = path.join(CONFIG.MARKDOWN_DIR, file);
                const content = await fs.readFile(filePath, 'utf-8');

                const frontmatter = parseFrontmatter(content);
                const sections = extractSections(content);
                const category = getCategory(slug, CATEGORIES);
                const refs = countEntityRefs(knowledgeLinks, slug);

                // Build article JSON
                const article = {
                    _v: CONFIG.VERSION,
                    _ts: new Date().toISOString(),
                    slug,
                    title: frontmatter.title || `What is ${slug}?`,
                    category,
                    sources: {
                        primary_paper: frontmatter.paper || null,
                        official_url: frontmatter.url || null
                    },
                    content: sections,
                    dynamic_data: {
                        model_count: refs,
                        related_papers: [],
                        top_performers: []
                    },
                    mesh_links: {
                        models: [],
                        knowledge: [],
                        papers: []
                    },
                    disclaimer: frontmatter.disclaimer || 'Content based on official documentation.'
                };

                // Write individual article (V16.6: Gzip via SmartWriter)
                const articleKey = `articles/${slug}.json`;
                await smartWriteWithVersioning(articleKey, article, knowledgeDir, { compress: true });

                // Add to index
                articles.push({
                    slug,
                    title: article.title,
                    category,
                    refs,
                    updated: new Date().toISOString().split('T')[0]
                });

                // Categorize
                if (!categorized[category]) categorized[category] = [];
                categorized[category].push(slug);

                console.log(`  [ARTICLE] ${slug}: ${refs} refs, category: ${category}`);
            } catch (e) {
                console.warn(`  [WARN] Failed to process ${file}: ${e.message}`);
            }
        }
    } catch (e) {
        console.warn(`  [WARN] Markdown directory not found: ${e.message}`);
    }

    // Generate index (V16.6: Gzip via SmartWriter)
    await smartWriteWithVersioning('index.json', index, knowledgeDir, { compress: true });

    // Generate stats
    const stats = {
        _v: CONFIG.VERSION,
        _ts: new Date().toISOString(),
        total_articles: articles.length,
        total_refs: articles.reduce((sum, a) => sum + a.refs, 0),
        by_category: Object.fromEntries(
            Object.entries(categorized).map(([k, v]) => [k, v.length])
        )
    };

    await smartWriteWithVersioning('stats.json', stats, knowledgeDir, { compress: true });

    console.log(`[KNOWLEDGE-DATA] Generated ${articles.length} articles`);

    return { total: articles.length, categories: Object.keys(categorized) };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
    const outputDir = process.argv[2] || './output';
    generateKnowledgeData(outputDir)
        .then(result => console.log(`✅ Knowledge data complete: ${result.total} articles`))
        .catch(e => {
            console.error('❌ Knowledge data failed:', e.message);
            process.exit(1);
        });
}
