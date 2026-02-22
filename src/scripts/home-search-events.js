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
import { getRouteFromId } from '../utils/mesh-routing-core.js';
import { highlightTerms } from './search-ui-controller.js';

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
                const results = await performSearch(query);
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
        const path = getRouteFromId(r.id || r.slug, r.type || 'model');
        const isKnowledge = (r.type || 'model') === 'knowledge';

        // V16.8.15 R5.7.1: Minimalist Dropdown Row
        const typeLabel = isKnowledge ? 'Guide' : (r.type || 'Model').toUpperCase();

        return `
    <a href="${path}" class="flex flex-col p-2.5 hover:bg-zinc-50 dark:hover:bg-zinc-800 border-b border-zinc-100 dark:border-zinc-700/50 last:border-0 group">
      <div class="flex items-center justify-between gap-2">
        <div class="flex items-center gap-2 overflow-hidden">
          <span class="text-[8px] font-bold px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-900 text-zinc-400 rounded uppercase tracking-tighter">${typeLabel}</span>
          <div class="font-bold text-xs text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 truncate">
            ${highlightTerms(r.name, document.getElementById('search-box')?.value || '')}
          </div>
        </div>
        <div class="text-[10px] text-zinc-400 font-black ml-2 tabular-nums">
          ${r.fni_score ?? r.fni ?? '-'}
        </div>
      </div>
      <div class="flex items-center justify-between mt-1">
        <div class="text-[10px] text-zinc-500 truncate italic pr-4">
            ${highlightTerms(r.description || '', document.getElementById('search-box')?.value || '')}
        </div>
        <div class="text-[10px] text-zinc-400 flex-shrink-0">⭐ ${r.likes || 0}</div>
      </div>
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


    let searchDebounceTimer;

    searchBox?.addEventListener('input', (e) => {
        const query = e.target.value.trim();
        const fullSearchContainer = document.getElementById('full-search-container');

        if (query.length < 1) {
            clearTimeout(searchDebounceTimer);
            if (!renderHistory()) dropdown?.classList.add('hidden');
            fullSearchContainer?.classList.add('hidden');
            return;
        }

        // V18.2.12: Instant init + Debounced search
        initSearch();

        // V18.2.12: Silent Full Load on first interaction
        const status = getSearchStatus();
        if (!status.isFullSearchActive && !status.isFullSearchLoading) {
            loadFullSearchIndex();
        }

        clearTimeout(searchDebounceTimer);
        searchDebounceTimer = setTimeout(async () => {
            const results = await performSearch(query);
            renderResults(results);

            if (results.length > 0) {
                const resultsGrid = document.getElementById('models-grid');
                resultsGrid?.classList.remove('hidden');
            }
        }, 300);
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
                const results = await performSearch(query);
                renderResults(results);
                searchBox.focus();
            }
        });
    });

    // V21.9: Expert Keyboard Interactions (A-Rating)
    let selectedIndex = -1;
    searchBox?.addEventListener('keydown', (e) => {
        const items = dropdown?.querySelectorAll('a.flex');
        if (!items || items.length === 0) return;

        if (e.key === 'Escape') {
            dropdown.classList.add('hidden');
            searchBox.blur();
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            items.forEach((item, idx) => item.classList.toggle('bg-zinc-100', idx === selectedIndex));
            items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            items.forEach((item, idx) => item.classList.toggle('bg-zinc-100', idx === selectedIndex));
            if (selectedIndex >= 0) items[selectedIndex]?.scrollIntoView({ block: 'nearest' });
        } else if (e.key === 'Enter') {
            if (selectedIndex >= 0) {
                e.preventDefault();
                items[selectedIndex].click();
            } else if (!searchBox.value.trim()) {
                e.preventDefault();
            }
            // If selectedIndex < 0 and query exists, let it fall through to the form submit event
        }
    });
}
