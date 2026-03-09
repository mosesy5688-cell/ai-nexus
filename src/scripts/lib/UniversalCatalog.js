// src/scripts/lib/UniversalCatalog.js
// V23.1: VFS-First Infinite Loading Controller
import { CatalogDataSource } from './CatalogDataSource.js';
import { CatalogUIControls } from './CatalogUIControls.js';

export class UniversalCatalog {
    constructor(config) {
        this.config = config;
        this.source = new CatalogDataSource({
            type: config.type,
            categoryFilter: config.categoryFilter || '',
            initialData: config.initialData || []
        });

        if (config.totalPages) this.source.totalPages = config.totalPages;

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
        }

        const params = new URLSearchParams(window.location.search);
        const urlCat = params.get('category');
        const urlQuery = params.get('q');

        if (urlCat && this.categoryFilter) {
            this.categoryFilter.value = urlCat;
        }

        if (urlQuery && this.searchInput) {
            this.searchInput.value = urlQuery;
        }

        if (this.sortSelect) {
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

        // V23.2: Initiate Background Sync Loop
        this.syncLoop();
    }

    async syncLoop() {
        if (this.source.fullDataLoaded) return;

        // If user is at bottom, sync immediately, otherwise pre-fetch aggressively
        const delay = this.hasReachedEnd() ? 500 : 2000;

        if (this.hasReachedEnd()) {
            await this.loadMore();
        } else {
            // Background pre-fetch next page
            await this.source.loadNextPage();
            this.handleSearch(this.searchInput?.value || '', null, true);
        }

        setTimeout(() => this.syncLoop(), delay);
    }

    updateUrlParam(key, value) {
        const url = new URL(window.location.href);
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
        window.history.replaceState({}, '', url);
    }

    hasMore() {
        // We have more items in local memory OR more data in SQLite to load
        return (this.currentPage * this.itemsPerPage) < this.filtered.length ||
            !this.source.fullDataLoaded;
    }

    hasReachedEnd() {
        const scrollBottom = window.innerHeight + window.scrollY;
        const bodyHeight = document.documentElement.scrollHeight;
        return (bodyHeight - scrollBottom) < 800; // Trigger when 800px from bottom
    }

    async loadMore() {
        if (this.isLoadingMore || this.source.isLoading) return;
        this.isLoadingMore = true;

        try {
            // Fetch more from SQLite if we are running low on filtered items
            if ((this.currentPage * this.itemsPerPage) >= this.filtered.length - 24 && !this.source.fullDataLoaded) {
                const newItems = await this.source.loadNextPage();
                if (newItems && newItems.length > 0) {
                    await this.handleSearch(this.searchInput?.value || '', null, true);
                }
            }

            // Increment page and render if we have available items
            if ((this.currentPage * this.itemsPerPage) < this.filtered.length) {
                this.currentPage++;
                this.renderGrid(true);
            }

            this.updateStats();
            if (!this.useInfiniteScroll) this.renderPagination();
        } catch (err) {
            console.error('[UniversalCatalog] loadMore failed:', err);
        } finally {
            this.isLoadingMore = false;
        }
    }

    async handleSearch(query = '', category = '', silent = false) {
        const results = await this.source.search(query, category || this.categoryFilter?.value || '');
        this.filtered = results;

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
