// g:\ai-nexus\src\scripts\search.js (V3 API VERSION)

let currentQuery = '';
let currentTag = '';
let isExplorePage = false;
let isLoading = false;

let modelsGrid;
let noResults;
let staticContentContainer;
let searchBox;

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num != null ? num.toLocaleString() : 0;
}

function createModelCardHTML(model) {
    if (!model.id) {
        console.warn('Model missing id:', model);
        return ''; // Skip models without ID
    }
    const modelUrl = `/model/${model.id.replace(/\//g, '--')}`;
    // Handle description: could be null or contain HTML
    const rawDesc = model.description || 'No description available.';
    const cleanDesc = rawDesc.replace(/<[^>]*>?/gm, '');
    const description = cleanDesc.substring(0, 120);

    // Rising Star logic (optional, if API returns it)
    const isRisingStarHTML = model.is_rising_star ? `<div class="absolute top-2 right-2 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full animate-pulse" title="Rising Star">🔥</div>` : '';

    // Tags HTML (optional)
    let tagsHtml = '';
    if (model.tags) {
        try {
            const tags = typeof model.tags === 'string' ? JSON.parse(model.tags) : model.tags;
            if (Array.isArray(tags)) {
                tagsHtml = tags.slice(0, 2).map(t => `<span class="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded text-gray-600 dark:text-gray-300">${t}</span>`).join('');
            }
        } catch (e) { }
    }

    return `
        <a href="${modelUrl}" class="group relative block bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 overflow-hidden h-full flex flex-col border border-gray-100 dark:border-gray-700">
            ${isRisingStarHTML}
            <div class="p-5 flex flex-col h-full justify-between">
                <div>
                    <h3 class="text-lg font-bold text-gray-900 dark:text-white truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" title="${model.name}">
                        ${model.name}
                    </h3>
                    <p class="text-gray-500 dark:text-gray-400 text-xs mb-3 flex items-center gap-2">
                        <span>by ${model.author}</span>
                        ${tagsHtml ? `<span class="flex gap-1">${tagsHtml}</span>` : ''}
                    </p>
                    <p class="text-gray-600 dark:text-gray-300 text-sm h-20 overflow-hidden text-ellipsis leading-relaxed">
                        ${description}...
                    </p>
                </div>
                <div class="mt-4 flex items-center justify-end gap-4 text-xs text-gray-500 dark:text-gray-400">
                    <div class="flex items-center gap-1" title="${(model.likes || 0).toLocaleString()} likes">❤️ <span>${formatNumber(model.likes)}</span></div>
                    <div class="flex items-center gap-1" title="${(model.downloads || 0).toLocaleString()} downloads">📥 <span>${formatNumber(model.downloads)}</span></div>
                </div>
            </div>
        </a>
    `;
}

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
    if (isLoading) return;

    // On homepage, if empty query/tag, show static content
    if (!isExplorePage && !currentQuery && !currentTag) {
        if (modelsGrid) {
            modelsGrid.innerHTML = '';
            modelsGrid.classList.add('hidden');
        }
        if (noResults) noResults.classList.add('hidden');
        if (staticContentContainer) staticContentContainer.classList.remove('hidden');
        return;
    }

    isLoading = true;
    if (staticContentContainer) staticContentContainer.classList.add('hidden');

    // Show loading state (optional: add a spinner here)
    if (modelsGrid) modelsGrid.classList.remove('hidden'); // Keep visible to show skeleton or old results? Better to clear or show spinner.

    try {
        const params = new URLSearchParams();
        if (currentQuery) params.set('q', currentQuery);
        if (currentTag) params.set('tag', currentTag);
        params.set('limit', '50'); // Fetch more results

        const response = await fetch(`/api/search?${params.toString()}`);
        if (!response.ok) throw new Error('API Error');

        const data = await response.json();
        renderModels(data.results || []);
    } catch (error) {
        console.error('Search failed:', error);
        if (modelsGrid) modelsGrid.innerHTML = `<p class="col-span-full text-center text-red-500">Error loading results. Please try again.</p>`;
    } finally {
        isLoading = false;
    }
}

async function initializeSearch({ initialQuery, activeTag, isExplorePage: onExplorePage = false }) {
    modelsGrid = document.getElementById('models-grid');
    noResults = document.getElementById('no-results');
    staticContentContainer = document.getElementById('static-content-container');
    searchBox = document.getElementById('search-box');

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
