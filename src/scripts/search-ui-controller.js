// src/scripts/search-ui-controller.js
// V55.9: UI Controller for Search Results & Lazy Hydration
// Handles DOM orchestration, result rendering, and IntersectionObserver-based hydration.

import { initSearch, performSearch, getSearchStatus } from './home-search.js';
import { getRouteFromId } from '../utils/mesh-routing-core.js';
import { escapeHtml } from '../utils/escape-html.js';

/** @type {IntersectionObserver|null} Module-level ref to prevent observer accumulation across renderResults calls */
let _hydrationObserver = null;

// V27.65 scroll-burst debounce + isDraining-guarded drain: prevent N+1 hydration
// requests saturating browser per-host conn pool when user fast-scrolls (which
// triggers head-of-line blocking on main search box). 80ms coalesce window +
// 6-concurrency cap. isDraining flag isolates queue self-pacing from
// outer-trigger clearTimeout (starvation guard).
const _hydrationQueue = new Set();
let _hydrationTimer = null;
let _isDraining = false;

function queueEntityHydration(el) {
    _hydrationQueue.add(el);
    if (_isDraining) return; // drain self-paces; outer trigger must not clobber
    if (_hydrationTimer) clearTimeout(_hydrationTimer);
    _hydrationTimer = setTimeout(drainHydrationQueue, 80);
}

async function drainHydrationQueue() {
    if (_hydrationQueue.size === 0) { _isDraining = false; return; }
    _isDraining = true;
    const batch = Array.from(_hydrationQueue).slice(0, 6);
    batch.forEach(el => _hydrationQueue.delete(el));
    try { await Promise.all(batch.map(el => hydrateSearchResult(el))); }
    catch (e) { console.error('[search-ui-controller:drainBatch]', e?.message); }
    _hydrationTimer = setTimeout(drainHydrationQueue, 40);
}

export function setupSearchUI(dom) {
    if (!dom) return;

    const { form, box, title, results, loading, empty } = dom;
    let debounceTimer = null;

    async function handleSearch() {
        clearTimeout(debounceTimer);
        return new Promise(resolve => {
            debounceTimer = setTimeout(() => resolve(executeSearch()), 250);
        });
    }

    async function executeSearch() {
        const query = box.value.trim();
        const type = form.querySelector('input[name="type"]:checked')?.value || 'all';

        if (query.length < 2) return;

        loading.classList.remove('hidden');
        results.innerHTML = '';
        empty.classList.add('hidden');

        try {
            await initSearch();
            const searchResults = await performSearch(query, { sort: 'fni', entityType: type }, 40);

            const cleaned = (searchResults || []).map(item => ({
                ...item,
                description: (item.description || "").replace(/<img[^>]*>/gi, "").replace(/<p[^>]*>/gi, "").replace(/<\/p>/gi, " ").trim()
            }));

            loading.classList.add('hidden');

            if (cleaned.length === 0) {
                empty.classList.remove('hidden');
            } else {
                renderResults(cleaned, results, query);
            }
        } catch (err) {
            console.error('[Search] handleSearch failed:', err);
            loading.classList.add('hidden');
            empty.classList.remove('hidden');
        }

        // Update URL & Title
        const url = new URL(window.location);
        url.searchParams.set('q', query);
        url.searchParams.set('type', type);
        window.history.replaceState({}, '', url);
        if (title) title.textContent = `Search Results for "${query}"`;
    }

    return { handleSearch, executeSearch };
}

export function highlightTerms(text, query) {
    if (!query) return escapeHtml(text);
    const safe = escapeHtml(text);
    const terms = query.split(/\s+/).filter(t => t.length > 2);
    let highlighted = safe;
    terms.forEach(t => {
        const escapedTerm = escapeHtml(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`(${escapedTerm})`, 'gi');
        highlighted = highlighted.replace(regex, '<mark class="bg-yellow-200 dark:bg-yellow-800/40 text-current rounded-sm px-0.5">$1</mark>');
    });
    return highlighted;
}

