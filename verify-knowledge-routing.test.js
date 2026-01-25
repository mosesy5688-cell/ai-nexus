
import { getArticleBySlug } from './src/data/knowledge-base-config.ts';
import { articles } from './src/data/knowledge-articles.ts';

function testMapping(slug) {
    const result = getArticleBySlug(slug);
    console.log(`Testing Slug: [${slug}]`);
    if (result) {
        console.log(`  - Canonical ID: ${result.article.id}`);
        console.log(`  - Title: ${result.article.title}`);
        console.log(`  - Category: ${result.category.id}`);

        const hasContent = articles[result.article.slug] || articles[slug];
        console.log(`  - Content Defined Locally: ${hasContent ? 'YES' : 'STUB (Waiting for R2)'}`);
    } else {
        console.log(`  - ERROR: [${slug}] NOT FOUND IN CONFIG`);
    }
    console.log('---');
}

console.log('Knowledge Base Routing V16.31 Logic Audit\n');

testMapping('meta');
testMapping('meta-ai');
testMapping('llm');
testMapping('large-language-model');
testMapping('transformer');
testMapping('moe');
testMapping('non-existent-example');
