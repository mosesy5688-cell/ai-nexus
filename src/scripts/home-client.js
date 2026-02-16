// src/scripts/home-client.js
import { createModelCardHTML } from './ui-utils.js';
import { loadCachedJSON } from '../utils/loadCachedJSON.js';

// Function to fetch and render hot models (Constitution: FNI-sorted)
export async function loadHotModels() {
    const loadingSkeleton = document.getElementById('hot-models-loading');
    const gridEl = document.getElementById('hot-models-grid');

    // V16.5: If grid is already pre-rendered via SSR, just ensure UI state is correct
    if (gridEl && gridEl.children.length > 0) {
        console.log('[Home] Hot models pre-rendered via SSR. Skipping client fetch.');
        if (loadingSkeleton) loadingSkeleton.classList.add('hidden');
        gridEl.classList.remove('hidden');
        return;
    }

    try {
        // V18.12.5.3: Use trend-data instead of legacy trending.json (404)
        const loadPromise = loadCachedJSON('cache/trend-data.json.gz');
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000));

        const { data } = await Promise.race([loadPromise, timeoutPromise]);

        const models = (data?.models || data || []).slice(0, 12);

        if (!models || models.length === 0) {
            if (gridEl) gridEl.innerHTML = '<p class="col-span-full text-center text-gray-500 py-12">No hot models currently indexed in FNI leaderboard.</p>';
            return;
        }

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
            loadingSkeleton.style.display = 'none';
        }

    } catch (e) {
        console.error("Failed to load hot models:", e);
        const errorEl = document.getElementById('hot-models-error');
        const errorMsgEl = document.getElementById('hot-models-error-msg');
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

        // V18.12.0: Use loadCachedJSON for the latest report
        for (let i = 0; i < 3; i++) { // Restricted to 3 days for TTI performance
            const date = new Date(now);
            date.setDate(now.getDate() - i);
            const dateKey = date.toISOString().split('T')[0];
            const { data } = await loadCachedJSON(`cache/reports/daily/${dateKey}.json`);

            if (data) {
                reportData = data;
                foundDate = dateKey;
                break;
            }
        }

        if (!reportData) {
            // Final fallback: Use trending
            const { data: trendingData } = await loadCachedJSON('cache/trending.json');
            if (trendingData) {
                reportData = trendingData;
                foundDate = 'Latest Trends';
            }
        }

        if (!reportData) throw new Error('No report data available');

        // Populate banner
        titleEl.textContent = foundDate.includes('Trends') ? `Daily AI Pulse` : `Daily AI Update: ${foundDate}`;

        const briefing = reportData.daily_brief || reportData.this_week_changed || {};
        const leader = briefing.fni_leader || (reportData.models ? reportData.models[0] : (reportData.who_to_watch ? reportData.who_to_watch[0] : null));

        if (leader) {
            const leaderType = leader.type || 'model';
            const leaderPrefix = leaderType === 'agent' ? '/agent/' : leaderType === 'dataset' ? '/dataset/' : leaderType === 'tool' ? '/tool/' : leaderType === 'paper' ? '/paper/' : '/model/';
            const count = briefing.new_entities_count || briefing.new_models_count || 0;
            const slug = (leader.id || leader.slug || '').toLowerCase();

            summaryEl.textContent = count > 0 ? `${count} new entities tracked today!` : 'Review the latest FNI leaderboards.';
            topModelEl.textContent = leader.name || leader.n || 'Top Pick';
            topModelLink.href = `${leaderPrefix}${slug}`;
        }

        banner.classList.remove('hidden');
    } catch (e) {
        console.warn('[DailyReport] Optimization: Failed to load report:', e.message);
    }
}

