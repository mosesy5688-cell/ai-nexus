/**
 * UniversalCatalog.js
 * Shared client-side logic for all entity catalog pages.
 * Handles: Search, Filtering, Sorting, Pagination, and Rendering.
 */

export class UniversalCatalog {
    constructor({
        initialData = [],
        type = 'model',
        gridId = 'entity-grid',
        countId = 'results-count',
        paginationId = 'pagination',
        searchId = 'entity-search',
        sortId = 'sort-by',
        itemsPerPage = 24,
        dataUrl = 'https://cdn.free2aitools.com/entities.json' // Default Master JSON
    }) {
        this.items = initialData; // Start with SSR data
        this.filtered = initialData;
        this.type = type;
        this.currentPage = 1;
        this.itemsPerPage = itemsPerPage;
        this.dataUrl = dataUrl;
        this.fullDataLoaded = false;
        this.isLoadingMore = false;

        // DOM Elements
        this.grid = document.getElementById(gridId);
        this.countLabel = document.getElementById(countId);
        this.paginationContainer = document.getElementById(paginationId);
        this.searchInput = document.getElementById(searchId);
        this.sortSelect = document.getElementById(sortId);

        if (!this.grid) {
            console.error(`[UniversalCatalog] Grid element #${gridId} not found`);
            return;
        }

        this.init();
    }

    init() {
        // Event Listeners
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
        this.setupPaginationListener();
        this.renderPagination();

        // Lazy Load Full Data (if not already fully loaded via SSR)
        // If SSR gave us < 1000 items, we assume there is more in the full JSON.
        if (this.dataUrl && !this.fullDataLoaded && this.items.length < 1000) {
            this.loadFullData();
        }

        console.log(`[UniversalCatalog] Initialized ${this.type} catalog with ${this.items.length} SSR items.`);
    }

    async loadFullData() {
        console.log(`[UniversalCatalog] Lazy loading full dataset from ${this.dataUrl}...`);
        this.isLoadingMore = true;
        this.updateStats(); // Show loading state

        try {
            const res = await fetch(this.dataUrl);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            const data = await res.json();

            // Parse & Normalize (Simple logic matching server)
            let all = [];
            if (Array.isArray(data)) {
                all = data;
            } else if (data.models || data.agents) {
                all = [
                    ...(data.models || []),
                    ...(data.agents || []),
                    ...(data.spaces || []),
                    ...(data.tools || []),
                    ...(data.datasets || []),
                    ...(data.papers || [])
                ];
            }

            // Filter by Type
            const validItems = all.filter(item => {
                if (this.type === 'model') return item.type === 'model' || (item.id && !item.type && !item.id.startsWith('space/'));
                if (this.type === 'agent') return item.type === 'agent' || (item.id && item.id.includes('agent'));
                if (this.type === 'space') return item.type === 'space';
                if (this.type === 'tool') return item.type === 'tool';
                if (this.type === 'dataset') return item.type === 'dataset';
                if (this.type === 'paper') return item.type === 'paper';
                return false;
            }).map(item => ({
                ...item,
                name: item.name || item.id?.split('/').pop() || 'Untitled',
                description: item.description || '',
                slug: item.slug || item.id
            }));

            // Merge with SSR items (De-duplicate by ID)
            const map = new Map();
            this.items.forEach(i => map.set(i.id, i)); // SSR items first
            validItems.forEach(i => map.set(i.id, i)); // Overwrite/Add full data

            this.items = Array.from(map.values());
            console.log(`[UniversalCatalog] Full data loaded. Total: ${this.items.length}`);

            // Update UI
            this.fullDataLoaded = true;
            this.handleSearch(this.searchInput?.value || ''); // Re-filter/Sort

        } catch (e) {
            console.error('[UniversalCatalog] Lazy Load Failed:', e);
        } finally {
            this.isLoadingMore = false;
            this.updateStats();
        }
    }

    handleSearch(query) {
        const q = query.toLowerCase().trim();

        if (!q) {
            this.filtered = [...this.items];
        } else {
            this.filtered = this.items.filter(item => {
                const name = (item.name || item.id || '').toLowerCase();
                const desc = (item.description || '').toLowerCase();
                return name.includes(q) || desc.includes(q);
            });
        }

        this.currentPage = 1;
        this.handleSort(this.sortSelect ? this.sortSelect.value : 'fni'); // Re-sort
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

        this.grid.innerHTML = pageItems.map(item => this.createCardHTML(item)).join('');

        // Scroll to top of grid
        if (this.currentPage > 1) {
            this.grid.scrollIntoView({ behavior: 'smooth' });
        }
    }

