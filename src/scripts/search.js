export function initializeSearch({
    algoliaAppId,
    algoliaSearchKey,
    algoliaIndices,
    initialQuery,
    activeTag
}) {
    if (!algoliaAppId || !algoliaSearchKey || !algoliaIndices) {
        console.error("Algolia credentials are not configured.");
        document.getElementById('models-grid').innerHTML = `<p class="col-span-full text-center text-red-500">Search is not configured.</p>`;
        return;
    }

    const searchClient = algoliasearch(algoliaAppId, algoliaSearchKey);
    const modelsGrid = document.getElementById('models-grid');
    const noResults = document.getElementById('no-results');
    const sortBySelect = document.getElementById('sort-by');
    const searchBox = document.getElementById('search-box');
    const loadingMoreEl = document.getElementById('loading-more');

    let currentQuery = initialQuery;
    let currentTag = activeTag;
    let debounceTimer;
    let currentPage = 0;
    let isLoading = false;
    let hasMore = true;

    function formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num || 0;
    }

    function createModelCardHTML(model) {
        const modelUrl = `/model/${model.objectID.replace(/\//g, '--')}`;
        const description = (model.description?.replace(/<[^>]*>?/gm, '') || 'No description available.').substring(0, 120);
        const isRisingStarHTML = model.is_rising_star ? `<div class="absolute top-2 right-2 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full animate-pulse" title="Rising Star">🔥</div>` : '';

        return `
            <a href="${modelUrl}" class="group relative block bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 overflow-hidden h-full">
                ${isRisingStarHTML}
                <div class="p-5 flex flex-col h-full justify-between">
                    <div>
                        <h3 class="text-lg font-bold text-gray-900 dark:text-white truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors" title="${model.name}">
                            ${model.name}
                        </h3>
                        <p class="text-gray-500 dark:text-gray-400 text-xs mb-3">by ${model.author}</p>
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

    function renderModels(models, isNewSearch = true) {
        if (isNewSearch) modelsGrid.innerHTML = '';

        if (models.length === 0 && isNewSearch) {
            noResults.classList.remove('hidden');
        } else {
            noResults.classList.add('hidden');
            const fragment = document.createDocumentFragment();
            models.forEach(model => {
                const cardContainer = document.createElement('div');
                cardContainer.innerHTML = createModelCardHTML(model);
                fragment.appendChild(cardContainer.firstElementChild);
            });
            modelsGrid.appendChild(fragment);
        }
    }

    async function performSearch(page = 0) {
        if (isLoading) return;
        isLoading = true;
        const isNewSearch = page === 0;

        if (isNewSearch) {
            if (modelsGrid.children.length === 0) {
                modelsGrid.innerHTML = `<p class="col-span-full text-center py-16 text-gray-500">Loading...</p>`;
            }
            currentPage = 0;
            hasMore = true;
        } else {
            loadingMoreEl.classList.remove('hidden');
        }
        noResults.classList.add('hidden');

        const sortBy = sortBySelect.value;
        let activeIndexName = algoliaIndices.default;
        if (sortBy === 'likes') activeIndexName = algoliaIndices.likes_desc;
        if (sortBy === 'downloads') activeIndexName = algoliaIndices.downloads_desc;
        if (sortBy === 'recent') activeIndexName = algoliaIndices.recent_desc;

        const index = searchClient.initIndex(activeIndexName);
        const searchOptions = { hitsPerPage: 24, page };
        if (currentTag) searchOptions.filters = `tags:"${currentTag}"`;

        try {
            const { hits, nbPages } = await index.search(currentQuery, searchOptions);
            renderModels(hits, isNewSearch);
            currentPage = page;
            hasMore = (currentPage + 1 < nbPages);
        } catch (error) {
            console.error("Algolia search error:", error);
            modelsGrid.innerHTML = `<p class="col-span-full text-center text-red-500">Error fetching results.</p>`;
        } finally {
            isLoading = false;
            loadingMoreEl.classList.add('hidden');
        }
    }

    function updateURL() {
        const url = new URL(window.location);
        if (currentQuery) url.searchParams.set('q', currentQuery);
        else url.searchParams.delete('q');
        if (currentTag) url.searchParams.set('tag', currentTag);
        else url.searchParams.delete('tag');
        window.history.pushState({}, '', url);
    }

    document.getElementById('search-form').addEventListener('submit', (e) => {
        e.preventDefault();
        currentQuery = searchBox.value;
        currentTag = null;
        updateActiveTagUI();
        updateURL();
        performSearch(0);
    });

    searchBox.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            currentQuery = e.target.value;
            updateURL();
            performSearch(0);
        }, 300);
    });

    sortBySelect.addEventListener('change', () => performSearch(0));

    document.getElementById('tags-container').addEventListener('click', (e) => {
        const target = e.target.closest('.tag-link');
        if (!target) return;
        e.preventDefault();
        const clickedTag = target.dataset.tag;
        currentTag = (currentTag === clickedTag) ? null : clickedTag;
        currentQuery = '';
        searchBox.value = '';
        updateActiveTagUI();
        updateURL();
        performSearch(0);
    });

    function updateActiveTagUI() {
        document.querySelectorAll('.tag-link').forEach(link => {
            const isSelected = link.dataset.tag === currentTag;
            link.classList.toggle('bg-blue-600', isSelected);
            link.classList.toggle('text-white', isSelected);
            link.classList.toggle('bg-gray-200', !isSelected);
            link.classList.toggle('dark:bg-gray-700', !isSelected);
            link.classList.toggle('text-gray-800', !isSelected);
            link.classList.toggle('dark:text-gray-200', !isSelected);
        });
    }

    window.addEventListener('scroll', () => {
        if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 500 && !isLoading && hasMore) {
            performSearch(currentPage + 1);
        }
    });

    if (initialQuery || activeTag) {
        performSearch(0);
    }
}
