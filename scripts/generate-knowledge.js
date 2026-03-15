/**
 * Knowledge Auto-Generator V25.8
 * Phase 1: Smart Templates | Phase 2: AI-Assisted via Gemini
 *
 * V25.8 §4: Pure Text Mode — Gemini creates content; Rust builds the mesh.
 * @module scripts/generate-knowledge
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateWithGemini, enforceKnowledgeStagger, getKnownTopics } from './factory/lib/knowledge-ai.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG = {
    KNOWLEDGE_DIR: path.join(__dirname, '../src/pages/knowledge'),
    ARTICLES_PER_RUN: 2,
};

// Knowledge article templates per category
const TEMPLATES = {
    benchmark: {
        template: (t) => `---
title: "${t.title}"
description: "${t.description}"
category: "benchmarks"
slug: "${t.slug}"
created: "${new Date().toISOString()}"
---

# What is ${t.title}?

${t.overview || `${t.title} is a benchmark used to evaluate AI model capabilities.`}

## Methodology

${t.methodology || 'This section describes how the benchmark evaluates models.'}

## Key Metrics

${t.metrics || '- Metric 1\n- Metric 2\n- Metric 3'}

## Limitations

${t.limitations || 'All benchmarks have limitations that users should be aware of.'}

## Related Resources

- [Learn more about AI benchmarks](/knowledge/llm-benchmarks)
`
    },

    architecture: {
        template: (t) => `---
title: "${t.title}"
description: "${t.description}"
category: "architecture"
slug: "${t.slug}"
created: "${new Date().toISOString()}"
---

# What is ${t.title}?

${t.definition || `${t.title} is an AI architecture concept.`}

## How It Works

${t.howItWorks || 'Technical description of the mechanism.'}

## Applications

${t.applications || 'Common use cases and applications.'}

## Related Resources

- [Learn more about Transformers](/knowledge/transformer)
`
    },

    'model-family': {
        template: (t) => `---
title: "${t.title}"
description: "${t.description}"
category: "model-families"
slug: "${t.slug}"
created: "${new Date().toISOString()}"
---

# ${t.title}

${t.overview || `Overview of the ${t.title} model family.`}

## Model Variants

${t.variants || '| Variant | Parameters | Context Length |\n|---------|------------|----------------|\n| Base | TBD | TBD |'}

## Capabilities

${t.capabilities || '- Capability 1\n- Capability 2'}

## How to Use

${t.usage || 'Basic usage instructions.'}

## Related Resources

- [Explore models in this family](/models)
`
    }
};

function generateArticleFromTemplate(topic, category) {
    return (TEMPLATES[category] || TEMPLATES.architecture).template(topic);
}

function articleExists(slug) {
    return fs.existsSync(path.join(CONFIG.KNOWLEDGE_DIR, `${slug}.md`));
}

function saveArticle(slug, content) {
    fs.writeFileSync(path.join(CONFIG.KNOWLEDGE_DIR, `${slug}.md`), content);
    console.log(`  [Created] ${slug}.md`);
}

function getPendingTopics() {
    const topics = [];
    for (const slugs of Object.values(getKnownTopics())) {
        for (const topic of slugs) {
            if (!articleExists(topic.slug)) topics.push(topic);
        }
    }
    return topics;
}

async function main() {
    console.log('[KNOWLEDGE V25.8] Starting Auto-Generator...');
    const pending = getPendingTopics();
    console.log(`   Found ${pending.length} pending topics`);
    if (pending.length === 0) { console.log('All topics covered.'); return; }

    const toGenerate = pending.slice(0, CONFIG.ARTICLES_PER_RUN);
    let generated = 0;

    for (const topic of toGenerate) {
        if (articleExists(topic.slug)) continue;

        // V25.8 §4: Phase 2 — AI-Assisted with Gemini (Pure Text Mode)
        const ai = process.env.GEMINI_API_KEY ? await generateWithGemini(topic) : null;
        if (ai) {
            topic.overview = ai.overview || topic.overview;
            topic.definition = ai.overview || topic.definition;
            topic.howItWorks = ai.howItWorks || topic.howItWorks;
            topic.methodology = ai.howItWorks || topic.methodology;
            topic.applications = ai.useCases || topic.applications;
            topic.capabilities = ai.useCases || topic.capabilities;
            topic.limitations = ai.limitations || topic.limitations;
            await enforceKnowledgeStagger();
        }

        saveArticle(topic.slug, generateArticleFromTemplate(topic, topic.category));
        generated++;
    }

    console.log(`[KNOWLEDGE] Generated: ${generated}, Remaining: ${pending.length - generated}`);
}

main().catch(console.error);