    createCardHTML(item) {
        // Sanitize description
        const cleanDesc = (item.description || '').replace(/<[^>]*>?/gm, '');
        const fniDisplay = item.fni_score && item.fni_score > 0
            ? `<span class="text-xs font-bold text-gray-500 dark:text-gray-400">🛡️ ${Math.round(item.fni_score)}</span>`
            : '';

        const typeLabel = this.getTypeLabel(this.type);
        const link = this.getLink(this.type, item);

        return `
            <a href="${link}" class="entity-card p-4 bg-white dark:bg-gray-800 rounded-xl hover:shadow-lg transition-all border border-gray-100 dark:border-gray-700 block fade-in">
                <div class="flex items-center justify-between mb-2">
                     <span class="text-xs px-2 py-0.5 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 capitalize">${typeLabel}</span>
                     ${fniDisplay}
                </div>
                <h3 class="font-bold text-gray-900 dark:text-white truncate">${item.name || item.id}</h3>
                <p class="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2" title="${cleanDesc}">${cleanDesc}</p>
                 <div class="flex items-center gap-3 mt-3 text-xs text-gray-400">
                    ${item.downloads ? `<span>📥 ${this.formatNumber(item.downloads)}</span>` : ''}
                    ${item.likes ? `<span>❤️ ${this.formatNumber(item.likes)}</span>` : ''}
                </div>
            </a>
        `;
    }

    getLink(type, item) {
        const slug = item.slug || item.id;
        // Handle special slug cases if any
        if (type === 'space') return `/space/${slug}`;
        if (type === 'tool') return `/tool/${slug}`;
        if (type === 'dataset') return `/dataset/${slug}`;
        if (type === 'paper') return `/paper/${slug}`;
        return `/${type}/${slug}`;
    }

    getTypeLabel(type) {
        if (type === 'space') return 'Space';
        if (type === 'tool') return 'Tool';
        if (type === 'dataset') return 'Dataset';
        if (type === 'paper') return 'Paper';
        return type;
    }

    renderPagination() {
        if (!this.paginationContainer) return;

        const totalPages = Math.ceil(this.filtered.length / this.itemsPerPage);

        if (totalPages <= 1) {
            this.paginationContainer.innerHTML = '';
            return;
        }

        let html = '';

        // Prev
        html += `
            <button 
                onclick="window.dispatchEvent(new CustomEvent('${this.type}-page', { detail: ${this.currentPage - 1} }))"
                class="px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-50"
                ${this.currentPage === 1 ? 'disabled' : ''}
            >←</button>
        `;

        // Page Numbers (Simple logic for now: show current, first, last)
        html += `<span class="px-3 py-1 text-sm text-gray-600 dark:text-gray-400">Page ${this.currentPage} of ${totalPages}</span>`;

        // Next
        html += `
            <button 
                onclick="window.dispatchEvent(new CustomEvent('${this.type}-page', { detail: ${this.currentPage + 1} }))"
                class="px-3 py-1 rounded-lg border border-gray-200 dark:border-gray-700 disabled:opacity-50"
                ${this.currentPage === totalPages ? 'disabled' : ''}
            >→</button>
        `;

        this.paginationContainer.innerHTML = html;

        // Bind event listeners for pagination is tricky with innerHTML string, 
        // so we use window events or we need to addEventListeners after render.
        // For simplicity in this vanilla class, let's use a custom event listener attached to window 
        // that THIS class listens to.
    }

    setupPaginationListener() {
        window.addEventListener(`${this.type}-page`, (e) => {
            const newPage = e.detail;
            if (newPage >= 1 && newPage <= Math.ceil(this.filtered.length / this.itemsPerPage)) {
                this.currentPage = newPage;
                this.renderGrid();
                this.renderPagination();
            }
        });
    }

    updateStats() {
        if (this.countLabel) {
            this.countLabel.textContent = `${this.filtered.length} ${this.type}s visible`;
        }
    }

    formatNumber(num) {
        return new Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 1 }).format(num);
    }
}
