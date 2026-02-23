// src/scripts/lib/UniversalCatalog.js
// V16.9.11: Modularized for CES Compliance (< 250 lines)
import { CatalogDataSource } from './CatalogDataSource.js';
import { CatalogUIControls } from './CatalogUIControls.js';

export class UniversalCatalog {
    constructor(config) {
        this.config = config;
        this.source = new CatalogDataSource({
            type: config.type,
            dataUrl: config.dataUrl,
            initialData: config.initialData || []
        });

        if (config.totalPages) this.source.totalPages = config.totalPages;
        if (config.totalEntities) this.source.totalEntities = config.totalEntities;

        this.filtered = [...this.source.items];
        this.currentPage = 1;
        this.itemsPerPage = config.itemsPerPage || 24;
        this.useInfiniteScroll = config.useInfiniteScroll !== false;

        this.grid = document.getElementById(config.gridId || 'models-catalog-grid');
        this.countLabel = document.getElementById(config.countId || 'results-count');
        this.paginationContainer = document.getElementById(config.paginationId || 'pagination');
        this.searchInput = document.getElementById(config.searchId || 'models-search');
        this.sortSelect = document.getElementById(config.sortId || 'sort-by');
        this.categoryFilter = document.getElementById(config.categoryFilterId || 'category-filter');

        this.init();
    }

    init() {
        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => this.handleSearch(e.target.value));
            this.searchInput.addEventListener('focus', () => this.augmentSearch(), { once: true });
        }

        const params = new URLSearchParams(window.location.search);
        const urlCat = params.get('category');
        const urlQuery = params.get('q');

        if (urlCat) {
            if (this.categoryFilter) this.categoryFilter.value = urlCat;
            this.handleSearch(urlCat);
        } else if (urlQuery) {
            if (this.searchInput) this.searchInput.value = urlQuery;
            this.handleSearch(urlQuery);
        }

        if (this.sortSelect && this.filtered.length > 0) {
            this.sortSelect.addEventListener('change', (e) => this.handleSort(e.target.value));
        }

        if (this.categoryFilter) {
            this.categoryFilter.addEventListener('change', (e) => {
                this.updateUrlParam('category', e.target.value);
                this.handleSearch(this.searchInput?.value || '', e.target.value);
            });
        }

        if (this.useInfiniteScroll) CatalogUIControls.setupInfiniteScroll(this);
        else if (this.paginationContainer) CatalogUIControls.renderPagination(this);

        this.updateStats();

        if (this.config.dataUrl && this.source.items.length < this.itemsPerPage) {
            this.loadFullData();
        } else {
            this.source.currentShard = 1;
        }
    }

    updateUrlParam(key, value) {
        const url = new URL(window.location.href);
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
        window.history.replaceState({}, '', url);
    }

    hasMore() {
        return (this.currentPage * this.itemsPerPage) < this.filtered.length ||
            this.source.currentShard < this.source.totalPages;
    }

    async loadMore() {
        if ((this.currentPage * this.itemsPerPage) >= this.filtered.length - 12 && !this.source.fullDataLoaded) {
            await this.loadFullData();
        }
        this.currentPage++;
        this.renderGrid(true);
        this.updateStats();
        if (!this.useInfiniteScroll) this.renderPagination();
    }

    async loadFullData() {
        const newItems = await this.source.loadNextShard();
        if (newItems === null && this.source.fullDataLoaded) {
            if (this.grid && !this.grid.querySelector('.empty-state-msg') && this.source.items.length === 0) {
                this.grid.innerHTML = '<div class="empty-state-msg col-span-full text-center py-20 bg-gray-900/50 rounded-xl border border-gray-800"><p class="text-xl text-gray-400 font-medium">Ecosystem Syncing...</p></div>';
            }
            return;
        }
        if (newItems) this.handleSearch(this.searchInput?.value || '', null, true);
    }

    async augmentSearch() {
        const newItems = await this.source.augmentSearch();
        if (newItems && this.searchInput?.value) this.handleSearch(this.searchInput.value);
    }

    handleSearch(query = '', category = '', silent = false) {
        this.filtered = this.source.search(query, category || this.categoryFilter?.value || '');
        if (!silent) {
            this.currentPage = 1;
            this.handleSort(this.sortSelect?.value || 'fni');
        } else {
            this.updateStats();
        }
    }

    handleSort(sortBy) {
        import('./DataNormalizer.js').then(m => {
            m.DataNormalizer.sortCollection(this.filtered, sortBy);
            this.renderGrid(false);
            this.updateStats();
        });
    }

    renderGrid(append = false) { CatalogUIControls.renderGrid(this, append); }
    renderPagination() { CatalogUIControls.renderPagination(this); }
    updateStats() { CatalogUIControls.updateStats(this); }
}
