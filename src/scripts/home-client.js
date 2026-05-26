// src/scripts/home-client.js
import { createModelCardHTML } from './ui-utils.js';

// Function to fetch and render hot models (Constitution: FNI-sorted)
export async function loadHotModels() {
    const loadingSkeleton = document.getElementById('hot-models-loading');
    const gridEl = document.getElementById('hot-models-grid');

    // V16.5: If grid is already pre-rendered via SSR, just ensure UI state is correct
    if (gridEl && gridEl.children.length > 0) {
        console.log('[Home] Hot models pre-rendered via SSR. Skipping client fetch.');
        if (loadingSkeleton) loadingSkeleton.classList.add('hidden');
        gridEl.classList.remove('hidden');
        return;
    }

    try {
        // Tier 1: Binary Hot Shard (fastest, in-process)
        const { loadHotShard, searchShardPool } = await import('./search-shard-engine.js');
        await loadHotShard();
        const binaryModels = searchShardPool('', 12, { entityType: 'model', sort: 'fni' });
        if (binaryModels && binaryModels.length > 0) {
            renderModelsToGrid(binaryModels, gridEl, loadingSkeleton);
            return;
        }

        // V27.65: Tier 2 fallback via /api/v1/search (data/* VFS); cache/trending.json retired.
        const res = await fetch('/api/v1/search?type=model&sort=fni&limit=12', { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        const body = await res.json();
        const results = body.results || [];
        if (!Array.isArray(results)) throw new TypeError(`Expected array, got ${typeof results}`);
        if (results.length > 0) {
            renderModelsToGrid(results, gridEl, loadingSkeleton);
        } else {
            if (gridEl) gridEl.innerHTML = '<div class="col-span-full text-center text-gray-500 py-12 api-fallback-err" data-component="hot-models">No models available right now</div>';
            if (loadingSkeleton) loadingSkeleton.classList.add('hidden');
        }
    } catch (e) {
        console.error('[home-client:loadHotModels]', e?.message);
        if (gridEl) gridEl.innerHTML = '<div class="col-span-full text-center text-gray-500 py-12 api-fallback-err" data-component="hot-models">[content currently unavailable]</div>';
        if (loadingSkeleton) loadingSkeleton.classList.add('hidden');
    }
}

function renderModelsToGrid(models, gridEl, loadingSkeleton) {
    const html = models.filter(m => !!m).map(model => createModelCardHTML(model)).join('');
    if (gridEl) {
        gridEl.innerHTML = html;
        gridEl.classList.remove('hidden');
    }
    if (loadingSkeleton) {
        loadingSkeleton.classList.add('hidden');
        loadingSkeleton.style.display = 'none';
    }
}

