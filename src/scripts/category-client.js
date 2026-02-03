import { stripPrefix } from '../utils/mesh-routing-core.js';

document.addEventListener('DOMContentLoaded', () => {
  const data = window.__CATEGORY_DATA__;
  if (!data || !data.models || data.models.length === 0) return;

  const modelGrid = document.getElementById('model-grid');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const pageNumbers = document.getElementById('page-numbers');
  const currentPageSpan = document.getElementById('current-page');
  const totalPagesSpan = document.getElementById('total-pages');
  const originalModels = [...data.models];

  // V13: Apply URL filters
  function applyFilters() {
    const url = new URL(window.location);
    const sizeFilter = url.searchParams.get('size') || '';
    const ggufFilter = url.searchParams.get('gguf') === 'true';
    const licenseFilter = url.searchParams.get('license') || '';

    let filtered = [...data.models];

    if (sizeFilter) {
      filtered = filtered.filter(m => {
        const p = m.params_billions || 0;
        return sizeFilter === 'small' ? p < 7 : sizeFilter === 'medium' ? p >= 7 && p <= 13 : p > 70;
      });
    }

    if (ggufFilter) {
      filtered = filtered.filter(m =>
        (m.tags || []).some(t => t.toLowerCase().includes('gguf')) || m.library_name === 'gguf'
      );
    }

    if (licenseFilter) {
      filtered = filtered.filter(m => {
        const lic = (m.license || '').toLowerCase();
        return licenseFilter === 'commercial'
          ? lic.includes('mit') || lic.includes('apache')
          : lic.includes('mit') || lic.includes('gpl');
      });
    }

    data.filteredModels = filtered;
    data.totalPages = Math.ceil(filtered.length / data.itemsPerPage);
    if (totalPagesSpan) totalPagesSpan.textContent = data.totalPages;
    const ct = document.getElementById('model-count');
    if (ct) ct.textContent = filtered.length.toLocaleString();
  }

  function renderCard(m) {
    const type = m.type || window.__CATEGORY_DATA__.type || 'model';
    const prefix = type === 'agent' ? '/agent/' : type === 'dataset' ? '/dataset/' : type === 'tool' ? '/tool/' : type === 'paper' ? '/paper/' : '/model/';

    // V16.9.23: Use centralized SSOT logic for maximal backward compatibility
    const cleanSlug = stripPrefix(m.slug || m.id || '').replace(/--/g, '/');
    const displayTitle = m.name || stripPrefix(m.id || '').replace(/--/g, ' / ');

    const url = `${prefix}${cleanSlug}`;
    return `<a href="${url}" class="model-card group block bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-lg transition-all border border-gray-100 dark:border-gray-700 p-5">
      <div class="flex items-start gap-3 mb-3">
        <div class="w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold">${(displayTitle)[0].toUpperCase()}</div>
        <div class="flex-1 min-w-0">
          <h3 class="font-semibold text-gray-900 dark:text-white truncate" title="${displayTitle}">${displayTitle}</h3>
          <p class="text-sm text-gray-500 truncate">${m.author || 'Unknown'}</p>
        </div>
      </div>
      <p class="text-sm text-gray-600 dark:text-gray-300 line-clamp-2 mb-3">${(m.description || '').replace(/<[^>]*>?/gm, '').substring(0, 100)}...</p>
      <div class="flex gap-4 text-xs text-gray-500">
        <span>⭐ ${(m.likes || 0).toLocaleString()}</span>
        <span>⬇ ${(m.downloads || 0).toLocaleString()}</span>
      </div>
    </a>`;
  }

  function renderModels(page) {
    const models = data.filteredModels || data.models;
    const start = (page - 1) * data.itemsPerPage;
    const pageModels = models.slice(start, start + data.itemsPerPage);

    if (pageModels.length === 0) {
      modelGrid.innerHTML = `<div class="col-span-full py-12 text-center text-gray-500">
        <p>No models match your filters.</p>
        <a href="${window.location.pathname}" class="text-indigo-500 hover:underline">Reset</a>
      </div>`;
      return;
    }
    modelGrid.innerHTML = pageModels.map(renderCard).join('');
  }

  function updatePagination(page) {
    data.currentPage = page;
    if (currentPageSpan) currentPageSpan.textContent = page;
    if (prevBtn) prevBtn.disabled = page === 1;
    if (nextBtn) nextBtn.disabled = page === data.totalPages;

    if (pageNumbers) {
      const max = 5;
      let start = Math.max(1, page - 2);
      let end = Math.min(data.totalPages, start + max - 1);
      if (end - start < max - 1) start = Math.max(1, end - max + 1);

      let html = start > 1 ? `<button data-page="1" class="page-btn px-3 py-1 rounded text-sm">1</button>` : '';
      if (start > 2) html += `<span class="px-2">...</span>`;
      for (let i = start; i <= end; i++) {
        const active = i === page ? 'bg-indigo-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-700';
        html += `<button data-page="${i}" class="page-btn px-3 py-1 rounded text-sm ${active}">${i}</button>`;
      }
      if (end < data.totalPages - 1) html += `<span class="px-2">...</span>`;
      if (end < data.totalPages) html += `<button data-page="${data.totalPages}" class="page-btn px-3 py-1 rounded text-sm">${data.totalPages}</button>`;

      pageNumbers.innerHTML = html;
      pageNumbers.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', () => goToPage(parseInt(btn.dataset.page)));
      });
    }
  }

  function goToPage(page) {
    if (page < 1 || page > data.totalPages) return;
    renderModels(page);
    updatePagination(page);
    const url = new URL(window.location);
    url.searchParams.set('page', page);
    history.pushState({}, '', url);
  }

  // Event listeners
  if (prevBtn) prevBtn.addEventListener('click', () => goToPage(data.currentPage - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goToPage(data.currentPage + 1));

  // Sort
  const sortSelect = document.getElementById('sort-select');
  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      const by = e.target.value;
      if (by === 'fni' || by === 'best') data.models = [...originalModels];
      else if (by === 'recent') data.models = [...originalModels].sort((a, b) => new Date(b.last_updated || 0) - new Date(a.last_updated || 0));
      else if (by === 'popular') data.models = [...originalModels].sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
      applyFilters();
      goToPage(1);
    });
  }

  // Init
  applyFilters();
  updatePagination(1);

  // Handle browser navigation
  window.addEventListener('popstate', () => {
    const pg = new URL(window.location).searchParams.get('page') || 1;
    goToPage(parseInt(pg));
  });

  // Check initial page
  const initPage = new URL(window.location).searchParams.get('page');
  if (initPage && parseInt(initPage) > 1) goToPage(parseInt(initPage));
});
