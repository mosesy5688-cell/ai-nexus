import { describe, it, expect } from 'vitest';
// @ts-ignore — JS factory module, no types.
import {
    RESERVED_KNOWLEDGE_BASENAMES,
    isKnowledgeJsonFile,
    knowledgeArticleId,
    isKnowledgeArticlePayload,
    knowledgeArticleIdentity,
} from '../../scripts/factory/lib/knowledge-anchor-identity.js';

// C1 — /knowledge/stats-json-zst was a live 404 carried in the sitemap and served
// by /api/v1/concepts as a titleless concept, because buildKnowledgeDb() admitted
// the knowledge cache generator's OWN `stats.json.zst` telemetry blob as an
// article. These are the admission rules that close it, asserted directly.

describe('C1 filename gate — generator artifacts are not articles', () => {
    it('rejects the exact production offender, stats.json.zst', () => {
        expect(knowledgeArticleId('stats.json.zst')).toBeNull();
    });

    it('rejects the catalog index in every extension shape', () => {
        for (const f of ['index.json', 'index.json.gz', 'index.json.zst']) {
            expect(knowledgeArticleId(f)).toBeNull();
        }
    });

    it('rejects reserved basenames at any nesting depth', () => {
        for (const base of RESERVED_KNOWLEDGE_BASENAMES) {
            expect(knowledgeArticleId(`${base}.json.zst`)).toBeNull();
            expect(knowledgeArticleId(`ai/${base}.json.zst`)).toBeNull();
            expect(knowledgeArticleId(`articles/nested/${base}.json`)).toBeNull();
        }
    });

    it('rejects smart-writer version rotations', () => {
        expect(knowledgeArticleId('lora.v-1.json.zst')).toBeNull();
        expect(knowledgeArticleId('lora.v-2.json.zst')).toBeNull();
        expect(knowledgeArticleId('ai/lora.v-1.json')).toBeNull();
    });

    it('rejects .meta.json checksum sidecars', () => {
        expect(isKnowledgeJsonFile('stats.json.zst.meta.json')).toBe(false);
        expect(knowledgeArticleId('stats.json.zst.meta.json')).toBeNull();
    });

    it('rejects non-JSON entries and directories', () => {
        for (const f of ['ai', 'notes.txt', 'graph.bin', '']) {
            expect(isKnowledgeJsonFile(f)).toBe(false);
            expect(knowledgeArticleId(f)).toBeNull();
        }
    });
});

describe('C1 filename gate — real article filenames still resolve', () => {
    it('strips .json.zst, which the previous regex did not', () => {
        // The defect: `.json.zst` survived into the id, and slug sanitisation then
        // turned every dot into a dash. Both halves are asserted here.
        expect(knowledgeArticleId('lora.json.zst')).toBe('lora');
        expect(knowledgeArticleIdentity('lora.json.zst', { title: 'LoRA' })).toEqual({
            id: 'lora',
            slug: 'lora',
        });
    });

    it('strips .json and .json.gz as before', () => {
        expect(knowledgeArticleId('rag.json')).toBe('rag');
        expect(knowledgeArticleId('rag.json.gz')).toBe('rag');
    });

    it('keeps the cache-relative form for nested articles', () => {
        expect(knowledgeArticleId('ai/lora.json.zst')).toBe('ai/lora');
        expect(knowledgeArticleId('ai\\lora.json.zst')).toBe('ai/lora');
    });
});

describe('C1 payload gate — only article-shaped payloads are admitted', () => {
    it('rejects an array payload (index.json parses to the catalog array)', () => {
        expect(isKnowledgeArticlePayload([{ slug: 'lora', title: 'LoRA' }])).toBe(false);
    });

    it('rejects a titleless payload', () => {
        expect(isKnowledgeArticlePayload({ total_articles: 1 })).toBe(false);
        expect(isKnowledgeArticlePayload({ title: '' })).toBe(false);
        expect(isKnowledgeArticlePayload({ title: '   ' })).toBe(false);
    });

    it('rejects non-objects', () => {
        for (const p of [null, undefined, 3, 'text', true]) {
            expect(isKnowledgeArticlePayload(p)).toBe(false);
        }
    });

    it('accepts a titled object', () => {
        expect(isKnowledgeArticlePayload({ title: 'LoRA' })).toBe(true);
    });
});

describe('C1 identity precedence is unchanged for admitted articles', () => {
    it('declared id wins over slug and filename', () => {
        const got = knowledgeArticleIdentity('file-name.json.zst', {
            title: 'T', id: 'declared-id', slug: 'declared-slug',
        });
        expect(got).toEqual({ id: 'declared-id', slug: 'declared-id' });
    });

    it('declared slug wins over the filename when there is no id', () => {
        const got = knowledgeArticleIdentity('file-name.json.zst', { title: 'T', slug: 'declared-slug' });
        expect(got).toEqual({ id: 'declared-slug', slug: 'declared-slug' });
    });

    it('slug sanitisation is unchanged (non [a-z0-9-] becomes -)', () => {
        const got = knowledgeArticleIdentity('x.json', { title: 'T', id: 'Ai/Model_1.x' });
        expect(got!.slug).toBe('-i--odel-1-x');
    });

    it('a reserved filename is rejected even when the payload declares an id', () => {
        expect(knowledgeArticleIdentity('stats.json.zst', { title: 'T', id: 'real' })).toBeNull();
    });
});
