// src/scripts/home-search-events.js
import {
    initSearch,
    loadFullSearchIndex,
    getSearchHistory,
    saveSearchHistory,
    clearSearchHistory,
    performSearch,
    setFullSearchActive,
    getSearchStatus
} from './home-search.js';

export function renderHistory() {
    const dropdown = document.getElementById('search-results-dropdown');
    const history = getSearchHistory();
    if (!dropdown || history.length === 0) return false;

    dropdown.innerHTML = `
    <div class="p-2 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
      <span class="text-xs text-gray-500 dark:text-gray-400">🕒 Recent Searches</span>
      <button id="clear-history" class="text-xs text-red-500 hover:text-red-700">Clear</button>
    </div>
    ${history.map(q => `
      <button data-history-query="${q}" class="history-item w-full text-left p-3 hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-0">
        <span class="text-gray-700 dark:text-gray-300">🔍 ${q}</span>
      </button>
    `).join('')}
  `;
    dropdown.classList.remove('hidden');

    document.getElementById('clear-history')?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearSearchHistory();
        dropdown.classList.add('hidden');
    });

    dropdown.querySelectorAll('.history-item').forEach(btn => {
        btn.addEventListener('click', async () => {
            const query = btn.dataset.historyQuery;
            const searchBox = document.getElementById('search-box');
            if (searchBox && query) {
                searchBox.value = query;
                await initSearch();
                const results = performSearch(query);
                renderResults(results);
            }
        });
    });

    return true;
}

export function renderResults(results) {
    const dropdown = document.getElementById('search-results-dropdown');
    if (!dropdown) return;

    if (!results || results.length === 0) {
        dropdown.classList.add('hidden');
        return;
    }

    dropdown.innerHTML = results.map(r => {
        const isKnowledge = r.type === 'knowledge';
        let path = `/model/${r.slug}`;
        if (isKnowledge) path = `/knowledge/${r.slug}`;
        else if (r.type === 'agent') path = `/agent/${r.slug}`;
        else if (r.type === 'dataset') path = `/dataset/${r.slug}`;
        else if (r.type === 'paper') path = `/paper/${r.slug}`;
        else if (r.type === 'tool') path = `/tool/${r.slug}`;
        else if (r.type === 'space') path = `/space/${r.slug}`;

        const badge = isKnowledge ?
            `<span class="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded text-[10px] font-bold uppercase tracking-wider">GUIDE</span>` :
            `<span class="px-2 py-0.5 bg-blue-100 text-blue-700 rounded text-[10px] font-bold uppercase tracking-wider">MODEL</span>`;

        return `
    <a href="${path}" class="flex items-center p-3 hover:bg-gray-100 dark:hover:bg-gray-700 border-b border-gray-100 dark:border-gray-700 last:border-0">
      <div class="flex-1">
        <div class="flex items-center gap-2">
          <div class="font-medium text-gray-900 dark:text-white">${r.name}</div>
          ${badge}
        </div>
        <div class="text-xs text-gray-500 mt-0.5">
          ${isKnowledge ? 'Concepts & Foundations' : `${r.author || 'Unknown'} · FNI: ${r.fni_score || 'N/A'}`}
        </div>
      </div>
      <svg class="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path>
      </svg>
    </a>
  `}).join('');

    dropdown.classList.remove('hidden');
}

export function setupSearchEvents() {
    const searchBox = document.getElementById('search-box');
    const dropdown = document.getElementById('search-results-dropdown');

    searchBox?.addEventListener('focus', async () => {
        const wait = (ms) => new Promise(res => setTimeout(res, ms));
        let retries = 3;
        while (retries > 0) {
            const success = await initSearch();
            if (success || getSearchStatus().isLoaded) break;
            retries--;
            await wait(500);
        }
        if (!searchBox.value.trim()) renderHistory();
    });

    searchBox?.addEventListener('mouseenter', initSearch);

    document.getElementById('fullSearchToggle')?.addEventListener('change', async (e) => {
        setFullSearchActive(e.target.checked);
        if (e.target.checked) await loadFullSearchIndex();
        const query = searchBox?.value?.trim();
        if (query?.length > 0) renderResults(performSearch(query));
    });

    searchBox?.addEventListener('input', async (e) => {
        const query = e.target.value.trim();
        const fullSearchContainer = document.getElementById('full-search-container');

        if (query.length < 1) {
            if (!renderHistory()) dropdown?.classList.add('hidden');
            fullSearchContainer?.classList.add('hidden');
            return;
        }

        await initSearch();
        const results = performSearch(query);
        renderResults(results);

        const status = getSearchStatus();
        if (results.length === 0 && !status.isFullSearchActive && !status.isFullSearchLoading) {
            fullSearchContainer?.classList.remove('hidden');
        } else {
            fullSearchContainer?.classList.add('hidden');
        }
    });

    document.getElementById('smartFullSearchBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('smartFullSearchBtn');
        const span = btn?.querySelector('span');
        if (span) span.textContent = 'Downloading Index...';

        const success = await loadFullSearchIndex();
        if (success) {
            document.getElementById('full-search-container')?.classList.add('hidden');
            const query = searchBox?.value?.trim();
            if (query) renderResults(performSearch(query));
        } else {
            if (span) span.textContent = 'Retry Download';
        }
    });

    document.addEventListener('click', (e) => {
        if (!document.getElementById('search-container')?.contains(e.target)) {
            dropdown?.classList.add('hidden');
        }
    });

    document.getElementById('search-form')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const query = searchBox?.value?.trim();
        if (query) {
            saveSearchHistory(query);
            window.location.href = `/search?q=${encodeURIComponent(query)}`;
        }
    });

    document.querySelectorAll('.search-hint').forEach(btn => {
        btn.addEventListener('click', async () => {
            const query = btn.dataset.query || '';
            if (searchBox) {
                searchBox.value = query;
                await initSearch();
                renderResults(performSearch(query));
                searchBox.focus();
            }
        });
    });
}
