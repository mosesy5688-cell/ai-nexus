/**
 * agents-catalog.js
 * 
 * Client-side logic for /agents catalog page
 * Fetches from trending.json and applies filters/sorting
 */

export async function initAgentsCatalog(initialData = []) {
    const grid = document.getElementById('entity-grid');
    const searchInput = document.getElementById('entity-search');
    const categoryFilter = document.getElementById('category-filter');
    const sortBy = document.getElementById('sort-by');
    const resultsCount = document.getElementById('results-count');
    const pagination = document.getElementById('pagination');

    let allEntities = initialData;
    let filteredEntities = [...allEntities];
    let currentPage = 1;
    const pageSize = 24;

    // Helper: Strip Markdown/HTML for clean card preview
    function stripHtml(html) {
        if (!html) return '';
        const tmp = document.createElement("DIV");
        tmp.innerHTML = html;
        return tmp.textContent || tmp.innerText || "";
    }

    // Apply filters and sorting
    function applyFilters() {
        const query = searchInput?.value.toLowerCase() || '';
        const category = categoryFilter?.value || '';
        const sort = sortBy?.value || 'fni';

        // Filter
        filteredEntities = allEntities.filter(e => {
            const matchesQuery = !query ||
                e.name?.toLowerCase().includes(query) ||
                (e.description && e.description.toLowerCase().includes(query));

            const matchesCategory = !category || (e.tags && e.tags.includes(category));
            return matchesQuery && matchesCategory;
        });

        // Sort
        filteredEntities.sort((a, b) => {
            switch (sort) {
                case 'fni': return (b.fni_score || 0) - (a.fni_score || 0);
                case 'downloads': return (b.downloads || 0) - (a.downloads || 0);
                case 'likes': return (b.likes || 0) - (a.likes || 0);
                case 'recent': return new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
                default: return 0;
            }
        });

        currentPage = 1;
        render();
    }

    // Render grid
    function render() {
        if (!grid) return;

        const start = (currentPage - 1) * pageSize;
        const pageItems = filteredEntities.slice(start, start + pageSize);

        // Update count
        if (resultsCount) {
            resultsCount.textContent = `${filteredEntities.length.toLocaleString()} agents available`;
            resultsCount.classList.remove('animate-pulse'); // Stop loading animation if present
        }

        if (pageItems.length === 0) {
            grid.innerHTML = `
        <div class="col-span-full text-center py-12">
          <p class="text-2xl mb-2">🔍</p>
          <p class="text-gray-500 dark:text-gray-400">No agents found matching your criteria</p>
          <button onclick="location.reload()" class="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg">Reset</button>
        </div>
      `;
            if (pagination) pagination.innerHTML = '';
            return;
        }

        grid.innerHTML = pageItems.map(item => {
            const description = stripHtml(item.description || '').slice(0, 120) + (item.description?.length > 120 ? '...' : '');

            return `
      <a href="/agent/${item.slug || item.id}" 
         class="agent-card group bg-white dark:bg-gray-800 rounded-xl p-6 shadow-sm hover:shadow-lg transition-all border border-gray-100 dark:border-gray-700 hover:border-purple-300 dark:hover:border-purple-600 block">
        <div class="flex items-center justify-between mb-4">
          <span class="text-xs px-2.5 py-1 rounded-full bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 font-medium">
            Agent
          </span>
          ${item.fni_score > 0 ? `
            <span class="text-xs font-bold text-gray-500 dark:text-gray-400">
               🛡️ ${Math.round(item.fni_score)}
            </span>
          ` : ''}
        </div>
        <h3 class="text-lg font-bold text-gray-900 dark:text-white truncate group-hover:text-purple-600 dark:group-hover:text-purple-400 mb-2">
          ${item.name || item.id}
        </h3>
        <p class="text-sm text-gray-500 dark:text-gray-400 line-clamp-3 leading-relaxed">
          ${description || 'No description available'}
        </p>
        <div class="mt-4 flex items-center gap-4 text-xs text-gray-400">
             <span>📥 ${formatNumber(item.downloads || 0)}</span>
             <span>❤️ ${formatNumber(item.likes || 0)}</span>
        </div>
      </a>
    `}).join('');

        renderPagination();
    }

    function renderPagination() {
        if (!pagination) return;

        const totalPages = Math.ceil(filteredEntities.length / pageSize);
        if (totalPages <= 1) {
            pagination.innerHTML = '';
            return;
        }

        let html = '';
        // Prev
        html += `<button class="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 ${currentPage === 1 ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'}" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">← Prev</button>`;

        // Page Info
        html += `<span class="px-4 py-2 text-sm text-gray-600 dark:text-gray-400">Page ${currentPage} of ${totalPages}</span>`;

        // Next
        html += `<button class="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-700 ${currentPage === totalPages ? 'text-gray-400 cursor-not-allowed' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-800'}" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next →</button>`;

        pagination.innerHTML = html;

        // Listeners
        pagination.querySelectorAll('button[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (page >= 1 && page <= totalPages) {
                    currentPage = page;
                    render();
                    window.scrollTo({ top: 0, behavior: 'smooth' });
                }
            });
        });
    }

    function formatNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    }

    // Helpers
    function debounce(fn, delay) {
        let timer;
        return (...args) => {
            clearTimeout(timer);
            timer = setTimeout(() => fn(...args), delay);
        };
    }

    // Event listeners
    searchInput?.addEventListener('input', debounce(applyFilters, 300));
    categoryFilter?.addEventListener('change', applyFilters);
    sortBy?.addEventListener('change', applyFilters);

    // Initial Render (if data exists)
    if (initialData.length > 0) {
        render();
    }
}
