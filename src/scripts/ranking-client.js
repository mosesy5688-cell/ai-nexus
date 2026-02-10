/**
 * Ranking Client-Side Script
 * CES V5.1.2 Art 3.3: Infinite Scroll & Pagination UX
 */
import { createModelCardHTML } from './ui-utils.js';

export function initRankingInfiniteScroll() {
    const grid = document.querySelector('.grid.grid-cols-1.md\\:grid-cols-2');
    if (!grid) return;

    const currentPath = window.location.pathname;
    let currentPage = 1;
    const maxScrollPage = 5; // CES Art 3.3: Hard Stop at Page 5
    let isLoading = false;

    // CES Art 3.3.4: Low-End Device Detection
    const deviceMemory = navigator.deviceMemory || 4;
    const isLowEnd = deviceMemory < 4;

    if (isLowEnd) {
        console.log('[Ranking] Low-end device detected. Infinite scroll disabled.');
        return;
    }

    const sentinel = document.createElement('div');
    sentinel.className = 'w-full h-20 flex justify-center items-center';
    sentinel.innerHTML = '<span class="hidden" id="scroll-loader">Loading...</span>';
    grid.parentNode?.appendChild(sentinel);

    const observer = new IntersectionObserver(async (entries) => {
        if (entries[0].isIntersecting && !isLoading && currentPage < maxScrollPage) {
            isLoading = true;
            const loader = document.getElementById('scroll-loader');
            if (loader) loader.classList.remove('hidden');

            const nextPage = currentPage + 1;
            const category = currentPath.split('/').pop();

            try {
                const path = `/cache/rankings/${category}/p${nextPage}.json`;
                const gzPath = path + '.gz';
                let res = await fetch(path);
                if (!res.ok) res = await fetch(gzPath);

                if (res.ok) {
                    let data;
                    const isGzip = res.url.endsWith('.gz');
                    const isAlreadyDecompressed = res.headers.get('Content-Encoding') === 'gzip' || res.headers.get('content-encoding') === 'gzip';

                    if (isGzip && !isAlreadyDecompressed) {
                        const ds = new DecompressionStream('gzip');
                        const decompressedStream = res.body.pipeThrough(ds);
                        const decompressedRes = new Response(decompressedStream);
                        data = await decompressedRes.json();
                    } else {
                        data = await res.json();
                    }

                    const models = data.items || data.entities || data;
                    const fragment = document.createDocumentFragment();

                    models.forEach(model => {
                        const div = document.createElement('div');
                        // Ensure model has type for ui-utils if it's missing
                        const detectedType = category.replace(/s$/, '');
                        if (!model.type) model.type = detectedType;
                        div.innerHTML = createModelCardHTML(model);
                        fragment.appendChild(div.firstElementChild);
                    });

                    grid.appendChild(fragment);
                    currentPage++;
                } else {
                    observer.disconnect();
                    sentinel.remove();
                }
            } catch (e) {
                console.error('[Ranking] Scroll load error:', e);
            } finally {
                isLoading = false;
                if (loader) loader.classList.add('hidden');
            }
        } else if (currentPage >= maxScrollPage) {
            observer.disconnect();
            if (sentinel.parentNode) {
                sentinel.innerHTML = `
          <div class="text-center w-full py-4">
            <p class="text-gray-500 mb-2">You've viewed top ${maxScrollPage * 50} models.</p>
            <a href="?page=${currentPage + 1}" class="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors">
              View Next Page ->
            </a>
          </div>
        `;
            }
        }
    }, { rootMargin: '200px' });

    observer.observe(sentinel);
}

// Auto-init on DOMContentLoaded
document.addEventListener('DOMContentLoaded', initRankingInfiniteScroll);
