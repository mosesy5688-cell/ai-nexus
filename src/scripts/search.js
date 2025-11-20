// g:\ai-nexus\src\scripts\search.js (NEW VERSION)
import Fuse from 'fuse.js';

let allModels = [];
let fuse;
let currentQuery = '';
let currentTag = '';
let isLoading = false;

const modelsGrid = document.getElementById('models-grid');
const noResults = document.getElementById('no-results');
const searchBox = document.getElementById('search-box');
const tagsContainer = document.getElementById('tags-container');
const keywordCardsContainer = document.getElementById('keyword-cards-container'); // Assuming you have this container for keyword cards

function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num != null ? num.toLocaleString() : 0;
}

function createModelCardHTML(model) {
    const modelUrl = `/model/${model.id.replace(/\//g, '--')}`;
    const description = (model.description?.replace(/<[^>]*>?/gm, '') || 'No description available.').substring(0, 120);
    const isRisingStarHTML = model.is_rising_star ? `<div class="absolute top-2 right-2 bg-yellow-400 text-yellow-900 text-xs font-bold px-2 py-1 rounded-full animate-pulse" title="Rising Star">🔥</div>` : '';

    return `
        <a href="${modelUrl}" class="group relative block bg-white dark:bg-gray-800 rounded-lg shadow-md hover:shadow-xl transition-shadow duration-300 overflow-hidden h-full flex flex-col">
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

function renderModels(models) {
    modelsGrid.innerHTML = '';
    if (models.length === 0) {
        noResults.classList.remove('hidden');
        if (keywordCardsContainer) keywordCardsContainer.classList.add('hidden');
    } else {
        noResults.classList.add('hidden');
        if (keywordCardsContainer) keywordCardsContainer.classList.add('hidden');
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
    // Use pushState to update the URL without reloading the page
    window.history.pushState({}, '', url.toString());
}

function performSearch() {
    if (isLoading) return;
    
    // If no query and no tag, show keyword cards and hide results
    if (!currentQuery && !currentTag) {
        modelsGrid.innerHTML = '';
        noResults.classList.add('hidden');
        if (keywordCardsContainer) keywordCardsContainer.classList.remove('hidden');
        return;
    }

    isLoading = true;

    let results = [];

    if (currentQuery) {
        results = fuse.search(currentQuery).map(result => result.item);
    } else {
        results = allModels;
    }

    if (currentTag) {
        results = results.filter(model => model.tags && model.tags.includes(currentTag));
    }

    // Simple sort for now, can be expanded
    results.sort((a, b) => (b.likes + b.downloads) - (a.likes + a.downloads));

    renderModels(results);
    isLoading = false;
}

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

async function initializeSearch({ initialQuery, activeTag }) {
    currentQuery = initialQuery || '';
    currentTag = activeTag || '';
    if(searchBox) searchBox.value = currentQuery;

    try {
        const response = await fetch('/data/search-index.json');
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        allModels = await response.json();
        
        const options = {
            keys: ['name', 'description', 'tags', 'author'],
            includeScore: true,
            threshold: 0.4,
        };
        fuse = new Fuse(allModels, options);

        if (currentQuery || currentTag) {
            performSearch();
        } else {
            if (keywordCardsContainer) keywordCardsContainer.classList.remove('hidden');
        }
        updateActiveTagUI();

    } catch (error) {
        console.error('Failed to load search index:', error);
        modelsGrid.innerHTML = `<p class="col-span-full text-center text-red-500">Failed to load model data. Please try again later.</p>`;
    }

    // Event Listeners
    const searchForm = document.getElementById('search-form');
    if (searchForm) {
        searchForm.addEventListener('submit', (e) => {
            e.preventDefault();
            currentQuery = searchBox.value;
            currentTag = null; // New search clears tag
            updateActiveTagUI();
            updateURL();
            performSearch();
        });
    }

    let debounceTimer;
    if (searchBox) {
        searchBox.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                currentQuery = searchBox.value;
                updateURL();
                performSearch();
            }, 300);
        });
    }

    if (tagsContainer) {
        tagsContainer.addEventListener('click', (e) => {
            const target = e.target.closest('.tag-link');
            if (!target) return;

            const clickedTag = target.dataset.tag;
            if (currentTag === clickedTag) {
                currentTag = null; // Toggle off
            } else {
                currentTag = clickedTag;
            }
            
            currentQuery = ''; // Clicking a tag clears the search query
            if(searchBox) searchBox.value = '';
            
            updateActiveTagUI();
            updateURL();
            performSearch();
        });
    }
}

export { initializeSearch };
