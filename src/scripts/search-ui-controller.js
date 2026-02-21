// src/scripts/search-ui-controller.js
// V16.8.20: UI Controller for Search Results & Lazy Hydration
// Handles DOM orchestration, result rendering, and IntersectionObserver-based hydration.

import { initSearch, performSearch, getSearchStatus } from './home-search.js';
import { getRouteFromId } from '../utils/mesh-routing-core.js';

export function setupSearchUI(dom) {
    if (!dom) return;

    const { form, box, title, results, loading, empty, prompt } = dom;

    async function handleSearch() {
        const query = box.value.trim();
        const type = form.querySelector('input[name="type"]:checked')?.value || 'all';

        if (query.length < 2) return;

        loading.classList.remove('hidden');
        results.innerHTML = '';
        empty.classList.add('hidden');
        prompt.classList.add('hidden');

        await initSearch();
        const searchResults = await performSearch(query, 40);
        const filtered = type === 'all' ? searchResults : searchResults.filter(r => r.type === type);

        const cleaned = filtered.map(item => ({
            ...item,
            description: (item.description || "").replace(/<img[^>]*>/gi, "").replace(/<p[^>]*>/gi, "").replace(/<\/p>/gi, " ").trim()
        }));

        loading.classList.add('hidden');

        if (cleaned.length === 0) {
            empty.classList.remove('hidden');
            const status = getSearchStatus();
            if (!status.isFullSearchActive) prompt.classList.remove('hidden');
        } else {
            renderResults(cleaned, results);
        }

        // Update URL & Title
        const url = new URL(window.location);
        url.searchParams.set('q', query);
        url.searchParams.set('type', type);
        window.history.replaceState({}, '', url);
        if (title) title.textContent = `Search Results for "${query}"`;
    }

    return { handleSearch };
}

export function renderResults(items, container) {
    if (!container) return;

    container.innerHTML = `
        <section class="animate-in fade-in duration-500">
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em]">
                    Neural Mesh Matches (${items.length})
                </h2>
            </div>
            <div id="results-list" class="flex flex-col border-t border-zinc-200 dark:border-zinc-800">
                ${items.map(item => {
        const type = item.type || 'model';
        const slug = item.slug || item.id;
        const path = getRouteFromId(slug, type);
        const fni = Math.round(item.fni_score || item.fni || 0);
        const hasDesc = (item.description && item.description.length > 5);

        return `
                    <a href="${path}" 
                       class="search-result-item flex flex-col gap-1.5 py-3 px-2 border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors group"
                       data-id="${item.id}"
                       data-type="${type}"
                       data-hydrated="${hasDesc && fni > 0 ? 'true' : 'false'}"
                    >
                        <div class="flex items-center justify-between gap-2 w-full">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 rounded uppercase tracking-tighter border border-zinc-200/50 dark:border-zinc-700/50 flex-shrink-0">
                                    ${type}
                                </span>
                                <h3 class="text-xs sm:text-sm font-bold text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 truncate">
                                    ${item.name}
                                </h3>
                            </div>
                            
                            <div class="fni-badge text-emerald-600 dark:text-emerald-400 font-black text-[10px] sm:text-[11px] flex-shrink-0 ${fni > 0 ? '' : 'hidden'}">
                                FNI ${fni}
                            </div>
                        </div>
                        
                        <div class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-zinc-500 dark:text-zinc-400">
                            <span class="text-[10px] sm:text-[11px] font-medium truncate">
                                by ${item.author || 'Open Source'}
                            </span>
                            
                            <div class="flex items-center gap-2 overflow-hidden">
                                <p class="result-desc text-[10px] sm:text-[11px] line-clamp-1 italic sm:not-italic flex-1">
                                    ${item.description || ''}
                                </p>
                                
                                <div class="flex items-center gap-2 flex-shrink-0 text-[10px] font-medium opacity-60">
                                    <span class="flex items-center gap-0.5">⭐ ${item.likes || 0}</span>
                                    <span class="hidden sm:inline">•</span>
                                    <span class="hidden sm:inline">${item.last_updated ? new Date(item.last_updated).toLocaleDateString() : 'Active'}</span>
                                </div>
                            </div>
                        </div>
                    </a>
                `;
    }).join('')}
            </div>
        </section>
    `;

    setupHydrationObserver();
}

export function setupHydrationObserver() {
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                hydrateSearchResult(entry.target);
                observer.unobserve(entry.target);
            }
        });
    }, { rootMargin: '100px' });

    document.querySelectorAll('.search-result-item[data-hydrated="false"]').forEach(item => {
        observer.observe(item);
    });
}

export async function hydrateSearchResult(el) {
    const id = el.getAttribute('data-id');
    const type = el.getAttribute('data-type');
    if (!id || !type) return;

    try {
        const cleanId = id.replace(/[:/]/g, '--').toLowerCase();

        // V19.2: Enforce Gzip checks to avoid 404s in R2 (Search Hydration)
        const paths = [
            `https://cdn.free2aitools.com/cache/fused/${cleanId}.json.gz`,
            `https://cdn.free2aitools.com/cache/fused/${cleanId}.json`
        ];

        let data = null;
        for (const p of paths) {
            const res = await fetch(p);
            if (!res.ok) continue;

            const buffer = await res.arrayBuffer();
            const uint8 = new Uint8Array(buffer);
            const isGzip = uint8[0] === 0x1f && uint8[1] === 0x8b;

            if (isGzip) {
                const ds = new DecompressionStream('gzip');
                const decompressedStream = new Response(buffer).body.pipeThrough(ds);
                data = await new Response(decompressedStream).json();
            } else {
                data = JSON.parse(new TextDecoder().decode(buffer));
            }
            if (data) break;
        }

        if (data) {
            const inner = data.entity || data;
            const descEl = el.querySelector('.result-desc');
            const fniEl = el.querySelector('.fni-badge');

            const rawDesc = inner.description || inner.summary || inner.body_content || '';

            if (descEl && rawDesc && (!descEl.textContent.trim() || descEl.textContent.length < 10)) {
                let cleanDesc = rawDesc.replace(/<[^>]*>?/gm, ''); // Strip HTML
                descEl.textContent = cleanDesc.substring(0, 160) + (cleanDesc.length > 160 ? '...' : '');
                descEl.classList.remove('italic', 'opacity-70');
            }

            const fniScore = inner.fni_score || inner.fni || 0;
            if (fniEl && fniScore > 0) {
                fniEl.textContent = `FNI ${Math.round(fniScore)}`;
                fniEl.classList.remove('hidden');
            }

            el.setAttribute('data-hydrated', 'true');
        }
    } catch (e) {
        console.warn(`[SearchHydro] Failed for ${id}:`, e.message);
    }
}
