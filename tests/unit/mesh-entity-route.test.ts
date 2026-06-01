// tests/unit/mesh-entity-route.test.ts
// V27.101: getEntityRoute divergent-slug routing (civitai descriptive URL fix).
import { describe, it, expect } from 'vitest';
import { getEntityRoute, getRouteFromId } from '../../src/utils/mesh-routing-core.js';

describe('getEntityRoute', () => {
    it('reroutes civitai to its resolvable descriptive slug', () => {
        // id is short (civitai-model--428826) but the entity is sharded by the
        // descriptive slug. getRouteFromId(id) yields a dead /model/428826, so the
        // helper must emit the proven-200 descriptive form.
        const entity = {
            id: 'civitai-model--428826',
            slug: 'civitai-428826-damn-illustrious-pony-realistic-model',
            type: 'model'
        };
        expect(getEntityRoute(entity, 'model'))
            .toBe('/model/civitai-428826-damn-illustrious-pony-realistic-model');
    });

    it('leaves HuggingFace models unchanged (slug === stripPrefix(id))', () => {
        const entity = {
            id: 'hf-model--meta-llama--llama-3-8b',
            slug: 'meta-llama--llama-3-8b',
            type: 'model'
        };
        // No divergence -> identical to the legacy route.
        expect(getEntityRoute(entity, 'model'))
            .toBe(getRouteFromId('hf-model--meta-llama--llama-3-8b', 'model'));
        expect(getEntityRoute(entity, 'model')).toBe('/model/meta-llama/llama-3-8b');
    });

    it('never reroutes papers even when the slug diverges', () => {
        const entity = {
            id: 'arxiv-paper--arxiv--2604.22294',
            slug: 'arxiv--2604.22294',
            type: 'paper'
        };
        // Papers keep their dedicated handling (V27.92-100).
        expect(getEntityRoute(entity, 'paper'))
            .toBe(getRouteFromId('arxiv-paper--arxiv--2604.22294', 'paper'));
    });

    it('falls back to getRouteFromId when no slug is present', () => {
        const entity = { id: 'hf-model--x' };
        expect(getEntityRoute(entity, 'model'))
            .toBe(getRouteFromId('hf-model--x', 'model'));
        expect(getEntityRoute(entity, 'model')).toBe('/model/x');
    });
});
