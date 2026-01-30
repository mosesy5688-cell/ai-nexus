// src/scripts/lib/UniversalCatalog.js
// V16.2: Universal Catalog Logic with MiniSearch integration
import MiniSearch from 'minisearch';
import { EntityCardRenderer } from './EntityCardRenderer.js';
import { DataNormalizer } from './DataNormalizer.js';

export class UniversalCatalog {
    constructor({
        initialData = [],
        type = 'model',
        gridId = 'models-grid', // Default updated for consistency
        countId = 'results-count',
        paginationId = 'pagination',
        searchId = 'models-search', // Default updated for consistency
        sortId = 'sort-by',
        categoryFilterId = 'category-filter',
        itemsPerPage = 24,
        dataUrl = 'https://cdn.free2aitools.com/entities.json'
    }) {
        this.items = DataNormalizer.normalizeCollection(initialData, type);
        this.filtered = [...this.items];
        this.type = type;
        this.currentPage = 1;
        this.itemsPerPage = itemsPerPage;
        this.dataUrl = dataUrl;
        this.fullDataLoaded = false;
        this.isLoadingMore = false;

        // Engine
        this.engine = new MiniSearch({
            fields: ['name', 'author', 'description', 'tags'],
            storeFields: ['id', 'name', 'type', 'fni_score', 'slug', 'description', 'author'],
            idField: 'id',
            searchOptions: {
                boost: { name: 3, author: 1.5 },
                fuzzy: 0.2,
                prefix: true
            }
        });

        // DOM Elements
        this.grid = document.getElementById(gridId);
        this.countLabel = document.getElementById(countId);
        this.paginationContainer = document.getElementById(paginationId);
        this.searchInput = document.getElementById(searchId);
        this.sortSelect = document.getElementById(sortId);
        this.categoryFilter = document.getElementById(categoryFilterId);

        this.init();
    }

