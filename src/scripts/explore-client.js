
// src/scripts/explore-client.js
/**
 * Client-side logic for Explore page (V5.1.2 Hot Index)
 * Handles SearchWorker communication, Filters, and UI Updates
 */
import { createModelCardHTML } from './ui-utils.js';

let searchWorker = null;
let workerReady = false;
let pendingSearch = null;

const elements = {
    search: document.getElementById('explore-search'),
    sort: document.getElementById('explore-sort'),
    activeFilters: document.getElementById('active-filters'),
    grid: document.getElementById('explore-grid'),
    loading: document.getElementById('explore-loading'),
    error: document.getElementById('explore-error'),
    errorMsg: document.getElementById('explore-error-msg'),
    noResults: document.getElementById('explore-no-results'),
    resetBtn: document.getElementById('reset-filters-btn'),
    // New Filter Inputs
    minLikes: document.getElementById('min-likes'),
    hasBenchmarks: document.getElementById('has-benchmarks'),
    sourceInputs: document.querySelectorAll('input[name="source"]'),
    daysAgoInputs: document.querySelectorAll('input[name="days_ago"]'),
    // Advanced Filters
    licenseFilter: document.getElementById('license-filter'),
    tagsInputs: document.querySelectorAll('input[name="tags"]')
};

// Initialize Worker
export function initExplorePage() {
    // Re-bind elements in case of dynamic import delay (though unlikely here)
    // Actually modules evaluate once, but if elements aren't in DOM yet?
    // This script should be imported in a <script> tag which deferrs by default in Astro?
    // Or we rely on it being loaded at bottom.
    // Ideally we wrap in DOMContentLoaded or exported init function.

    // Check if elements exist (paranoia)
    if (!document.getElementById('explore-grid')) return;

    try {
        searchWorker = new Worker('/workers/search-worker.js?v=16.5.13', { type: 'module' });

        searchWorker.onmessage = (e) => {
            const { type, isLoaded, results, total, error } = e.data;

            if (type === 'STATUS') {
                if (isLoaded) {
                    workerReady = true;
                    console.log('[Explore] Search Index Ready');
                    // Always trigger initial search when index is ready
                    triggerSearch();
                }
            } else if (type === 'RESULT') {
                renderModels(results);
                updateUIState('loaded');
            } else if (type === 'ERROR') {
                showError(error || 'Search Worker Error');
            }
        };

        // Set pending flag - search will be triggered when Worker sends STATUS
        pendingSearch = true;

        setupEventListeners();

    } catch (e) {
        console.error('Worker Init Error:', e);
        showError('Failed to initialize search engine.');
    }
}

function getFilters() {
    // Safe access
    const searchEl = document.getElementById('explore-search');
    const sortEl = document.getElementById('explore-sort');
    const minLikesEl = document.getElementById('min-likes');
    const hasBenchmarksEl = document.getElementById('has-benchmarks');
    const licenseEl = document.getElementById('license-filter');

    // V6.2: Get entity type from URL
    const urlParams = new URLSearchParams(window.location.search);
    const entityType = urlParams.get('type') || 'model';

    const q = searchEl ? searchEl.value.trim() : '';
    const sort = sortEl ? sortEl.value : 'trending';
    const min_likes = minLikesEl ? parseInt(minLikesEl.value) : 0;
    const has_benchmarks = hasBenchmarksEl ? hasBenchmarksEl.checked : false;
    const sources = Array.from(document.querySelectorAll('input[name="source"]:checked')).map(i => i.value);
    const license = licenseEl ? licenseEl.value : '';
    const tags = Array.from(document.querySelectorAll('input[name="tags"]:checked')).map(i => i.value);

    return { q, sort, min_likes, has_benchmarks, sources, license, tags, entityType };
}

