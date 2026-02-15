// src/scripts/home-client.js
import { createModelCardHTML } from './ui-utils.js';
import { stripPrefix } from '../utils/mesh-routing-core.js';

const CDN_BASE = 'https://cdn.free2aitools.com/cache';

// Function to fetch and render hot models (Constitution: FNI-sorted)
export async function loadHotModels() {
    const loadingSkeleton = document.getElementById('hot-models-loading');
    const gridEl = document.getElementById('hot-models-grid');
    const errorEl = document.getElementById('hot-models-error');
    const errorMsgEl = document.getElementById('hot-models-error-msg');

    // V16.5: If grid is already pre-rendered via SSR, just ensure UI state is correct
    if (gridEl && gridEl.children.length > 0) {
        console.log('[Home] Hot models pre-rendered via SSR. Skipping client fetch.');
        if (loadingSkeleton) loadingSkeleton.classList.add('hidden');
        gridEl.classList.remove('hidden');
        return;
    }

    let response;
    try {
        const path = 'trending.json';
        const gzPath = path + '.gz';
        response = await fetch(`${CDN_BASE}/${gzPath}`);
        if (!response.ok) response = await fetch(`${CDN_BASE}/trend-data.json.gz`);
        if (!response.ok) response = await fetch(`${CDN_BASE}/${path}`);
        if (!response.ok) response = await fetch(`${CDN_BASE}/trend-data.json`);
        if (!response.ok) throw new Error(`CDN Error: ${response.status}`);

        let data;
        const isGzip = response.url.endsWith('.gz');
        const isAlreadyDecompressed = response.headers.get('Content-Encoding') === 'gzip' || response.headers.get('content-encoding') === 'gzip';

        if (isGzip && !isAlreadyDecompressed) {
            const ds = new DecompressionStream('gzip');
            const decompressedStream = response.body.pipeThrough(ds);
            const decompressedRes = new Response(decompressedStream);
            data = await decompressedRes.json();
        } else {
            data = await response.json();
        }

        const models = (data.models || data || []).slice(0, 12);

        if (models.length === 0) {
            if (gridEl) gridEl.innerHTML = '<p class="col-span-full text-center text-gray-500 py-12">No hot models currently indexed in FNI leaderboard.</p>';
            return;
        }

        // Render with UMID-compatible slugs
        const html = models.filter(m => !!m).map(model => createModelCardHTML(model)).join('');

        if (gridEl) {
            gridEl.innerHTML = html;
            gridEl.classList.remove('hidden');
        }

        // Hide skeletons if they exist
        const skeletons = document.querySelectorAll('.skeleton-card');
        skeletons.forEach(s => s.classList.add('hidden'));

        if (loadingSkeleton) {
            loadingSkeleton.classList.add('hidden');
            loadingSkeleton.style.display = 'none'; // Force hide
        }

    } catch (e) {
        console.error("Failed to load hot models:", e);
        const skeletons = document.querySelectorAll('.home-skeleton-container');
        skeletons.forEach(s => s.classList.add('hidden'));

        if (errorEl) {
            errorEl.classList.remove('hidden');
            errorMsgEl.textContent = "Data Connectivity Lag: Please refresh in a moment.";
        }
    }
}

