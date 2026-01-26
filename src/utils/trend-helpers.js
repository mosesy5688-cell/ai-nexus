/**
 * Trend Helpers - V16.45
 * Extracted from MiniTrendChart to comply with CES 250-line limit.
 */

export const normalizeTrendId = (s) => (s || '').toLowerCase().trim().replace(/[:\/]+/g, '--').replace(/--+$/g, '');

export function findTrendMatch(id, data, dataKeys, dataKeysLower) {
    const nid = normalizeTrendId(id);
    const bareId = nid.replace(/^(hf-model|hf-dataset|hf-space|hf-tool|model|agent|dataset|paper|space|tool)--/, '');

    let targetId = id;

    // Pass 1: Exact Match
    if (!data[targetId]) {
        // Pass 2: Normalized Match
        const idx = dataKeysLower.indexOf(nid);
        if (idx !== -1) {
            targetId = dataKeys[idx];
        } else {
            // Pass 3: Substring Match & Prefix stripping
            const includesIdx = dataKeysLower.findIndex(k =>
                k === nid ||
                k.includes(bareId) ||
                bareId.includes(k.replace(/^(hf-model|model|dataset|agent|paper|space|tool)--/, ''))
            );

            if (includesIdx !== -1) {
                targetId = dataKeys[includesIdx];
            } else {
                // Pass 4: Last Resort - Bare name suffix match
                const bareName = nid.split('--').pop();
                if (bareName && bareName.length > 3) {
                    const bareIdx = dataKeysLower.findIndex(k => k.endsWith(`--${bareName}`) || k === bareName);
                    if (bareIdx !== -1) targetId = dataKeys[bareIdx];
                    else targetId = null;
                } else {
                    targetId = null;
                }
            }
        }
    }
    return targetId;
}

export function drawSparkline(canvas, scores, direction) {
    const ctx = canvas.getContext('2d');
    if (!ctx || scores.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const parent = canvas.parentElement;
    if (!parent) return;

    const rect = parent.getBoundingClientRect();
    const w = (rect.width || 80) * dpr;
    const h = (rect.height || 28) * dpr;

    canvas.width = w;
    canvas.height = h;

    const pad = 4 * dpr;
    const max = Math.max(...scores), min = Math.min(...scores);
    const range = max - min || 1;

    ctx.clearRect(0, 0, w, h);
    ctx.beginPath();
    ctx.strokeStyle = direction === 'up' ? '#22c55e' :
        direction === 'down' ? '#ef4444' : '#94a3b8';
    ctx.lineWidth = 2 * dpr;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    scores.forEach((s, i) => {
        const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
        const y = h - pad - ((s - min) / range) * (h - pad * 2);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
    canvas.classList.add('loaded');
}

export function updateBadge(el, change, dir) {
    const arrow = dir === 'up' ? '↗' : dir === 'down' ? '↘' : '→';
    el.textContent = `${arrow} ${Math.abs(change).toFixed(1)}%`;
    el.className = `mini-trend-badge ${dir}`;
}
