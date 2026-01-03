/**
 * V14.2 Static Search Client
 * Zero-Cost Constitution Compliant
 * 
 * Uses MiniSearch for instant client-side search.
 * Index loaded lazily on first interaction.
 */

import MiniSearch from 'minisearch';

// State
let miniSearch = null;
let isLoaded = false;
let isLoading = false;
let searchData = [];

// Config
const INDEX_URL = '/data/search-index-top.json';
const FALLBACK_URL = 'https://cdn.free2ai.tools/data/search-index-top.json';

/**
 * Initialize search engine - called on first user interaction
 */
export async function initSearch() {
    if (isLoaded || isLoading) return isLoaded;
    isLoading = true;

    console.log('📥 [V14.2] Loading static search index...');

    try {
        // Try primary URL first
        let response = await fetch(INDEX_URL);

        if (!response.ok) {
            console.warn('Primary index not found, trying fallback...');
            response = await fetch(FALLBACK_URL);
        }

        if (!response.ok) {
            throw new Error(`Failed to load search index: ${response.status}`);
        }

        searchData = await response.json();
        console.log(`📊 Loaded ${searchData.length} items`);

        // Initialize MiniSearch
        miniSearch = new MiniSearch({
            fields: ['n', 't'],  // name, tags
            storeFields: ['n', 's', 'sc', 'i', 'a'], // name, slug, score, id, author
            idField: 'i',
            searchOptions: {
                boost: { n: 2 },  // Name has higher weight
                fuzzy: 0.2,       // Typo tolerance
                prefix: true      // Prefix matching
            }
        });

        // Build index
        miniSearch.addAll(searchData);

        isLoaded = true;
        console.log('🚀 [V14.2] Search Engine Ready');

        return true;
    } catch (e) {
        console.error('❌ Search index failed:', e);
        return false;
    } finally {
        isLoading = false;
    }
}

/**
 * Perform search and return results
 */
export function performSearch(query, limit = 10) {
    if (!miniSearch || !query || query.length < 2) {
        return [];
    }

    const startTime = performance.now();
    const results = miniSearch.search(query);
    const duration = (performance.now() - startTime).toFixed(1);

    console.log(`🔍 Search "${query}": ${results.length} results in ${duration}ms`);

    // Map to display format
    return results.slice(0, limit).map(r => ({
        id: r.i,
        name: r.n,
        slug: r.s,
        author: r.a,
        fni_score: r.sc,
        score: r.score // MiniSearch relevance score
    }));
}

/**
 * Get search status
 */
export function getSearchStatus() {
    return {
        isLoaded,
        isLoading,
        itemCount: searchData.length
    };
}

// Auto-export for script tag usage
if (typeof window !== 'undefined') {
    window.StaticSearch = {
        init: initSearch,
        search: performSearch,
        status: getSearchStatus
    };
}