// V16.8.1: Daily Report Banner Loader (Standardized to YYYY-MM-DD + 7-Day Fallback)
export async function loadDailyReport() {
    const banner = document.getElementById('daily-report-banner');
    const titleEl = document.getElementById('report-title');
    const summaryEl = document.getElementById('report-summary');
    const topModelEl = document.getElementById('report-top-model');
    const topModelLink = document.getElementById('report-top-model-link');

    if (!banner) return;

    try {
        const now = new Date();
        let reportData = null;
        let foundDate = null;

        // Try last 7 days (Daily reports are prioritized)
        for (let i = 0; i < 7; i++) {
            const date = new Date(now);
            date.setDate(now.getDate() - i);
            const dateKey = date.toISOString().split('T')[0];
            const path = `reports/daily/${dateKey}.json`;
            const gzPath = path + '.gz';

            try {
                let response = await fetch(`${CDN_BASE}/${gzPath}`);
                if (!response.ok) response = await fetch(`${CDN_BASE}/${path}`);

                if (response.ok) {
                    const isGzip = response.url.endsWith('.gz');
                    const isAlreadyDecompressed = response.headers.get('Content-Encoding') === 'gzip' || response.headers.get('content-encoding') === 'gzip';

                    if (isGzip && !isAlreadyDecompressed) {
                        const ds = new DecompressionStream('gzip');
                        const decompressedStream = response.body.pipeThrough(ds);
                        const decompressedRes = new Response(decompressedStream);
                        reportData = await decompressedRes.json();
                    } else {
                        reportData = await response.json();
                    }
                    foundDate = dateKey;
                    break;
                }
            } catch (e) { continue; }
        }

        if (!reportData) throw new Error('No recent daily report found');

        // Populate banner with Daily nomenclature
        titleEl.textContent = `Daily AI Update: ${foundDate}`;

        // V16.8.1: Support both legacy 'this_week_changed' and new 'daily_brief' structures
        const briefing = reportData.daily_brief || reportData.this_week_changed || {};
        const leader = briefing.fni_leader || (reportData.who_to_watch ? reportData.who_to_watch[0] : null);

        if (leader) {
            const leaderType = leader.type || 'model';
            const leaderPrefix = leaderType === 'agent' ? '/agent/' : leaderType === 'dataset' ? '/dataset/' : leaderType === 'tool' ? '/tool/' : leaderType === 'paper' ? '/paper/' : '/model/';
            const count = briefing.new_entities_count || briefing.new_models_count || 0;

            const slug = (leader.id || leader.slug || '').toLowerCase();

            summaryEl.textContent = count > 0 ? `${count} new entities tracked today!` : 'Review the latest FNI leaderboards.';
            topModelEl.textContent = leader.name;
            topModelLink.href = `${leaderPrefix}${slug}`;
        } else {
            summaryEl.textContent = 'Review the latest FNI leaderboards.';
            topModelEl.textContent = 'Curated AI Insights';
        }

        banner.classList.remove('hidden');
    } catch (e) {
        console.warn('[DailyReport] Daily fetch failed, falling back to legacy/trending:', e.message);

        // Final fallback: Use trending.json
        try {
            let trendingRes = await fetch(`${CDN_BASE}/trending.json.gz`);
            if (!trendingRes.ok) trendingRes = await fetch(`${CDN_BASE}/trending.json`);
            if (!trendingRes.ok) trendingRes = await fetch(`${CDN_BASE}/trend-data.json.gz`);

            if (trendingRes.ok) {
                let trendingData;
                const isGz = trendingRes.url.endsWith('.gz');
                const isAlreadyDec = trendingRes.headers.get('Content-Encoding') === 'gzip' || trendingRes.headers.get('content-encoding') === 'gzip';

                if (isGz && !isAlreadyDec) {
                    const ds = new DecompressionStream('gzip');
                    const decompressedStream = trendingRes.body.pipeThrough(ds);
                    trendingData = await new Response(decompressedStream).json();
                } else {
                    trendingData = await trendingRes.json();
                }
                const topModel = trendingData.models?.[0];

                if (topModel) {
                    titleEl.textContent = `Daily AI Pulse`;
                    summaryEl.textContent = `${trendingData.count || 100} top-rated entities today.`;
                    topModelEl.textContent = topModel.name;

                    const topModelType = topModel.type || 'model';
                    const topModelPrefix = topModelType === 'agent' ? '/agent/' : topModelType === 'dataset' ? '/dataset/' : topModelType === 'tool' ? '/tool/' : topModelType === 'paper' ? '/paper/' : '/model/';
                    // V16.9.23: Preservation Policy
                    const slug = (topModel.id || topModel.slug || '').toLowerCase();
                    topModelLink.href = `${topModelPrefix}${slug}`;

                    banner.classList.remove('hidden');
                }
            }
        } catch (fallbackErr) {
            console.error('[DailyReport] All fallbacks failed.');
        }
    }
}

