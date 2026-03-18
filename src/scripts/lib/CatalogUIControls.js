/**
 * CatalogUIControls.js
 * UI Logic extracted from UniversalCatalog.js for CES Compliance (< 250 lines).
 */
import { EntityCardRenderer } from './EntityCardRenderer.js';

export class CatalogUIControls {
    static setupInfiniteScroll(instance) {
        if (!instance.grid) {
            console.error('[CatalogUIControls] ❌ Grid element not found, cannot setup infinite scroll.');
            return;
        }

        console.log(`[CatalogUIControls] 🚀 Setting up infinite scroll for ${instance.config.gridId}`);

        instance.sentinel = document.getElementById('catalog-sentinel') || document.createElement('div');
        if (!instance.sentinel.id || !instance.sentinel.parentNode) {
            instance.sentinel.id = 'catalog-sentinel';
            instance.sentinel.className = 'w-full flex flex-col items-center justify-center py-20 gap-4 border-t border-dashed border-zinc-800 mt-12';
            instance.grid.after(instance.sentinel);
            console.log('[CatalogUIControls] ✅ Sentinel created and appended.');
        }

        instance.observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting) {
                console.log('[CatalogUIControls] 👀 Sentinel in view.');
                if (!instance.source.isLoadingShard && instance.hasMore()) {
                    console.log('[CatalogUIControls] 📥 Triggering loadMore...');
                    instance.loadMore();
                } else {
                    console.log(`[CatalogUIControls] ⏭️ Skipping loadMore: loading=${instance.source.isLoadingShard}, hasMore=${instance.hasMore()}`);
                }
            }
        }, { rootMargin: '600px', threshold: 0.01 });

        instance.observer.observe(instance.sentinel);

        if (instance.paginationContainer) instance.paginationContainer.style.display = 'none';
    }

    static renderGrid(instance, append = false) {
        if (!instance.grid) return;
        const start = append ? (instance.currentPage - 1) * instance.itemsPerPage : 0;
        const pageItems = instance.filtered.slice(start, instance.currentPage * instance.itemsPerPage);

        console.log(`[CatalogUIControls] 🖼️ Rendering grid: append=${append}, page=${instance.currentPage}, items=${pageItems.length}`);

        const existingIds = append ? new Set(Array.from(instance.grid.children).map(c => c.querySelector('[data-entity-id]')?.getAttribute('data-entity-id'))) : new Set();
        const freshItems = pageItems.filter(i => !existingIds.has(i.id));

        const html = freshItems.map(item => EntityCardRenderer.createCardHTML(item, item.type || instance.source.type)).join('');

        if (append) {
            if (html) instance.grid.insertAdjacentHTML('beforeend', html);
        } else {
            instance.grid.innerHTML = html;
        }

        this.updateSentinel(instance);
    }

    static updateSentinel(instance) {
        if (!instance.sentinel) return;
        const hasMoreData = instance.hasMore();

        if (hasMoreData) {
            instance.sentinel.innerHTML = `
                <div class="flex flex-col items-center gap-4">
                    <div class="flex items-center gap-3 text-xs font-black uppercase tracking-[0.3em] animate-pulse text-amber-500">
                        <div class="w-2 h-2 bg-amber-500 rounded-full"></div>
                        Querying Technical Registry...
                    </div>
                    <button id="load-more-btn" class="px-6 py-2 bg-white/5 hover:bg-white/10 border border-white/10 hover:border-white/20 rounded-sm text-[10px] font-black text-zinc-400 hover:text-white uppercase tracking-widest transition-all">
                        Load More
                    </button>
                </div>
            `;
            const btn = instance.sentinel.querySelector('#load-more-btn');
            if (btn) btn.addEventListener('click', () => instance.loadMore());
        } else {
            instance.sentinel.innerHTML = `
                <div class="py-12 flex flex-col items-center gap-4 w-full opacity-40">
                    <div class="h-px bg-zinc-800 w-1/4"></div>
                    <div class="text-zinc-400 text-[10px] font-black uppercase tracking-[0.4em]">End of Industrial Technical Index</div>
                    <div class="h-px bg-zinc-800 w-1/4"></div>
                </div>
            `;
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
            const total = instance.filtered.length;
            instance.countLabel.textContent = instance.source.isLoading
                ? `Loading...`
                : `${total.toLocaleString()} ${instance.source.type}s indexed`;
        }
    }
}
