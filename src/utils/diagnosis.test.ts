
import { describe, it, expect } from 'vitest';
import { loadEntityStreams } from './packet-loader.ts';

describe('Packet Loader Diagnosis', () => {
    it('should load a meta-llama model correctly', async () => {
        const type = 'model';
        const slug = 'meta-llama/llama-3-8b';
        const result = await loadEntityStreams(type, slug);

        console.log('--- REPRO RESULT ---');
        console.log('Available:', result._meta.available);
        console.log('Source:', result._meta.source);
        console.log('Paths:', JSON.stringify(result._meta.paths, null, 2));

        expect(result._meta.available).toBe(true);
        expect(result.entity).toBeDefined();
        expect(result.entity.id).toContain('llama-3-8b');
    }, 30000);

    it('should load a civitai model correctly', async () => {
        const type = 'model';
        const slug = 'civitai/123456';
        const result = await loadEntityStreams(type, slug);

        console.log('--- CIVITAI REPRO RESULT ---');
        console.log('Available:', result._meta.available);
        console.log('Paths:', JSON.stringify(result._meta.paths, null, 2));

        expect(result._meta.available).toBe(true);
    }, 30000);
});
