/**
 * FNI V16.5: Universal Scoring Algorithm (Production Alignment)
 * Unified Source-Based Scoring for HuggingFace, GitHub, and ArXiv.
 * Formula: (Sp * 0.40) + (Sf * 0.35) + (Sm * 0.25) [Stage 1 Vitality]
 */

/**
 * Main Entry Point for FNI Calculation (Art 3.2)
 */
export function calculateFNI(entity, options = {}) {
    const id = entity.id || entity.slug || '';
    const stats = entity.stats || entity;
    const type = entity.type || entity.entity_type || 'model';

    // --- 1. Popularity (Sp) - Section 2.A ---
    let rawPop = 0;
    let anchor = 7.0;

    if (id.startsWith('hf-')) {
        // HF Anchor: 1M -> log10(1M) = 6.0
        rawPop = (parseInt(stats.likes || stats.like_count) || 0) + ((parseInt(stats.downloads || stats.download_count) || 0) * 0.01);
        anchor = 6.0;
    }
    else if (id.startsWith('gh-')) {
        // GH Anchor: 30k stars -> log10(30k) = 4.47
        rawPop = (parseInt(stats.stars || stats.stargazers_count) || 0) + ((parseInt(stats.forks || stats.forks_count) || 0) * 2);
        anchor = 4.47;
    }
    else if (id.startsWith('arxiv-')) {
        // ArXiv Anchor: 1000 cites -> log10(1000) = 3.0
        rawPop = parseInt(stats.citations || stats.citation_count) || 0;
        anchor = 3.0;
    }
    else {
        // Ecosystems: (l * 20) + d. Base 25.
        const d = parseInt(stats.downloads || stats.downloadCount || stats.pulls || stats.run_count) || 0;
        const l = parseInt(stats.likes || stats.favoriteCount || stats.upVotes || stats.stars || stats.stargazers_count) || 0;
        rawPop = (l * 20) + d;
        anchor = 7.0; // Standard 10M log scale
    }

    let Sp = (Math.log10(rawPop + 1) / anchor) * 100;
    if (!id.startsWith('hf-') && !id.startsWith('gh-') && !id.startsWith('arxiv-')) {
        Sp = Math.max(25, Sp);
    }

    // --- 2. Freshness (Sf) - Section 2.B (Exponential) ---
    const dateStr = entity.last_modified || entity.pushed_at || entity.published_at || entity.updated_at || entity._updated;
    const daysSince = dateStr ? (new Date() - new Date(dateStr)) / 86400000 : 90; // Default 3mo stale if unknown

    let Sf = 100 * Math.exp(-0.01 * Math.max(0, daysSince));

    // Newborn Boost (1.2x if created within 7 days)
    const createdStr = entity.created_at || entity.published_at;
    if (createdStr) {
        const daysSinceCreation = (new Date() - new Date(createdStr)) / 86400000;
        if (daysSinceCreation <= 7) Sf *= 1.2;
    }

    // --- 3. Base Vitality Blend (Stage 1) ---
    // Note: Sm (Mesh Impact) is calculated in Stage 3/4 (Aggregator) due to graph dependency.
    // In Stage 2/4, we use a placeholder or partial blend.
    let vitality = (Sp * 0.40) + (Sf * 0.35);
    // Normalized to 75% for now (Mesh covers 25%)
    // But for Detail pages, we want a comparable 0-100 score.
    const baseScore = vitality / 0.75;

    // --- 4. System Blending - Section 2.D ---
    let Sc = calcCompleteness(entity);
    let Su = calcUtility(entity);
    let finalScore = baseScore;

    if (type === 'model' || type === 'agent') {
        // Blend: 70% Vitality + 15% Comp + 15% Util
        finalScore = (baseScore * 0.70) + (Sc * 0.15) + (Su * 0.15);
    } else if (type === 'tool' || type === 'prompt') {
        finalScore = (baseScore * 0.85) + (Sc * 0.15);
    } else if (type === 'space') {
        // Space Appendix Logic: (Sp + Hardware) * kStatus
        let H = calcHardwareBoost(entity.hardware);
        let kStatus = calcStatusMultiplier(entity.runtime_status);
        finalScore = (Sp + H) * kStatus;
    }

    const roundedScore = Math.min(100, Math.max(0, Math.round(finalScore)));

    if (options.includeMetrics) {
        return {
            score: roundedScore,
            metrics: {
                p: Math.round(Math.min(100, Sp)),
                f: Math.round(Math.min(100, Sf)),
                c: Math.round(Sc),
                u: Math.round(Su)
            }
        };
    }

    return roundedScore;
}

function calcCompleteness(entity) {
    let s = 0;
    if ((entity.body_content || entity.readme_content || '').length > 500) s += 40;
    if (entity.params_billions || entity.params || entity.size) s += 30;
    if (entity.tags?.length > 0) s += 15;
    if (entity.author && entity.author !== 'Community') s += 15;
    return s;
}

function calcUtility(entity) {
    let s = 30; // Base
    if (entity.has_ollama || entity.has_gguf || entity.pipeline_tag) s += 40;
    if (entity.spaces_count > 0 || entity.has_demo || entity.mesh_links?.length > 0) s += 30;
    return Math.min(100, s);
}

function calcHardwareBoost(hw) {
    if (!hw) return 0;
    if (hw.includes('A100') || hw.includes('H100')) return 20;
    if (hw.includes('Zero') || hw.includes('A10G')) return 15;
    if (hw.includes('Upgrade') || hw.includes('T4')) return 5;
    return 0;
}

function calcStatusMultiplier(status) {
    if (!status) return 1.0;
    const s = status.toLowerCase();
    if (s.includes('running')) return 1.0;
    if (s.includes('sleep') || s.includes('pause')) return 0.5;
    if (s.includes('build')) return 0.1;
    if (s.includes('error')) return 0.0;
    return 1.0;
}
