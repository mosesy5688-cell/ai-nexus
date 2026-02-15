// src/scripts/lib/UniversalCatalog.js
// V16.9.10: Modularized with CatalogDataSource (Art 5.1 compliant)
import { EntityCardRenderer } from './EntityCardRenderer.js';
import { DataNormalizer } from './DataNormalizer.js';
import { CatalogDataSource } from './CatalogDataSource.js';

export class UniversalCatalog {
    constructor(config) {
        this.config = config;
        this.source = new CatalogDataSource({
            type: config.type,
            dataUrl: config.dataUrl,
            initialData: config.initialData || []
        });

        this.filtered = [...this.source.items];
        this.currentPage = 1;
        this.itemsPerPage = config.itemsPerPage || 24;

        // DOM Elements
        this.grid = document.getElementById(config.gridId || 'models-grid');
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

        if (this.sortSelect) {
            this.sortSelect.addEventListener('change', (e) => this.handleSort(e.target.value));
        }

        if (this.categoryFilter) {
            this.categoryFilter.addEventListener('change', (e) => {
                this.updateUrlParam('category', e.target.value);
                this.handleSearch(this.searchInput?.value || '', e.target.value);
            });
        }

        this.setupInfiniteScroll();
        this.updateStats();

        // V18.7: Zero-Jump Hydration - Skip shard 1 if initial data is sufficient
        if (this.config.dataUrl && this.source.items.length < this.itemsPerPage) {
            this.loadFullData();
        } else {
            this.source.currentShard = 1; // Align shard counter with SSR initial state
        }
    }

    updateUrlParam(key, value) {
        const url = new URL(window.location.href);
        if (value) url.searchParams.set(key, value);
        else url.searchParams.delete(key);
        window.history.replaceState({}, '', url);
    }

    setupInfiniteScroll() {
        if (!this.grid) return;
        this.sentinel = document.getElementById('catalog-sentinel') || document.createElement('div');
        if (!this.sentinel.id) {
            this.sentinel.id = 'catalog-sentinel';
            this.sentinel.className = 'h-10 w-full flex items-center justify-center py-8';
            this.grid.after(this.sentinel);
        }

        this.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !this.source.isLoadingShard && this.hasMore()) {
                this.loadMore();
            }
        }, { rootMargin: '800px' });
        this.observer.observe(this.sentinel);

        if (this.paginationContainer) this.paginationContainer.style.display = 'none';
    }

    hasMore() {
        return (this.currentPage * this.itemsPerPage) < this.filtered.length ||
            this.source.currentShard < this.source.totalPages;
    }

    async loadMore() {
        // V18.7: Predictive Prefetching (Threshold-based)
        if ((this.currentPage * this.itemsPerPage) >= this.filtered.length - 12 && !this.source.fullDataLoaded) {
            await this.loadFullData();
        }
        this.currentPage++;
        this.renderGrid(true);
        this.updateStats();
    }

    async loadFullData() {
        const newItems = await this.source.loadNextShard();
        if (newItems) {
            this.handleSearch(this.searchInput?.value || '', null, true);
        }
    }

    async augmentSearch() {
        console.log('[UniversalCatalog] Augmenting search...');
        const newItems = await this.source.augmentSearch();
        if (newItems && this.searchInput?.value) {
            this.handleSearch(this.searchInput.value);
        }
    }

    handleSearch(query = '', category = '', silent = false) {
        const cat = category || this.categoryFilter?.value || '';
        this.filtered = this.source.search(query, cat);

        if (!silent) {
            this.currentPage = 1;
            this.handleSort(this.sortSelect?.value || 'fni');
        } else {
            this.updateStats();
        }
    }

    handleSort(sortBy) {
        DataNormalizer.sortCollection(this.filtered, sortBy);
        this.renderGrid(false);
        this.updateStats();
    }

    renderGrid(append = false) {
        if (!this.grid) return;
        const start = append ? (this.currentPage - 1) * this.itemsPerPage : 0;
        const pageItems = this.filtered.slice(start, this.currentPage * this.itemsPerPage);
        const html = pageItems.map(item => EntityCardRenderer.createCardHTML(item, this.source.type)).join('');

        if (append) this.grid.insertAdjacentHTML('beforeend', html);
        else this.grid.innerHTML = html;

        if (this.sentinel) {
            this.sentinel.innerHTML = this.hasMore()
                ? '<div class="flex items-center gap-2 text-gray-400 text-xs animate-pulse font-medium uppercase tracking-widest"><div class="w-1.5 h-1.5 bg-indigo-500 rounded-full"></div> Loading next shard...</div>'
                : '<div class="text-gray-300 text-[10px] font-black uppercase tracking-[0.2em] opacity-40">End of Technical Index</div>';
        }
    }

    updateStats() {
        if (this.countLabel) {
            const total = this.source.totalEntities || this.filtered.length;
            if (this.source.isLoadingShard) {
                this.countLabel.textContent = `Syncing Technical Index [Shard ${this.source.currentShard}/${this.source.totalPages}]...`;
            } else {
                // V16.5: Professional Intelligence Terminology
                this.countLabel.textContent = `${total.toLocaleString()} ${this.source.type}s indexed in Professional Intelligence Database`;
            }
        }
    }
}

