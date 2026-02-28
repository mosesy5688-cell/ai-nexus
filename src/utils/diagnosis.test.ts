import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadEntityStreams } from './packet-loader.ts';

describe('Packet Loader Diagnosis', () => {
    it('should load a meta-llama model correctly', async () => {
        const type = 'model';
        const slug = 'hf-model--meta-llama--meta-llama-3-8b';
        const result = await loadEntityStreams(type, slug);

        console.log('--- REPRO RESULT ---');
        console.log('Available:', result._meta.available);
        console.log('Source:', result._meta.source);
        console.log('Paths:', JSON.stringify(result._meta.paths, null, 2));

        expect(result._meta.available).toBe(true);
        expect(result.entity).toBeDefined();
        expect(result.entity.id).toContain('llama-3-8b');
    }, 30000);

    describe('with mocked network', () => {
        beforeEach(() => {
            const mockResponse = {
                ok: true,
                arrayBuffer: async () => {
                    const zlib = await import('zlib');
                    const promisify = (await import('util')).promisify;
                    const gzip = promisify(zlib.gzip);

                    const fakeData = {
                        entity: { id: 'civitai--100056', name: 'Fake Civitai Model' },
                        fused: true,
                        mesh: { profiles: {} }
                    };
                    return gzip(JSON.stringify(fakeData));
                }
            };
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(mockResponse));
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it('should structure a civitai model correctly when CDN cache hits', async () => {
            // Because we mocked fetch, the fallback will succeed immediately with our fake GZipped JSON
            const result = await loadEntityStreams('model', 'civitai--100056');

            expect(result.entity).not.toBeNull();
            expect(result.entity.id).toBe('civitai--100056');
            expect(result._meta.available).toBe(true);
            expect(result._meta.source).toBe('entity-first-anchored');

            console.log('--- MOCKED CIVITAI REPRO RESULT ---');
            console.log('Available:', result._meta.available);
            console.log('Entity ID:', result.entity.id);
        }, 10000);
    });
});
