/**import { createModelCardHTML } from './ui-utils.js';
 * V13 Category Filter Logic
 * Client-side filtering for size, GGUF, and license
 */

export function applyFilters(data, totalPagesSpan) {
  const url = new URL(window.location);
  const sizeFilter = url.searchParams.get('size') || '';
  const ggufFilter = url.searchParams.get('gguf') === 'true';
  const licenseFilter = url.searchParams.get('license') || '';

  let filtered = [...data.models];

  // Size filter
  if (sizeFilter) {
    filtered = filtered.filter(m => {
      const params = m.params_billions || 0;
      switch (sizeFilter) {
        case 'small': return params < 7;
        case 'medium': return params >= 7 && params <= 13;
        case 'large': return params > 70;
        default: return true;
      }
    });
  }

  // GGUF filter
  if (ggufFilter) {
    filtered = filtered.filter(m => {
      const tags = m.tags || [];
      const hasGguf = tags.some(t => t.toLowerCase().includes('gguf'));
      const hasLibrary = m.library_name === 'gguf';
      return hasGguf || hasLibrary;
    });
  }

  // License filter
  if (licenseFilter) {
    filtered = filtered.filter(m => {
      const license = (m.license || m.license_spdx || '').toLowerCase();
      if (licenseFilter === 'commercial') {
        return license.includes('mit') || license.includes('apache') || license.includes('cc-by');
      } else if (licenseFilter === 'open') {
        return license.includes('mit') || license.includes('apache') || license.includes('gpl') || license.includes('bsd');
      }
      return true;
    });
  }

  data.filteredModels = filtered;
  data.totalPages = Math.ceil(filtered.length / data.itemsPerPage);

  // Update UI
  if (totalPagesSpan) totalPagesSpan.textContent = data.totalPages;
  const modelCount = document.getElementById('model-count');
  if (modelCount) modelCount.textContent = filtered.length.toLocaleString();

  return filtered;
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
        </div >
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
      </div >
    </a >
    `;
}
