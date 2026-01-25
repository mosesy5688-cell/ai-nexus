
import { describe, it, expect } from 'vitest';
import { getArticleBySlug } from './src/data/knowledge-base-config';
import { articles } from './src/data/knowledge-articles';

describe('Knowledge Base Routing V16.32 Logic Audit', () => {

    it('should resolve "meta" and "meta-ai" correctly', () => {
        const meta = getArticleBySlug('meta');
        const metaAi = getArticleBySlug('meta-ai');
        expect(meta?.article.slug).toBe('meta');
        expect(metaAi?.article.slug).toBe('meta');
        expect(meta?.category.id).toBe('organizations');
    });

    it('should resolve "llm" correctly', () => {
        const llm = getArticleBySlug('llm');
        expect(llm?.article.slug).toBe('large-language-model');
    });

    it('should resolve "transformer" and legacy "what-is-transformer" correctly', () => {
        const transformer = getArticleBySlug('transformer');
        const legacy = getArticleBySlug('what-is-transformer');
        expect(transformer?.article.slug).toBe('transformer');
        expect(legacy?.article.slug).toBe('transformer');
        expect(transformer?.category.id).toBe('fundamentals');
    });

    it('should resolve "moe" and legacy "what-is-moe" correctly', () => {
        const moe = getArticleBySlug('moe');
        const legacy = getArticleBySlug('what-is-moe');
        expect(moe?.article.slug).toBe('moe');
        expect(legacy?.article.slug).toBe('moe');
    });

    it('should resolve "vram" accurately', () => {
        const vram = getArticleBySlug('vram');
        expect(vram?.article.slug).toBe('vram');
    });

    it('should return null for non-existent slugs', () => {
        const invalid = getArticleBySlug('total-gibberish-999');
        expect(invalid).toBeNull();
    });

    it('should verify content stubs exist in knowledge-articles.ts', () => {
        // Essential check for Grounding
        const meta = getArticleBySlug('meta');
        const llm = getArticleBySlug('large-language-model');

        expect(articles[meta?.article.slug || '']).toBeDefined();
        expect(articles[llm?.article.slug || '']).toBeDefined();
    });
});
