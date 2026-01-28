/**
 * FNI Analysis Utilities
 * Anomaly detection and commentary generation
 */
import { CONFIG } from './fni-config.js';

/**
 * Detect anomalies for anti-manipulation
 */
export function detectAnomalies(model, allModels) {
    const flags = [];

    // 1. Unusual download/likes ratio
    const ratio = (model.downloads || 0) / ((model.likes || 1));
    if (ratio < CONFIG.ANOMALY.MIN_DOWNLOAD_RATIO || ratio > CONFIG.ANOMALY.MAX_DOWNLOAD_RATIO) {
        flags.push('UNUSUAL_RATIO');
    }

    // 2. High popularity but no content
    if ((model.likes || 0) > 10000 && (!model.body_content || model.body_content.length < CONFIG.ANOMALY.MIN_CONTENT_FOR_HIGH_LIKES)) {
        flags.push('CONTENT_MISMATCH');
    }

    // 3. Suspicious growth (compared to avg)
    if (allModels) {
        const avgVelocity = Array.isArray(allModels)
            ? (allModels.reduce((sum, m) => sum + (m.velocity || 0), 0) / (allModels.length || 1))
            : (typeof allModels === 'number' ? allModels : 0);

        if ((model.velocity || 0) > avgVelocity * CONFIG.ANOMALY.GROWTH_MULTIPLIER && avgVelocity > 0) {
            flags.push('SUSPICIOUS_GROWTH');
        }
    }

    return flags;
}

/**
 * Calculate anomaly multiplier (penalty)
 */
export function getAnomalyMultiplier(flags) {
    if (flags.length === 0) return 1.0;

    let multiplier = 1.0;

    if (flags.includes('SUSPICIOUS_GROWTH')) multiplier *= 0.8;
    if (flags.includes('UNUSUAL_RATIO')) multiplier *= 0.9;
    if (flags.includes('CONTENT_MISMATCH')) multiplier *= 0.7;

    return Math.max(0.5, multiplier);  // Floor at 0.5
}

/**
 * Generate auto-commentary explaining the score
 * V4.1: English version per Constitution mandate
 */
export function generateCommentary(model, P, V, C, U, score, percentile, flags) {
    let commentary = `This model scores ${score.toFixed(1)} (Top ${100 - percentile}%).`;

    const strengths = [];
    const weaknesses = [];

    // Identify strengths and weaknesses
    if (P >= 80) strengths.push('extremely high community recognition');
    else if (P <= 40) weaknesses.push('low community attention');

    if (V >= 80) strengths.push('rapid recent growth');
    else if (V <= 40) weaknesses.push('slow growth trend');

    if (C >= 80) strengths.push('high academic credibility');
    else if (C <= 40) weaknesses.push('lacks academic endorsement');

    // V3.3 Utility commentary
    if (U >= 50) {
        if (model.has_ollama) strengths.push('supports Ollama one-click deployment');
        else if (model.has_gguf) strengths.push('provides GGUF quantization');
        else strengths.push('local deployment friendly');
    } else if (U <= 20) {
        weaknesses.push('higher local deployment barrier');
    }

    // Build commentary
    if (strengths.length > 0) {
        commentary += ` With ${strengths.join(', ')},`;
    }

    if (weaknesses.length > 0 && strengths.length > 0) {
        commentary += ` although ${weaknesses.join(', ')},`;
    } else if (weaknesses.length > 0) {
        commentary += ` Due to ${weaknesses.join(', ')},`;
    }

    // Scenario recommendation
    if (score >= 85) {
        commentary += ' it is a reliable choice for enterprise deployment.';
    } else if (U >= 50 && P <= 50) {
        commentary += ' ideal for individual developers to deploy locally.';
    } else if (V >= 70 && P <= 50) {
        commentary += ' it is a rising star worth watching.';
    } else if (P >= 70 && C <= 50) {
        commentary += ' suitable for rapid prototyping, production use requires caution.';
    } else if (C >= 70) {
        commentary += ' has high academic research reference value.';
    } else {
        commentary += ' recommend evaluating based on specific use case.';
    }

    // Anomaly warning
    if (flags.length > 0) {
        commentary += ` (Note: data anomaly flags detected)`;
    }

    return commentary;
}
