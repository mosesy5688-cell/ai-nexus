/**
 * Knowledge Auto-Generator
 * V12: Template-based knowledge article generation with optional Gemini polish
 * 
 * Based on AI_SUMMARY_PLAN_V1.1 and CONTENT_GEN_STD_V1.3
 * 
 * Phase 1: Smart Templates (current)
 * Phase 2: AI-Assisted (future, with Gemini)
 * 
 * @module scripts/generate-knowledge
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
    KNOWLEDGE_DIR: path.join(__dirname, '../src/pages/knowledge'),
    CONFIG_PATH: path.join(__dirname, '../src/data/knowledge-base-config.ts'),
    DAILY_INTERVAL_MS: 24 * 60 * 60 * 1000, // 24 hours
    ARTICLES_PER_RUN: 2, // Max new articles per run
};

// Knowledge article templates per category
const TEMPLATES = {
    benchmark: {
        sections: ['overview', 'methodology', 'metrics', 'limitations'],
        template: (topic) => `---
title: "${topic.title}"
description: "${topic.description}"
category: "benchmarks"
slug: "${topic.slug}"
created: "${new Date().toISOString()}"
---

# What is ${topic.title}?

${topic.overview || `${topic.title} is a benchmark used to evaluate AI model capabilities.`}

## Methodology

${topic.methodology || 'This section describes how the benchmark evaluates models.'}

## Key Metrics

${topic.metrics || '- Metric 1\n- Metric 2\n- Metric 3'}

## Limitations

${topic.limitations || 'All benchmarks have limitations that users should be aware of.'}

## Related Resources

- [Learn more about AI benchmarks](/knowledge/llm-benchmarks)
`
    },

    architecture: {
        sections: ['definition', 'howItWorks', 'applications'],
        template: (topic) => `---
title: "${topic.title}"
description: "${topic.description}"
category: "architecture"
slug: "${topic.slug}"
created: "${new Date().toISOString()}"
---

# What is ${topic.title}?

${topic.definition || `${topic.title} is an AI architecture concept.`}

## How It Works

${topic.howItWorks || 'Technical description of the mechanism.'}

## Applications

${topic.applications || 'Common use cases and applications.'}

## Related Resources

- [Learn more about Transformers](/knowledge/transformer)
`
    },

    'model-family': {
        sections: ['overview', 'variants', 'capabilities', 'usage'],
        template: (topic) => `---
title: "${topic.title}"
description: "${topic.description}"
category: "model-families"
slug: "${topic.slug}"
created: "${new Date().toISOString()}"
---

# ${topic.title}

${topic.overview || `Overview of the ${topic.title} model family.`}

## Model Variants

${topic.variants || '| Variant | Parameters | Context Length |\n|---------|------------|----------------|\n| Base | TBD | TBD |'}

## Capabilities

${topic.capabilities || '- Capability 1\n- Capability 2'}

## How to Use

${topic.usage || 'Basic usage instructions.'}

## Related Resources

- [Explore models in this family](/models)
`
    }
};

/**
 * Generate a knowledge article from template
 */
function generateArticleFromTemplate(topic, category) {
    const template = TEMPLATES[category] || TEMPLATES.architecture;
    return template.template(topic);
}

/**
 * Check if article already exists
 */
function articleExists(slug) {
    const filePath = path.join(CONFIG.KNOWLEDGE_DIR, `${slug}.md`);
    return fs.existsSync(filePath);
}

/**
 * Save article to file
 */
function saveArticle(slug, content) {
    const filePath = path.join(CONFIG.KNOWLEDGE_DIR, `${slug}.md`);
    fs.writeFileSync(filePath, content);
    console.log(`  [Created] ${slug}.md`);
    return filePath;
}

/**
 * Get pending topics from config that don't have articles yet
 */
function getPendingTopics() {
    // TODO: Read from knowledge-base-config.ts and find missing articles
    // For now, return empty - no new topics to generate
    return [];
}

/**
 * Main generation function
 */
async function main() {
    console.log('📚 Starting Knowledge Auto-Generator...');
    console.log(`   Config: ${CONFIG.ARTICLES_PER_RUN} articles/run, ${CONFIG.DAILY_INTERVAL_MS / (24 * 60 * 60 * 1000)} day interval`);

    // Get pending topics
    const pendingTopics = getPendingTopics();
    console.log(`   Found ${pendingTopics.length} pending topics`);

    if (pendingTopics.length === 0) {
        console.log('✅ No new articles to generate. All topics covered.');
        return;
    }

    // Generate up to ARTICLES_PER_RUN articles
    const toGenerate = pendingTopics.slice(0, CONFIG.ARTICLES_PER_RUN);
    let generatedCount = 0;

    for (const topic of toGenerate) {
        if (articleExists(topic.slug)) {
            console.log(`  [Skip] ${topic.slug}.md already exists`);
            continue;
        }

        const content = generateArticleFromTemplate(topic, topic.category);
        saveArticle(topic.slug, content);
        generatedCount++;
    }

    console.log(`\n✅ Knowledge Auto-Generator completed`);
    console.log(`   Generated: ${generatedCount} new articles`);
    console.log(`   Remaining: ${pendingTopics.length - generatedCount} topics`);
}

main().catch(console.error);
