/**
 * models-catalog.js
 * 
 * Client-side logic for /models catalog page
 * Fetches from trending.json and applies filters/sorting
 */

export async function initModelsCatalog(initialData = []) {
  const grid = document.getElementById('models-grid');
  const searchInput = document.getElementById('models-search');
  const categoryFilter = document.getElementById('category-filter');
  const sortBy = document.getElementById('sort-by');
  const resultsCount = document.getElementById('results-count');
  const pagination = document.getElementById('pagination');

  let allModels = initialData;
  let filteredModels = [...allModels];
  let currentPage = 1;
  const pageSize = 24;

  // Fetch models from cache if no SSR data
  async function fetchModels() {
    if (allModels.length > 0) return; // Skip if already hydrated

    try {
      const res = await fetch('https://cdn.free2aitools.com/cache/trending.json');
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      allModels = data.models || [];
      filteredModels = [...allModels];
      render();
    } catch (err) {
      console.error('Failed to load models:', err);
      if (grid) {
        grid.innerHTML = `
            <div class="col-span-full text-center py-12">
              <p class="text-gray-500 dark:text-gray-400">Failed to load models. Please try again.</p>
              <button onclick="location.reload()" class="mt-4 px-4 py-2 bg-indigo-600 text-white rounded-lg">Retry</button>
            </div>
          `;
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

  // Render models grid
  function render() {
    const start = (currentPage - 1) * pageSize;
    const pageModels = filteredModels.slice(start, start + pageSize);

    // Update count
    if (resultsCount) {
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
                    <a href="/model/${m.slug && m.slug.includes('/') ? m.slug.toLowerCase() : `${m.author || 'unknown'}/${m.name?.split('/').pop() || m.umid}`}" 
                       class="p-3 bg-indigo-50 dark:bg-indigo-900/30 rounded-lg hover:bg-indigo-100 dark:hover:bg-indigo-900/50 transition-colors">
                      <p class="font-medium text-indigo-700 dark:text-indigo-300 truncate">${m.name?.split('/').pop() || 'Model'}</p>
                      <p class="text-xs text-gray-500 dark:text-gray-400">${m.author || 'Unknown'}</p>
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
      <a href="/model/${m.slug && m.slug.includes('/') ? m.slug.toLowerCase() : `${m.author || 'unknown'}/${m.name?.split('/').pop() || m.umid}`}" 
         class="group bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm hover:shadow-lg transition-all border border-gray-100 dark:border-gray-700 hover:border-indigo-300 dark:hover:border-indigo-600">
        <div class="flex items-center justify-between mb-3">
          <span class="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
            ${m.pipeline_tag || 'model'}
          </span>
          ${m.fni_score > 0 ? `
            <span class="text-xs font-bold px-2 py-0.5 rounded-full ${(m.fni_percentile || 0) >= 90 ? 'bg-gradient-to-r from-yellow-400 to-amber-500 text-white' :
          (m.fni_percentile || 0) >= 75 ? 'bg-purple-100 dark:bg-purple-900 text-purple-700 dark:text-purple-300' :
            'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
        }">
              🛡️ ${m.fni_percentile >= 90 ? 'Top 10%' : Math.round(m.fni_score)}
            </span>
          ` : ''}
        </div>
        <h3 class="font-bold text-gray-900 dark:text-white truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 mb-1">
          ${m.name?.split('/').pop() || 'Unnamed'}
        </h3>
        <p class="text-sm text-gray-500 dark:text-gray-400 mb-3">
          by ${m.author || 'Unknown'}
        </p>
        <p class="text-sm text-gray-600 dark:text-gray-300 line-clamp-2 mb-3">
          ${m.description?.slice(0, 100) || 'No description available'}
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

  // Event listeners
  searchInput?.addEventListener('input', debounce(applyFilters, 300));
  categoryFilter?.addEventListener('change', applyFilters);
  sortBy?.addEventListener('change', applyFilters);

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