    init() {
        if (this.items.length > 0) {
            this.engine.addAll(this.items);
        }

        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => {
                this.handleSearch(e.target.value);
            });
        }

        // V16.2.1: Handle URL Parameters for initial cross-page filtering
        const params = new URLSearchParams(window.location.search);
        const urlCat = params.get('category');
        const urlQuery = params.get('q');

        if (urlCat) {
            console.log(`[UniversalCatalog] Applying initial category: ${urlCat}`);
            if (this.categoryFilter) {
                // Check if the value exists in the dropdown
                const options = Array.from(this.categoryFilter.options).map(o => o.value);
                if (options.includes(urlCat)) {
                    this.categoryFilter.value = urlCat;
                }
            }
            // Search will look through tags and descriptions
            this.handleSearch(urlCat);
        } else if (urlQuery) {
            console.log(`[UniversalCatalog] Applying initial query: ${urlQuery}`);
            if (this.searchInput) this.searchInput.value = urlQuery;
            this.handleSearch(urlQuery);
        }

        if (this.sortSelect) {
            this.sortSelect.addEventListener('change', (e) => {
                this.handleSort(e.target.value);
            });
        }

        this.updateStats();
        this.renderPagination();

        if (this.categoryFilter) {
            this.categoryFilter.addEventListener('change', (e) => {
                this.handleSearch(this.searchInput?.value || '', e.target.value);
            });
        }

        if (this.dataUrl && !this.fullDataLoaded) {
            this.loadFullData();
        }
    }

    async loadFullData() {
        this.isLoadingMore = true;
        this.updateStats();

        try {
            const res = await fetch(this.dataUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            let allRaw = Array.isArray(data) ? data : (data.entities || data.models || []);

            // Normalize & Filter
            const validItems = DataNormalizer.normalizeCollection(allRaw, this.type)
                .filter(i => i.type === this.type || (this.type === 'model' && !i.type));

            // Normalize & Merge
            const map = new Map();
            this.items.forEach(i => map.set(i.id, i));
            validItems.forEach(i => map.set(i.id, i));

            this.items = Array.from(map.values());

            // Re-index engine
            this.engine.removeAll();
            this.engine.addAll(this.items);

            this.fullDataLoaded = true;
            this.handleSearch(this.searchInput?.value || '');
        } catch (e) {
            console.error('[UniversalCatalog] Load Failed:', e);
        } finally {
            this.isLoadingMore = false;
            this.updateStats();
        }
    }

    handleSearch(query = '', category = '') {
        const q = query.trim();
        const cat = category || this.categoryFilter?.value || '';

        let results = [...this.items];

        // 1. Precise Category Filter (V16.4.4)
        if (cat && cat !== '') {
            results = results.filter(i => i.category === cat);
        }

        // 2. Keyword Search (MiniSearch)
        if (q && q.length >= 2) {
            const searchResults = this.engine.search(q);
            const searchIds = new Set(searchResults.map(r => r.id));
            results = results.filter(i => searchIds.has(i.id));

            // Re-order results by search score if searching
            const scoreMap = new Map(searchResults.map(r => [r.id, r.score]));
            results.sort((a, b) => (scoreMap.get(b.id) || 0) - (scoreMap.get(a.id) || 0));
        }

        this.filtered = results.map(r => ({
            ...r,
            fni_score: r.fni_score || 0
        }));

        this.currentPage = 1;
        this.handleSort(this.sortSelect?.value || 'fni');
    }

    handleSort(sortBy) {
        DataNormalizer.sortCollection(this.filtered, sortBy);
        this.renderGrid();
        this.renderPagination();
        this.updateStats();
    }

    renderGrid() {
        const start = (this.currentPage - 1) * this.itemsPerPage;
        const end = start + this.itemsPerPage;
        const pageItems = this.filtered.slice(start, end);

        // Uses Extracted Renderer (CES Compliance)
        this.grid.innerHTML = pageItems.map(item => EntityCardRenderer.createCardHTML(item, this.type)).join('');

        // Scroll to top of grid
        if (this.currentPage > 1) {
            this.grid.scrollIntoView({ behavior: 'smooth' });
        }
    }

    changePage(newPage) {
        if (newPage >= 1 && newPage <= Math.ceil(this.filtered.length / this.itemsPerPage)) {
            this.currentPage = newPage;
            this.renderGrid();
            this.renderPagination();
            // Dispatch event for other components if needed, but internal logic is direct now.
            window.dispatchEvent(new CustomEvent(`${this.type}-page-changed`, { detail: newPage }));
        }
    }

    renderPagination() {
        if (!this.paginationContainer) {
            console.warn('[UniversalCatalog] Pagination container not found');
            return;
        }

        this.paginationContainer.innerHTML = '';

        const totalPages = Math.ceil(this.filtered.length / this.itemsPerPage);
        console.log(`[UniversalCatalog] Rendering Pagination: ${this.filtered.length} items / ${this.itemsPerPage} = ${totalPages} pages`);

        if (totalPages <= 1) {
            this.paginationContainer.innerHTML = '';
            return;
        }

        // Generate HTML structure
        this.paginationContainer.innerHTML = `
            <button class="prev-btn px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-50" ${this.currentPage === 1 ? 'disabled' : ''}>←</button>
            <span class="px-3 py-1 text-sm text-gray-600 dark:text-gray-400">Page ${this.currentPage} of ${totalPages}</span>
            <button class="next-btn px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-50" ${this.currentPage === totalPages ? 'disabled' : ''}>→</button>
        `;

        // Attach Listeners Directly
        const prevBtn = this.paginationContainer.querySelector('.prev-btn');
        const nextBtn = this.paginationContainer.querySelector('.next-btn');

        if (prevBtn) prevBtn.addEventListener('click', () => this.changePage(this.currentPage - 1));
        if (nextBtn) nextBtn.addEventListener('click', () => this.changePage(this.currentPage + 1));
    }

    updateStats() {
        if (this.countLabel) {
            const total = this.hasMore ? `${this.filtered.length}+` : this.filtered.length;
            this.countLabel.textContent = this.isLoadingMore
                ? `Loading more... (${this.items.length})`
                : `${total} ${this.type}s visible`;
        }
    }
}
