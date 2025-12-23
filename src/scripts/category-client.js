document.addEventListener('DOMContentLoaded', () => {
  const data = window.__CATEGORY_DATA__;
  if (!data || !data.models || data.models.length === 0) return;

  const modelGrid = document.getElementById('model-grid');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const pageNumbers = document.getElementById('page-numbers');
  const currentPageSpan = document.getElementById('current-page');
  const totalPagesSpan = document.getElementById('total-pages');

  function renderModels(page) {
    const start = (page - 1) * data.itemsPerPage;
    const end = start + data.itemsPerPage;
    const pageModels = data.models.slice(start, end);

    modelGrid.innerHTML = pageModels.map(model => {
      // V5.0: CES-001 Clean URL format /model/author/name
      const author = (model.author || 'unknown').toLowerCase();
      const name = (model.name || model.id?.split('/').pop() || 'unknown').toLowerCase();
      const modelUrl = `/model/${author}/${name}`;

      return `
        <a href="${modelUrl}" class="model-card group block bg-white dark:bg-gray-800 rounded-xl shadow-sm hover:shadow-lg transition-all duration-300 overflow-hidden border border-gray-100 dark:border-gray-700">
          <div class="p-5">
            <div class="flex items-start gap-3 mb-3">
              <div class="flex-shrink-0 w-10 h-10 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-lg">
                ${(model.name || 'M').charAt(0).toUpperCase()}
              </div>
              <div class="flex-1 min-w-0">
                <h3 class="font-semibold text-gray-900 dark:text-white truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                  ${model.name || model.id}
                </h3>
                <p class="text-sm text-gray-500 dark:text-gray-400 truncate">
                  ${model.author || 'Unknown'}
                </p>
              </div>
            </div>
            <p class="text-sm text-gray-600 dark:text-gray-300 line-clamp-2 mb-3">
              ${model.description?.substring(0, 100) || 'No description available'}...
            </p>
            <div class="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
              <span class="flex items-center gap-1">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M10 15l-5.878 3.09 1.123-6.545L.489 6.91l6.572-.955L10 0l2.939 5.955 6.572.955-4.756 4.635 1.123 6.545z"/></svg>
                ${model.likes?.toLocaleString() || 0}
              </span>
              <span class="flex items-center gap-1">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M3 17a1 1 0 011-1h12a1 1 0 110 2H4a1 1 0 01-1-1zm3.293-7.707a1 1 0 011.414 0L9 10.586V3a1 1 0 112 0v7.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 010-1.414z"/></svg>
                ${model.downloads?.toLocaleString() || 0}
              </span>
            </div>
          </div>
        </a>
      `;
    }).join('');

    // Scroll to top of grid
    modelGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function updatePagination(page) {
    data.currentPage = page;
    if (currentPageSpan) currentPageSpan.textContent = page;

    // Update buttons
    if (prevBtn) prevBtn.disabled = page === 1;
    if (nextBtn) nextBtn.disabled = page === data.totalPages;

    // Generate page numbers
    if (pageNumbers) {
      let pageHtml = '';
      const maxVisible = 5;
      let startPage = Math.max(1, page - Math.floor(maxVisible / 2));
      let endPage = Math.min(data.totalPages, startPage + maxVisible - 1);

      if (endPage - startPage < maxVisible - 1) {
        startPage = Math.max(1, endPage - maxVisible + 1);
      }

      if (startPage > 1) {
        pageHtml += `<button data-page="1" class="page-btn px-3 py-1 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">1</button>`;
        if (startPage > 2) pageHtml += `<span class="px-2 text-gray-400">...</span>`;
      }

      for (let i = startPage; i <= endPage; i++) {
        const isActive = i === page;
        pageHtml += `<button data-page="${i}" class="page-btn px-3 py-1 rounded text-sm ${isActive ? 'bg-indigo-600 text-white' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}">${i}</button>`;
      }

      if (endPage < data.totalPages) {
        if (endPage < data.totalPages - 1) pageHtml += `<span class="px-2 text-gray-400">...</span>`;
        pageHtml += `<button data-page="${data.totalPages}" class="page-btn px-3 py-1 rounded text-sm hover:bg-gray-100 dark:hover:bg-gray-700">${data.totalPages}</button>`;
      }

      pageNumbers.innerHTML = pageHtml;

      // Add click handlers to page buttons
      pageNumbers.querySelectorAll('.page-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetPage = parseInt(btn.dataset.page);
          goToPage(targetPage);
        });
      });
    }
  }

  function goToPage(page) {
    if (page < 1 || page > data.totalPages) return;
    renderModels(page);
    updatePagination(page);

    // Update URL without reload
    const url = new URL(window.location);
    url.searchParams.set('page', page);
    history.pushState({}, '', url);
  }

  // Event listeners
  if (prevBtn) prevBtn.addEventListener('click', () => goToPage(data.currentPage - 1));
  if (nextBtn) nextBtn.addEventListener('click', () => goToPage(data.currentPage + 1));

  // Sort functionality
  const sortSelect = document.getElementById('sort-select');
  const originalModels = [...data.models]; // Keep original order (FNI sorted)

  if (sortSelect) {
    sortSelect.addEventListener('change', (e) => {
      const sortBy = e.target.value;

      switch (sortBy) {
        case 'best':
          // Reset to original FNI-sorted order
          data.models = [...originalModels];
          break;
        case 'recent':
          // Sort by last_updated (most recent first)
          data.models = [...originalModels].sort((a, b) => {
            const dateA = new Date(a.last_updated || 0);
            const dateB = new Date(b.last_updated || 0);
            return dateB - dateA;
          });
          break;
        case 'popular':
          // Sort by downloads (highest first)
          data.models = [...originalModels].sort((a, b) =>
            (b.downloads || 0) - (a.downloads || 0)
          );
          break;
      }

      // Recalculate total pages and go to page 1
      data.totalPages = Math.ceil(data.models.length / data.itemsPerPage);
      if (totalPagesSpan) totalPagesSpan.textContent = data.totalPages;
      goToPage(1);
    });
  }

  // Initial pagination setup
  updatePagination(1);

  // Handle back/forward navigation
  window.addEventListener('popstate', () => {
    const urlPage = new URL(window.location).searchParams.get('page') || 1;
    goToPage(parseInt(urlPage));
  });

  // Check URL for initial page
  const urlPage = new URL(window.location).searchParams.get('page');
  if (urlPage && parseInt(urlPage) > 1) {
    goToPage(parseInt(urlPage));
  }
});
