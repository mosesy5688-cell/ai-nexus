// src/scripts/lib/UniversalCatalog.js
// V16.2: Universal Catalog Logic with MiniSearch integration
import MiniSearch from 'minisearch';
import { EntityCardRenderer } from './EntityCardRenderer.js';

export class UniversalCatalog {
    constructor({
        initialData = [],
        type = 'model',
        gridId = 'models-grid', // Default updated for consistency
        countId = 'results-count',
        paginationId = 'pagination',
        searchId = 'models-search', // Default updated for consistency
        sortId = 'sort-by',
        itemsPerPage = 24,
        dataUrl = 'https://cdn.free2aitools.com/entities.json'
    }) {
        const normalize = (item) => {
            const id = item.id;
            const type = item.type || this.type;
            let name = item.name || '';
            let slug = item.slug || '';
            let author = item.author || '';

            if (!name && id) {
                name = id.split('--').pop().split(':').pop().split('/').pop();
            }
            if (!slug && id) {
                slug = id.replace(/^(github--|hf-dataset--|arxiv--|replicate:)/, '').replace('--', '/').replace(':', '/');
            }
            if (!author && id) {
                if (id.includes('--')) author = id.split('--')[1];
                else if (id.includes(':')) author = id.split(':')[1].split('/')[0];
            }

            return {
                ...item,
                id,
                name,
                type,
                slug,
                author,
                fni_score: item.fni || item.fni_score || 0
            };
        };

        this.items = initialData.map(normalize);
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

        if (this.sortSelect) {
            this.sortSelect.addEventListener('change', (e) => {
                this.handleSort(e.target.value);
            });
        }

        this.updateStats();
        this.renderPagination();

        if (this.dataUrl && !this.fullDataLoaded) {
            this.loadFullData();
        }
    }

    async loadFullData() {
        this.isLoadingMore = true;
        this.updateStats();

        const normalize = (item) => {
            const id = item.id;
            const type = item.type || this.type;
            let name = item.name || '';
            let slug = item.slug || '';
            let author = item.author || '';

            if (!name && id) {
                name = id.split('--').pop().split(':').pop().split('/').pop();
            }
            if (!slug && id) {
                slug = id.replace(/^(github--|hf-dataset--|arxiv--|replicate:)/, '').replace('--', '/').replace(':', '/');
            }
            if (!author && id) {
                if (id.includes('--')) author = id.split('--')[1];
                else if (id.includes(':')) author = id.split(':')[1].split('/')[0];
            }

            return {
                ...item,
                id,
                name,
                type,
                slug,
                author,
                fni_score: item.fni || item.fni_score || 0
            };
        };

        try {
            const res = await fetch(this.dataUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();

            let allRaw = Array.isArray(data) ? data : (data.entities || data.models || []);

            // Normalize & Filter
            const validItems = allRaw
                .filter(i => i.type === this.type || (this.type === 'model' && !i.type))
                .map(normalize);

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

    handleSearch(query) {
        const q = query.trim();

        if (!q || q.length < 2) {
            this.filtered = [...this.items];
        } else {
            const results = this.engine.search(q);
            // Map results back to full item objects if needed, 
            // but MiniSearch already stores display fields.
            this.filtered = results.map(r => ({
                ...r,
                // Ensure consistency in field names
                fni_score: r.fni_score || 0
            }));
        }

        this.currentPage = 1;
        this.handleSort(this.sortSelect?.value || 'fni');
    }

    handleSort(sortBy) {
        switch (sortBy) {
            case 'fni':
                this.filtered.sort((a, b) => (b.fni_score || 0) - (a.fni_score || 0));
                break;
            case 'downloads':
                this.filtered.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
                break;
            case 'likes':
                this.filtered.sort((a, b) => (b.likes || 0) - (a.likes || 0));
                break;
            case 'recent':
                this.filtered.sort((a, b) => new Date(b.lastModified || 0) - new Date(a.lastModified || 0));
                break;
            case 'name':
                this.filtered.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
                break;
        }

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
