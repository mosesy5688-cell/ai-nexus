// src/scripts/home-client.js
import { createModelCardHTML } from './ui-utils.js';
import { loadCachedJSON } from '../utils/loadCachedJSON.js';

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
        // V23.1: Try Tier 1 Binary Hot Shard first (Speed + Reliability)
        const { loadHotShard, searchShardPool } = await import('./search-shard-engine.js');
        await loadHotShard();
        const binaryModels = searchShardPool('', 12, { entityType: 'model', sort: 'fni' });

        if (binaryModels && binaryModels.length > 0) {
            console.log('[Home] Hot models loaded from Tier 1 Binary Shard.');
            renderModelsToGrid(binaryModels, gridEl, loadingSkeleton);
            return;
        }

        // V18.12.5.4: Legacy JSON Fallback (if Binary Shard is not ready)
        const loadPromise = loadCachedJSON('cache/trending.json');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000));

        const { data } = await Promise.race([loadPromise, timeoutPromise]);
        const models = (data?.models || data || []).slice(0, 12);

        if (models && models.length > 0) {
            console.log('[Home] Hot models loaded from Legacy JSON.');
            renderModelsToGrid(models, gridEl, loadingSkeleton);
        } else {
            console.warn('[Home] All hot model sources failed.');
            if (gridEl) gridEl.innerHTML = '<p class="col-span-full text-center text-gray-500 py-12">No models available at the moment.</p>';
        }

    } catch (e) {
        console.error("Failed to load hot models:", e);
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

