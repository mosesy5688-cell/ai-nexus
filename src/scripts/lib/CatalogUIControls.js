/**
 * CatalogUIControls.js
 * UI Logic extracted from UniversalCatalog.js for CES Compliance (< 250 lines).
 */
import { EntityCardRenderer } from './EntityCardRenderer.js';

export class CatalogUIControls {
    static setupInfiniteScroll(instance) {
        if (!instance.grid) return;
        instance.sentinel = document.getElementById('catalog-sentinel') || document.createElement('div');
        if (!instance.sentinel.id) {
            instance.sentinel.id = 'catalog-sentinel';
            instance.sentinel.className = 'w-full flex flex-col items-center justify-center py-12 gap-4';
            instance.grid.after(instance.sentinel);
        }

        instance.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !instance.source.isLoadingShard && instance.hasMore()) {
                instance.loadMore();
            }
        }, { rootMargin: '800px' });
        instance.observer.observe(instance.sentinel);

        const loadMoreBtn = document.createElement('button');
        loadMoreBtn.id = 'load-more-btn';
        loadMoreBtn.className = 'px-6 py-2 bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-600 dark:text-zinc-300 rounded text-[10px] font-black uppercase tracking-widest transition-all border border-zinc-200 dark:border-zinc-700 hidden mt-4';
        loadMoreBtn.textContent = 'Load More Engineering Data';
        loadMoreBtn.onclick = () => instance.loadMore();
        instance.sentinel.appendChild(loadMoreBtn);

        if (instance.paginationContainer) instance.paginationContainer.style.display = 'none';
    }

    static renderGrid(instance, append = false) {
        if (!instance.grid) return;
        const start = append ? (instance.currentPage - 1) * instance.itemsPerPage : 0;
        const pageItems = instance.filtered.slice(start, instance.currentPage * instance.itemsPerPage);

        const existingIds = append ? new Set(Array.from(instance.grid.children).map(c => c.querySelector('[data-entity-id]')?.getAttribute('data-entity-id'))) : new Set();
        const freshItems = pageItems.filter(i => !existingIds.has(i.id));

        const html = freshItems.map(item => EntityCardRenderer.createCardHTML(item, instance.source.type)).join('');

        if (append) instance.grid.insertAdjacentHTML('beforeend', html);
        else instance.grid.innerHTML = html;

        this.updateSentinel(instance);
    }

    static updateSentinel(instance) {
        if (!instance.sentinel) return;
        const hasMoreData = instance.hasMore();
        const loadMoreBtn = instance.sentinel.querySelector('#load-more-btn');

        if (hasMoreData) {
            instance.sentinel.querySelector('div:not(#load-more-btn)')?.remove();
            instance.sentinel.insertAdjacentHTML('afterbegin', '<div class="flex items-center gap-2 text-zinc-500 text-[9px] animate-pulse font-black uppercase tracking-[0.2em]"><div class="w-1.5 h-1.5 bg-amber-500 rounded-full"></div> Synchronizing technical shards...</div>');
            if (loadMoreBtn) loadMoreBtn.classList.remove('hidden');
        } else {
            instance.sentinel.innerHTML = '<div class="text-zinc-400 text-[10px] font-black uppercase tracking-[0.25em] opacity-40 py-8 border-t border-zinc-100 dark:border-zinc-800 w-full text-center">End of Professional Technical Index</div>';
            if (instance.observer) instance.observer.disconnect();
        }
    }

    static renderPagination(instance) {
        if (!instance.paginationContainer) return;
        const totalPages = Math.ceil(instance.filtered.length / instance.itemsPerPage);
        if (totalPages <= 1 && !instance.hasMore()) {
            instance.paginationContainer.innerHTML = '';
            return;
        }

        let html = '<div class="flex items-center gap-2">';
        const max = 5;
        let start = Math.max(1, instance.currentPage - 2);
        let end = Math.min(totalPages, start + max - 1);

        for (let i = start; i <= end; i++) {
            const active = i === instance.currentPage;
            html += `<button class="p-page-btn w-10 h-10 rounded border ${active ? 'bg-zinc-900 text-white border-zinc-900' : 'bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-400'} text-xs font-bold transition-all" data-page="${i}">${i}</button>`;
        }

        if (instance.hasMore()) {
            html += `<button id="next-shard-btn" class="px-4 py-2 bg-zinc-100 dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded text-[10px] font-black uppercase tracking-widest text-zinc-500">Next Shard →</button>`;
        }

        html += '</div>';
        instance.paginationContainer.innerHTML = html;

        instance.paginationContainer.querySelectorAll('.p-page-btn').forEach(btn => {
            btn.onclick = (e) => {
                instance.currentPage = parseInt(e.target.dataset.page);
                instance.renderGrid(false);
                instance.renderPagination();
                window.scrollTo({ top: instance.grid.offsetTop - 100, behavior: 'smooth' });
            };
        });

        const nextBtn = instance.paginationContainer.querySelector('#next-shard-btn');
        if (nextBtn) nextBtn.onclick = () => instance.loadMore();
    }

    static updateStats(instance) {
        if (instance.countLabel) {
            const total = instance.source.totalEntities || instance.filtered.length;
            instance.countLabel.textContent = instance.source.isLoadingShard
                ? `Syncing Technical Index [Shard ${instance.source.currentShard}/${instance.source.totalPages}]...`
                : `${total.toLocaleString()} ${instance.source.type}s verified in Industrial Intelligence Index`;
        }
    }
}