export function renderResults(items, container, query = '') {
    if (!container) return;

    container.innerHTML = `
        <section class="animate-in fade-in duration-500">
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-[10px] font-black text-gray-400 dark:text-gray-500 uppercase tracking-[0.2em]">
                    Search Results (${items.length})
                </h2>
            </div>
            <div id="results-list" class="flex flex-col border-t border-zinc-200 dark:border-zinc-800">
                ${items.map(item => {
        const type = item.type || 'model';
        const slug = item.slug || item.id || '';
        const path = getRouteFromId(slug, type);
        const fni = Math.round(item.fni_score || item.fni || 0);
        const hasDesc = (item.description && item.description.length > 5);

        return `
                    <a href="${path}"
                       class="search-result-item flex flex-col gap-1.5 py-3 px-2 border-b border-zinc-100 dark:border-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800/50 transition-colors group"
                       data-id="${escapeHtml(item.id)}"
                       data-type="${escapeHtml(type)}"
                       data-hydrated="${hasDesc && fni > 0 ? 'true' : 'false'}"
                    >
                        <div class="flex items-center justify-between gap-2 w-full">
                            <div class="flex items-center gap-2 min-w-0">
                                <span class="text-[8px] sm:text-[9px] font-bold px-1.5 py-0.5 bg-zinc-100 dark:bg-zinc-800 text-zinc-500 rounded uppercase tracking-tighter border border-zinc-200/50 dark:border-zinc-700/50 flex-shrink-0">
                                    ${escapeHtml(type)}
                                </span>
                                <h3 class="text-xs sm:text-sm font-bold text-zinc-900 dark:text-zinc-100 group-hover:text-blue-600 truncate">
                                    ${highlightTerms(item.name, query)}
                                </h3>
                            </div>

                            <div class="fni-badge text-emerald-600 dark:text-emerald-400 font-black text-[10px] sm:text-[11px] flex-shrink-0 ${fni > 0 ? '' : 'hidden'}">
                                FNI ${fni}
                            </div>
                        </div>

                        <div class="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 text-zinc-500 dark:text-zinc-400">
                            <span class="text-[10px] sm:text-[11px] font-medium truncate">
                                by ${escapeHtml(item.author || 'Open Source')}
                            </span>

                            <div class="flex items-center gap-2 overflow-hidden">
                                <p class="result-desc text-[10px] sm:text-[11px] line-clamp-1 italic sm:not-italic flex-1">
                                    ${highlightTerms(item.description || '', query)}
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
    // Disconnect previous observer to prevent accumulation on repeated renderResults calls / view transitions
    if (_hydrationObserver) {
        _hydrationObserver.disconnect();
        _hydrationObserver = null;
    }

    _hydrationObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                queueEntityHydration(entry.target);
                _hydrationObserver.unobserve(entry.target);
            }
        });
    }, { rootMargin: '100px' });

    document.querySelectorAll('.search-result-item[data-hydrated="false"]').forEach(item => {
        _hydrationObserver.observe(item);
    });
}

export async function hydrateSearchResult(el) {
    const id = el.getAttribute('data-id');
    if (!id) return;
    try {
        // V27.65: cache/fused/<id>.json.zst retired -> /api/v1/entity (data/* VFS).
        // Existing entity endpoint already provides description + fni_score in
        // the projected shape; no ?include=body needed for hydration purposes.
        const res = await fetch(`/api/v1/entity/${encodeURIComponent(id)}`, { headers: { Accept: 'application/json' } });
        // V27.76: explicit 429 marker so per-card degradation distinguishes rate-limit
        // from generic 5xx (no redirect to any upgrade page — L0 is forever-free open).
        if (res.status === 429) throw new Error('HTTP_429_RATE_LIMITED');
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
        const data = await res.json();
        const inner = data.entity || data;
        const descEl = el.querySelector('.result-desc');
        const fniEl = el.querySelector('.fni-badge');
        const rawDesc = inner.description || inner.summary || inner.body_content || '';
        if (descEl && rawDesc && (!descEl.textContent.trim() || descEl.textContent.length < 10)) {
            const cleanDesc = rawDesc.replace(/<[^>]*>?/gm, '');
            descEl.textContent = cleanDesc.substring(0, 160) + (cleanDesc.length > 160 ? '...' : '');
            descEl.classList.remove('italic', 'opacity-70');
        }
        const fniScore = inner.fni?.score ?? inner.fni_score ?? inner.fni ?? 0;
        if (fniEl && fniScore > 0) {
            fniEl.textContent = `FNI ${Math.round(fniScore)}`;
            fniEl.classList.remove('hidden');
        }
        el.setAttribute('data-hydrated', 'true');
    } catch (e) {
        console.error(`[search-ui-controller:hydrateSearchResult] ${id} failed:`, e?.message);
        const isRateLimit = e?.message === 'HTTP_429_RATE_LIMITED';
        const descEl = el.querySelector('.result-desc');
        if (descEl && (!descEl.textContent.trim() || descEl.textContent.length < 10)) {
            descEl.textContent = isRateLimit ? '[rate limited — slow down agent loop]' : '[preview unavailable]';
            descEl.classList.add('opacity-50');
        }
        el.setAttribute('data-hydrated', isRateLimit ? 'rate-limited' : 'failed');
        el.classList.add(isRateLimit ? 'is-rate-limited' : 'is-failed');
    }
}