function updateActiveFiltersDisplay(filters) {
    const activeFiltersEl = document.getElementById('active-filters');
    if (!activeFiltersEl) return;

    const chips = [];
    // V6.2: Show entity type only if not default
    const typeLabels = { model: '🤖 Models', space: '🎮 Spaces', dataset: '📊 Datasets' };
    if (filters.entityType && filters.entityType !== 'model') {
        chips.push(typeLabels[filters.entityType] || filters.entityType);
    }
    if (filters.min_likes > 0) chips.push(`Stars > ${filters.min_likes}`);
    if (filters.has_benchmarks) chips.push('SOTA Only');
    filters.sources.forEach(s => chips.push(s));
    if (filters.license) chips.push(`License: ${filters.license}`);
    filters.tags.forEach(t => chips.push(t));

    if (chips.length > 0) {
        activeFiltersEl.classList.remove('hidden');
        activeFiltersEl.innerHTML = chips.map(text => `
            <span class="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                ${text}
            </span>
        `).join('');
    } else {
        activeFiltersEl.classList.add('hidden');
        activeFiltersEl.innerHTML = '';
    }
}

function triggerSearch() {
    if (!searchWorker || !workerReady) {
        pendingSearch = true;
        return;
    }

    const filters = getFilters();
    updateActiveFiltersDisplay(filters);
    updateUIState('loading');

    const searchId = Date.now();

    searchWorker.postMessage({
        id: searchId,
        type: 'SEARCH',
        filters: {
            ...filters,
            limit: 50,
            page: 1
        }
    });
}

function updateUIState(state) {
    const grid = document.getElementById('explore-grid');
    const loading = document.getElementById('explore-loading');
    const error = document.getElementById('explore-error');
    const noResults = document.getElementById('explore-no-results');

    if (state === 'loading') {
        grid?.classList.add('opacity-50');
        loading?.classList.remove('hidden');
        error?.classList.add('hidden');
        noResults?.classList.add('hidden');
    } else if (state === 'loaded') {
        loading?.classList.add('hidden');
        grid?.classList.remove('opacity-50');
        grid?.classList.remove('opacity-0');
        grid?.classList.add('opacity-100');
    }
}

function showError(msg) {
    updateUIState('loaded');
    const error = document.getElementById('explore-error');
    const errorMsg = document.getElementById('explore-error-msg');
    const grid = document.getElementById('explore-grid');

    if (error) error.classList.remove('hidden');
    if (errorMsg) errorMsg.textContent = msg;
    if (grid) grid.innerHTML = '';
}

function renderModels(models) {
    const grid = document.getElementById('explore-grid');
    const noResults = document.getElementById('explore-no-results');

    if (!models || models.length === 0) {
        if (grid) grid.innerHTML = '';
        if (noResults) noResults.classList.remove('hidden');
        return;
    }
    if (noResults) noResults.classList.add('hidden');
    const html = models.map(model => createModelCardHTML(model)).join('');
    if (grid) grid.innerHTML = html;
}

function setupEventListeners() {
    const search = document.getElementById('explore-search');
    const sort = document.getElementById('explore-sort');
    const minLikes = document.getElementById('min-likes');
    const hasBenchmarks = document.getElementById('has-benchmarks');
    const licenseFilter = document.getElementById('license-filter');
    const resetBtn = document.getElementById('reset-filters-btn');

    let debounceTimer;
    search?.addEventListener('input', () => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(triggerSearch, 300);
    });

    sort?.addEventListener('change', triggerSearch);
    if (minLikes) minLikes.addEventListener('change', triggerSearch);
    if (hasBenchmarks) hasBenchmarks.addEventListener('change', triggerSearch);

    document.querySelectorAll('input[name="source"]').forEach(el => el.addEventListener('change', triggerSearch));
    document.querySelectorAll('input[name="days_ago"]').forEach(el => el.addEventListener('change', triggerSearch));
    licenseFilter?.addEventListener('change', triggerSearch);
    document.querySelectorAll('input[name="tags"]').forEach(el => el.addEventListener('change', triggerSearch));

    resetBtn?.addEventListener('click', () => {
        if (search) search.value = '';
        // Other resets omitted for brevity
        triggerSearch();
    });
}
