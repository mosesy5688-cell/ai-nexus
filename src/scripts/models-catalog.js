/**
 * models-catalog.js
 *
 * Client-side logic for /models catalog page.
 * V27.65: cache/trending.json retired -> /api/v1/search (data/* VFS).
 * Layer-0 cap = 20/page; "Load more" button bumps ?page=N (1-indexed,
 * matches internal /api/search OFFSET=(page-1)*limit at search.ts:120,162).
 */
import { getRouteFromId } from '../utils/mesh-routing-core.js';
import { escapeHtml } from '../utils/escape-html.js';

export async function initModelsCatalog(initialData = []) {
  const grid = document.getElementById('models-grid');
  const searchInput = document.getElementById('models-search');
  const categoryFilter = document.getElementById('category-filter');
  const sortBy = document.getElementById('sort-by');
  const resultsCount = document.getElementById('results-count');
  const pagination = document.getElementById('pagination');

  let allModels = initialData;
  let filteredModels = [...allModels];
  let currentPage = 1;          // 1-indexed, locked literal (off-by-one guard)
  let apiPage = 1;              // backend ?page=N cursor for Load-more
  let apiTotal = null;          // total_count from API for Load-more gating
  const pageSize = 20;          // align with /api/v1/search FREE_TIER_MAX

  // Fetch models from /api/v1/search (V27.65 Phase 0.5b)
  async function fetchModels(append = false) {
    if (!append && allModels.length > 0) return; // SSR-hydrated, skip initial
    try {
      const sort = sortBy?.value === 'recent' ? 'last_updated' : (sortBy?.value || 'fni');
      const res = await fetch(`/api/v1/search?type=model&sort=${encodeURIComponent(sort)}&limit=${pageSize}&page=${apiPage}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      const body = await res.json();
      const items = body.results || body.models || [];
      if (!Array.isArray(items)) throw new TypeError(`Expected array, got ${typeof items}`);
      apiTotal = body.total_count ?? body.total ?? null;
      allModels = append ? allModels.concat(items) : items;
      filteredModels = [...allModels];
      render();
    } catch (err) {
      console.error('[models-catalog:fetchModels]', err?.message);
      if (grid && !append) {
        grid.innerHTML = `
            <div class="col-span-full text-center py-12 api-fallback-err" data-component="models-catalog">
              <p class="text-gray-500 dark:text-gray-400">[catalog currently unavailable]</p>
              <button onclick="location.reload()" class="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg">Retry</button>
            </div>`;
      }
    }
  }

  // Apply filters and sorting
  function applyFilters() {
    const query = searchInput?.value.toLowerCase() || '';
    const category = categoryFilter?.value || '';
    const sort = sortBy?.value || 'fni';

    // Filter
    filteredModels = allModels.filter(m => {
      const matchesQuery = !query ||
        m.name?.toLowerCase().includes(query) ||
        m.author?.toLowerCase().includes(query);
      const matchesCategory = !category || m.pipeline_tag === category || m.primary_category === category;
      return matchesQuery && matchesCategory;
    });

    // Sort
    filteredModels.sort((a, b) => {
      switch (sort) {
        case 'fni': return (b.fni_score ?? b.fni ?? 0) - (a.fni_score ?? a.fni ?? 0);
        case 'downloads': return (b.downloads || 0) - (a.downloads || 0);
        case 'likes': return (b.likes || 0) - (a.likes || 0);
        case 'recent': return new Date(b.lastModified || 0) - new Date(a.lastModified || 0);
        default: return 0;
      }
    });

    currentPage = 1;
    render();
  }

  // Render models grid
  function render() {
    const start = (currentPage - 1) * pageSize;
    const pageModels = filteredModels.slice(start, start + pageSize);

    // Update count if element exists
    if (resultsCount) {
      // Logic handled by Astro SSR initially, client updates for filtering
      resultsCount.textContent = `${filteredModels.length.toLocaleString()} models found`;
    }

    // Render grid
    if (pageModels.length === 0) {
      // Get top 4 models by FNI as recommendations
      const hotModels = allModels.slice(0, 4);
      const hotHtml = hotModels.length > 0 ? `
              <div class="mt-6 pt-6 border-t border-gray-200 dark:border-gray-700">
                <p class="text-sm text-gray-500 dark:text-gray-400 mb-4">Try these trending models:</p>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
                  ${hotModels.map(m => `
                    <a href="${getRouteFromId(m.slug || m.id, 'model')}"
                       class="p-3 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">
                      <p class="font-medium text-indigo-700 dark:text-indigo-300 truncate">${escapeHtml(m.name?.split('/').pop() || 'Model')}</p>
                      <p class="text-xs text-gray-500 dark:text-gray-400">${escapeHtml(m.author || 'Unknown')}</p>
                    </a>
                  `).join('')}
                </div>
              </div>
            ` : '';

      grid.innerHTML = `
        <div class="col-span-full text-center py-12">
          <p class="text-2xl mb-2">🔍</p>
          <p class="text-gray-500 dark:text-gray-400">No models found matching your criteria</p>
          <p class="text-sm text-gray-400 dark:text-gray-500 mt-2">Try adjusting your search or filters</p>
          ${hotHtml}
        </div>
      `;
      return;
    }

    grid.innerHTML = pageModels.map(m => `
      <a href="${getRouteFromId(m.slug || m.id, 'model')}"
         class="group bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm hover:shadow-lg transition-all border border-gray-100 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
            ${escapeHtml(m.pipeline_tag || 'model')}
          </span>
          ${(m.fni_score > 0 || m.fni > 0 || m.fni_percentile || m.percentile) ? `
            <span class="text-xs font-bold px-2 py-0.5 rounded-full ${(m.fni_percentile === 'top_1%' || m.fni_percentile === 'top_10%' || m.percentile?.startsWith?.('top_') || (typeof m.fni_percentile === 'number' && m.fni_percentile >= 90)) ? 'bg-gradient-to-r from-yellow-400 to-amber-500 text-white' :
          (m.fni_percentile === 'top_25%' || (typeof m.fni_percentile === 'number' && m.fni_percentile >= 75)) ? 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300' :
            'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
        }">
              🛡️ ${escapeHtml((m.fni_percentile || m.percentile)?.startsWith?.('top_') ? (m.fni_percentile || m.percentile).replace('top_', 'Top ') : String(Math.round(m.fni_score ?? m.fni ?? 0)))}
            </span>
          ` : ''}
        </div>
        <h3 class="font-bold text-gray-900 dark:text-white truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 mb-1">
          ${escapeHtml(m.name?.split('/').pop() || 'Unnamed')}
        </h3>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
          by ${escapeHtml(m.author || 'Unknown')}
        </p>
        <p class="text-sm text-gray-600 dark:text-gray-300 line-clamp-2 mb-3">
          ${escapeHtml(m.description?.slice(0, 100) || 'No description available')}
        </p>
        <div class="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span>❤️ ${formatNumber(m.likes || 0)}</span>
          <span>📥 ${formatNumber(m.downloads || 0)}</span>
        </div>
      </a>
    `).join('');

    // Render pagination
    renderPagination();
  }

  function renderPagination() {
    const totalPages = Math.ceil(filteredModels.length / pageSize);
    if (totalPages <= 1) {
      pagination.innerHTML = '';
      return;
    }

    let html = '';

    // Prev
    html += `<button class="px-3 py-2 rounded-lg ${currentPage === 1 ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'}" ${currentPage === 1 ? 'disabled' : ''} data-page="${currentPage - 1}">← Prev</button>`;

    // Page numbers
    const maxVisible = 5;
    let start = Math.max(1, currentPage - 2);
    let end = Math.min(totalPages, start + maxVisible - 1);
    if (end - start < maxVisible - 1) start = Math.max(1, end - maxVisible + 1);

    for (let i = start; i <= end; i++) {
      html += `<button class="w-10 h-10 rounded-lg ${i === currentPage ? 'bg-indigo-600 text-white' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'}" data-page="${i}">${i}</button>`;
    }

    // Next
    html += `<button class="px-3 py-2 rounded-lg ${currentPage === totalPages ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700'}" ${currentPage === totalPages ? 'disabled' : ''} data-page="${currentPage + 1}">Next →</button>`;

    pagination.innerHTML = html;

    // Add event listeners
    pagination.querySelectorAll('button[data-page]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const page = parseInt(btn.dataset.page);
        if (page < 1) return;
        // Local end + API has more -> fetch next API page then advance local cursor
        if (page > totalPages && apiTotal != null && allModels.length < apiTotal) {
          await window.__catalogLoadMore?.();
          currentPage = page;
        } else if (page <= totalPages) {
          currentPage = page;
        }
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    });
  }

  function formatNumber(num) {
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  }

  // Append "Load more" handler — only fires when local pagination hits end + API has more
  async function loadMoreFromApi() {
    if (apiTotal != null && allModels.length >= apiTotal) return;
    apiPage += 1;
    await fetchModels(true);
  }

  // Sort change re-queries the API to honor server-side ranking on the full corpus
  async function onSortChange() {
    apiPage = 1;
    currentPage = 1;
    allModels = [];
    await fetchModels(false);
  }

  // Event listeners
  searchInput?.addEventListener('input', debounce(applyFilters, 300));
  categoryFilter?.addEventListener('change', applyFilters);
  sortBy?.addEventListener('change', onSortChange);

  // Expose for the pagination Next button to call when local end reached
  window.__catalogLoadMore = loadMoreFromApi;

  function debounce(fn, delay) {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  }

  // Init
  await fetchModels();
}
