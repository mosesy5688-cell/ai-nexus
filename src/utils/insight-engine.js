/**
 * V16.5 Entity Insight Engine
 * Generates technical metrics and badges for the detail page (Zone 2)
 * Separated from inference.js for CES Art 5.1 compliance (< 250 lines)
 */

/**
 * Format large numbers for technical display (e.g. 1.2M, 45K)
 */
export function formatMetricNumber(n) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    const num = Number(n);
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num;
}

/**
 * Get Quick Insight metrics for Zone 2
 * Adapts based on entity type (model, agent, dataset, paper, space, tool)
 */
export function getQuickInsights(entity, type) {
    const insights = [];
    if (!entity) return insights;

    const safeType = type || entity?.type || 'model';

    if (safeType === 'model') {
        const isTrending = (entity.downloads > 50000) || (entity.fni_percentile > 95);

        // FNI Decision Score (Promoted to Position 1)
        if (entity.fni_score > 0) {
            insights.push({
                label: 'FNI Score',
                value: entity.fni_score,
                highlight: entity.fni_score > 85,
                badge: entity.fni_score > 90 ? 'Elite' : (entity.fni_score > 70 ? 'Trusted' : 'Audited')
            });
        }

        insights.push({
            label: 'Params',
            value: entity.params_billions ? `${entity.params_billions}B` : '-',
            highlight: entity.params_billions > 70,
            badge: entity.params_billions < 3 ? 'Tiny' : (entity.params_billions > 100 ? 'Massive' : null)
        });
        insights.push({
            label: 'Context',
            value: entity.context_length ? `${Math.round(entity.context_length / 1024)}k` : '-',
            highlight: entity.context_length > 32768,
            badge: entity.context_length >= 128000 ? 'Long' : null
        });
        insights.push({
            label: 'Downloads',
            value: formatMetricNumber(entity.downloads),
            badge: isTrending ? 'Hot' : null
        });

        // V15.15: Unified VRAM Metric
        if (entity.vram_gb) {
            insights.push({
                label: 'Est. VRAM',
                value: `~${Math.ceil(entity.vram_gb)}GB`,
                highlight: true,
                badge: entity.vram_gb <= 8 ? '8G GPU' : (entity.vram_gb <= 24 ? '24G GPU' : 'H100+')
            });
        }

        if (entity.has_gguf) insights.push({ label: 'Format', value: 'GGUF ✓', highlight: true, badge: 'Local' });

        if (entity.license) {
            const licenseStr = String(entity.license).toLowerCase();
            const isPermissive = licenseStr.includes('apache') || licenseStr.includes('mit');
            insights.push({
                label: 'License',
                value: licenseStr.split('-')[0].toUpperCase(),
                highlight: isPermissive,
                badge: isPermissive ? 'Commercial' : 'Restricted'
            });
        }
    }

    else if (safeType === 'agent') {
        if (entity.fni_score > 0) {
            insights.push({ label: 'FNI Score', value: entity.fni_score, highlight: true, badge: 'Logic Audit' });
        }
        insights.push({ label: 'Tools', value: entity.tools_count || '-', badge: entity.tools_count > 5 ? 'Power' : null });
        insights.push({ label: 'Language', value: entity.language || 'Python', highlight: true });
        insights.push({ label: 'Stars', value: formatMetricNumber(entity.stars || entity.github_stars), badge: (entity.stars > 1000) ? 'Popular' : null });
        insights.push({ label: 'Capability', value: entity.verified ? 'Verified' : 'Community', highlight: entity.verified });
        if (entity.license) insights.push({ label: 'License', value: entity.license });
    }

    else if (safeType === 'dataset') {
        if (entity.fni_score > 0) {
            insights.push({ label: 'FNI Score', value: entity.fni_score, highlight: true, badge: 'Data Integrity' });
        }
        insights.push({ label: 'Size', value: entity.size_gb ? `${entity.size_gb} GB` : '-', badge: entity.size_gb > 100 ? 'Large' : null });
        insights.push({ label: 'Rows', value: formatMetricNumber(entity.rows) });
        insights.push({ label: 'Format', value: entity.format || 'Parquet', highlight: true });
        insights.push({ label: 'Tokens', value: entity.token_count ? formatMetricNumber(entity.token_count) : '-', badge: entity.token_count > 1e12 ? '1T+' : null });
    }

    else if (safeType === 'paper') {
        insights.push({ label: 'Citations', value: formatMetricNumber(entity.citations || entity.citation_count), highlight: true, badge: 'High Impact' });
        insights.push({ label: 'Year', value: entity.published_date ? new Date(entity.published_date).getFullYear() : (entity.year || '2024') });
        insights.push({ label: 'Venue', value: entity.venue || 'ArXiv', badge: entity.venue ? 'Peer-Reviewed' : null });

        const percentile = entity.fni_percentile || 0;
        insights.push({ label: 'FNI Rank', value: percentile > 0 ? `Top ${100 - percentile}%` : '-', highlight: true });
    }

    else if (safeType === 'space') {
        insights.push({ label: 'SDK', value: entity.sdk || 'Gradio', highlight: true });
        insights.push({ label: 'Hardware', value: entity.hardware || 'CPU', badge: entity.hardware?.includes('gpu') ? 'GPU Accel' : null });
        insights.push({ label: 'Status', value: entity.runtime?.stage || 'Running', highlight: true });
        insights.push({ label: 'Activity', value: formatMetricNumber(entity.likes), badge: entity.likes > 100 ? 'Active' : null });
    }

    else if (safeType === 'tool') {
        insights.push({ label: 'Lang', value: entity.language || '-', highlight: true });
        insights.push({ label: 'Stars', value: formatMetricNumber(entity.stars || entity.github_stars), badge: 'Open Source' });
        insights.push({ label: 'Version', value: entity.version || 'v1.0.0' });
        insights.push({ label: 'Reliability', value: entity.fni_score > 80 ? 'Stable' : 'Alpha', highlight: true });
    }

    return insights;
}
