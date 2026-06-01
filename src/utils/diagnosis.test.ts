import { describe, it, expect, vi } from 'vitest';

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
    env: { R2_ASSETS: null }
}));

// Mock VFS metadata provider to return test data without real SQLite.
// V27.97: provider returns a 3-way discriminated union; isVfsFound is the real
// (unmocked) guard, so the mock must return discriminable shapes (not null).
vi.mock('./vfs-metadata-provider.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./vfs-metadata-provider.js')>();
    return {
        ...actual,
        resolveVfsMetadata: vi.fn().mockImplementation(async (type: string, slug: string) => {
            if (slug.includes('llama')) {
                return { data: { id: 'hf-model--meta-llama--meta-llama-3-8b', slug: 'meta-llama--meta-llama-3-8b', name: 'Meta-Llama-3-8B', type: 'model', fni_score: 48.3 }, source: 'vfs:meta-00.db' };
            }
            if (slug.includes('civitai')) {
                return { data: { id: 'civitai-model--100056', slug: 'civitai--100056', name: 'Fake Civitai Model', type: 'model', fni_score: 30 }, source: 'vfs:meta-05.db' };
            }
            if (slug.includes('timeout')) {
                return { transient: true };
            }
            return { notFound: true };
        })
    };
});

import { loadEntityStreams } from './packet-loader.ts';

describe('Packet Loader Diagnosis', () => {
    it('should load a meta-llama model via VFS', async () => {
        const result = await loadEntityStreams('model', 'meta-llama/meta-llama-3-8b');
        expect(result._meta.available).toBe(true);
        expect(result.entity).toBeDefined();
        expect(result.entity.id).toContain('llama-3-8b');
        expect(result._meta.source).toBe('vfs-primary');
    });

    it('should load a civitai model via VFS', async () => {
        const result = await loadEntityStreams('model', 'civitai--100056');
        expect(result.entity).not.toBeNull();
        expect(result.entity.id).toContain('civitai');
        expect(result._meta.available).toBe(true);
    });

    it('should return 404 for nonexistent entity', async () => {
        const result = await loadEntityStreams('model', 'nonexistent--fake');
        expect(result._meta.available).toBe(false);
        expect(result._meta.transient).toBe(false);
        expect(result.entity).toBeNull();
    });

    it('should mark a transient lookup failure as transient (not a clean 404)', async () => {
        const result = await loadEntityStreams('model', 'flaky-timeout--x');
        expect(result._meta.available).toBe(false);
        expect(result._meta.transient).toBe(true);
        expect(result.entity).toBeNull();
    });
});
