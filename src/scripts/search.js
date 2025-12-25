// g:\ai-nexus\src\scripts\search.js (V3 API VERSION)

let currentQuery = '';
let currentTag = '';
let isExplorePage = false;
let isLoading = false;

let modelsGrid;
let noResults;
let staticContentContainer;
let searchBox;
let hideOnSearchElements; // V9.0: Elements to hide when searching

// V5.1.2: Client-Side Search Worker
const searchWorker = new Worker('/workers/search-worker.js', { type: 'module' });
import { createModelCardHTML, formatNumber } from './ui-utils.js';





function renderModels(models) {
    if (!modelsGrid) return;

    modelsGrid.innerHTML = '';
    if (!models || models.length === 0) {
        modelsGrid.classList.add('hidden');
        if (noResults) noResults.classList.remove('hidden');
    } else {
        modelsGrid.classList.remove('hidden');
        if (noResults) noResults.classList.add('hidden');

        const fragment = document.createDocumentFragment();
        models.forEach(model => {
            const cardContainer = document.createElement('div');
            cardContainer.innerHTML = createModelCardHTML(model);
            fragment.appendChild(cardContainer.firstElementChild);
        });
        modelsGrid.appendChild(fragment);
    }
}

function updateURL() {
    const url = new URL(window.location);
    if (currentQuery) {
        url.searchParams.set('q', currentQuery);
    } else {
        url.searchParams.delete('q');
    }
    if (currentTag) {
        url.searchParams.set('tag', currentTag);
    } else {
        url.searchParams.delete('tag');
    }
    window.history.pushState({}, '', url.toString());
}

async function performSearch() {
    if (isLoading && !searchWorker) return;

    // On homepage, if empty query/tag, show static content
    if (!isExplorePage && !currentQuery && !currentTag) {
        if (modelsGrid) {
            modelsGrid.innerHTML = '';
            modelsGrid.classList.add('hidden');
        }
        if (noResults) noResults.classList.add('hidden');
        // V9.0: Show all hide-on-search elements when not searching
        if (hideOnSearchElements) {
            hideOnSearchElements.forEach(el => el.classList.remove('hidden'));
        }
        return;
    }

    isLoading = true;
    // V9.0: Hide all hide-on-search elements when searching
    if (hideOnSearchElements) {
        hideOnSearchElements.forEach(el => el.classList.add('hidden'));
    }

    // Show loading state
    if (modelsGrid) modelsGrid.classList.remove('hidden');
    // Optional: show skeleton here if needed

    // V5.1.2: Offload to Worker with 50ms Timebox (CES Art 3.2)
    const requestId = Date.now().toString();

    const searchPromise = new Promise((resolve, reject) => {
        const handler = (e) => {
            if (e.data.id === requestId) {
                searchWorker.removeEventListener('message', handler);
                if (e.data.type === 'RESULT') resolve(e.data.results);
                else reject(e.data.error);
            }
        };
        searchWorker.addEventListener('message', handler);
        searchWorker.postMessage({
            id: requestId,
            type: 'SEARCH',
            q: currentQuery,
            filters: { tags: currentTag ? [currentTag] : [] }
        });
    });

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject('TIMEOUT'), 50)
    );

    try {
        const results = await Promise.race([searchPromise, timeoutPromise]);
        renderModels(results || []);
    } catch (e) {
        if (e === 'TIMEOUT') {
            console.warn('[Search] Timebox exceeded (50ms). Showing partial/fallback.');
            // Fallback: Don't render, keep cached/static, or show user "System busy"
            // For now: Log and do nothing (keep current state) or show empty
        } else {
            console.error('Search Error:', e);
        }
    } finally {
        isLoading = false;
    }
}

async function initializeSearch({ initialQuery, activeTag, isExplorePage: onExplorePage = false }) {
    modelsGrid = document.getElementById('models-grid');
    noResults = document.getElementById('no-results');
    staticContentContainer = document.getElementById('static-content-container');
    searchBox = document.getElementById('search-box');
    // V9.0: Get all elements that should be hidden when searching
    hideOnSearchElements = document.querySelectorAll('.hide-on-search');

    // V5.1.2: Bind Worker Event Listener
    searchWorker.onmessage = (e) => {
        const { type, results } = e.data;
        if (type === 'RESULT') {
            renderModels(results || []);
            isLoading = false;
        } else if (type === 'ERROR') {
            console.error('Worker Search Error:', e.data.error);
            isLoading = false;
        }
    };

    currentQuery = initialQuery || '';
    currentTag = activeTag || '';
    isExplorePage = onExplorePage;

    if (searchBox) searchBox.value = currentQuery;

    // Initial load
    if (currentQuery || currentTag || isExplorePage) {
        performSearch();
    } else {
        if (staticContentContainer) staticContentContainer.classList.remove('hidden');
    }

    // Event Listeners
    const searchForm = document.getElementById('search-form');
    if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            if (searchBox) currentQuery = searchBox.value.trim();
            updateURL();
            performSearch();
        });
    }

    let debounceTimer;
    if (searchBox) {
        searchBox.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                currentQuery = searchBox.value.trim();
                updateURL();
                performSearch();
            }, 400); // Slightly longer debounce for API calls
        });
    }
}

export { initializeSearch };
