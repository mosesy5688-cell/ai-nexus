/**
 * Knowledge Entity Linker
 * V12: Automatically links model names and keywords to entity pages
 * 
 * Based on linkEntitiesInReport pattern from generate-report.js
 * 
 * @module scripts/knowledge-linker
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
    KNOWLEDGE_DIR: path.join(__dirname, '../src/pages/knowledge'),
    TRENDING_PATH: path.join(__dirname, '../src/data/rankings.json'), // Use rankings.json from src/data
    KEYWORDS_PATH: path.join(__dirname, '../src/data/keywords.json'),
};

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Link entities within knowledge article content
 * Matches model names and keywords, replaces with markdown links
 */
function linkEntitiesInKnowledge(content, models, keywords) {
    let linkedContent = content;

    // Sort models by name length (descending) to match longer names first
    const sortedModels = [...models].sort((a, b) => b.name.length - a.name.length);

    // Link models (only if 3+ chars and not already linked)
    sortedModels.forEach(model => {
        if (!model.name || model.name.length < 4) return;

        const slug = model.slug || model.id?.replace(/\//g, '--');
        if (!slug) return;

        const modelLink = `[${model.name}](/model/${slug})`;
        // Avoid double-linking and matching within existing links
        const regex = new RegExp(
            `\\b${escapeRegExp(model.name)}\\b(?!(\\]\\(\\/model\\/))`,
            'gi'
        );
        linkedContent = linkedContent.replace(regex, modelLink);
    });

    // Link knowledge keywords
    keywords.forEach(keyword => {
        if (!keyword.title || keyword.title.length < 4) return;

        const keywordLink = `[${keyword.title}](/knowledge/${keyword.slug})`;
        const regex = new RegExp(
            `\\b${escapeRegExp(keyword.title)}\\b(?!(\\]\\(\\/knowledge\\/))`,
            'gi'
        );
        linkedContent = linkedContent.replace(regex, keywordLink);
    });

    return linkedContent;
}

/**
 * Process a single knowledge article file
 */
function processArticle(filePath, models, keywords) {
    if (!filePath.endsWith('.md')) return null;

    const content = fs.readFileSync(filePath, 'utf-8');

    // Check if already processed (has entity links)
    if (content.includes('](/model/') && content.includes('](/knowledge/')) {
        console.log(`  [Skip] ${path.basename(filePath)} - already linked`);
        return null;
    }

    const linkedContent = linkEntitiesInKnowledge(content, models, keywords);

    // Count links added
    const modelLinksAdded = (linkedContent.match(/\]\(\/model\//g) || []).length;
    const knowledgeLinksAdded = (linkedContent.match(/\]\(\/knowledge\//g) || []).length;

    if (modelLinksAdded > 0 || knowledgeLinksAdded > 0) {
        fs.writeFileSync(filePath, linkedContent);
        console.log(`  [Updated] ${path.basename(filePath)}: +${modelLinksAdded} model links, +${knowledgeLinksAdded} knowledge links`);
        return { modelLinksAdded, knowledgeLinksAdded };
    }

    return null;
}

async function main() {
    console.log('🔗 Starting Knowledge Entity Linker...');

    // Load reference data
    let models = [];
    let keywords = [];

    if (fs.existsSync(CONFIG.TRENDING_PATH)) {
        const rankingsData = JSON.parse(fs.readFileSync(CONFIG.TRENDING_PATH, 'utf-8'));
        // Handle rankings.json format: has hot, trending, new, rising arrays
        const allModelsMap = new Map();
        [...(rankingsData.hot || []), ...(rankingsData.trending || []), ...(rankingsData.new || [])].forEach(m => {
            allModelsMap.set(m.id, m);
        });
        models = Array.from(allModelsMap.values());
        console.log(`📊 Loaded ${models.length} unique models for linking`);
    } else {
        console.warn('⚠️ rankings.json not found, skipping model linking');
    }

    if (fs.existsSync(CONFIG.KEYWORDS_PATH)) {
        keywords = JSON.parse(fs.readFileSync(CONFIG.KEYWORDS_PATH, 'utf-8'));
        console.log(`🏷️ Loaded ${keywords.length} keywords for linking`);
    }

    // Get all knowledge articles
    const articles = fs.readdirSync(CONFIG.KNOWLEDGE_DIR)
        .filter(f => f.endsWith('.md'))
        .map(f => path.join(CONFIG.KNOWLEDGE_DIR, f));

    console.log(`📚 Found ${articles.length} knowledge articles`);

    let totalModelLinks = 0;
    let totalKnowledgeLinks = 0;
    let updatedCount = 0;

    for (const article of articles) {
        const result = processArticle(article, models, keywords);
        if (result) {
            totalModelLinks += result.modelLinksAdded;
            totalKnowledgeLinks += result.knowledgeLinksAdded;
            updatedCount++;
        }
    }

    console.log('\n✅ Knowledge Entity Linker completed');
    console.log(`   Updated: ${updatedCount} articles`);
    console.log(`   Model links added: ${totalModelLinks}`);
    console.log(`   Knowledge links added: ${totalKnowledgeLinks}`);
}

main().catch(console.error);
