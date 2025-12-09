#!/usr/bin/env node
/**
 * FNI (Free2AI Nexus Index) Calculation Engine
 * 
 * Constitution V3.3 Pillar VII: Fair Index Standard
 * V3.3 Data Expansion: Runtime Ecosystem Integration
 * 
 * FNI = P(25%) + V(25%) + C(30%) + U(20%)
 * 
 * Where:
 * - P (Popularity): likes, downloads, github_stars
 * - V (Velocity): 7-day growth rate
 * - C (Credibility): arxiv_id, readme quality, author reputation
 * - U (Utility): Ollama support, GGUF availability, local deployability
 * 
 * Key Principles:
 * - Forensic Traceability: All data has source_trail
 * - Radical Neutrality: L5/L6 physically separated
 * - Holistic Perspective: Not just benchmarks, but real-world usability
 * - Explainability: Every score has a commentary
 * 
 * @module scripts/calculate-fni
 */

import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

config({ path: path.join(__dirname, '../.dev.vars') });

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
    // Weight configuration (must sum to 1.0)
    // V3.3 Data Expansion: Added U dimension
    WEIGHTS: {
        P: 0.25,  // Popularity
        V: 0.25,  // Velocity
        C: 0.30,  // Credibility (highest for fairness)
        U: 0.20   // Utility (Runtime Ecosystem)
    },

    // Normalization baselines (based on data distribution)
    NORMALIZATION: {
        MAX_LIKES: 500000,
        MAX_DOWNLOADS: 1000000,
        MAX_GITHUB_STARS: 100000,
        MAX_VELOCITY: 150000
    },

    // Big corps for author reputation
    BIG_CORPS: [
        'meta', 'google', 'microsoft', 'openai', 'anthropic',
        'nvidia', 'alibaba', 'huggingface', 'deepmind', 'stability-ai',
        'mistralai', 'cohere', 'baidu', 'tencent'
    ],

    // Utility score bonuses (V3.3 Data Expansion)
    UTILITY: {
        OLLAMA_BONUS: 30,      // Native Ollama support
        GGUF_BONUS: 25,        // GGUF quantization available
        COMPLETE_README: 15,   // Has comprehensive documentation
        DOCKER_BONUS: 10,      // Docker deployment support
        API_BONUS: 10          // Has inference API
    },

    // Anomaly thresholds
    ANOMALY: {
        GROWTH_MULTIPLIER: 10,  // 10x avg = suspicious
        MIN_DOWNLOAD_RATIO: 1,   // downloads/likes ratio
        MAX_DOWNLOAD_RATIO: 500,
        MIN_CONTENT_FOR_HIGH_LIKES: 500  // bytes
    }
};

// ============================================================
// CORE CALCULATION FUNCTIONS
// ============================================================

/**
 * Calculate P (Popularity) score [0-100]
 */
function calculateP(model) {
    const { MAX_LIKES, MAX_DOWNLOADS, MAX_GITHUB_STARS } = CONFIG.NORMALIZATION;

    const likes = Math.min((model.likes || 0) / MAX_LIKES, 1) * 100;
    const downloads = Math.min((model.downloads || 0) / MAX_DOWNLOADS, 1) * 100;
    const stars = model.github_stars
        ? Math.min(model.github_stars / MAX_GITHUB_STARS, 1) * 100
        : likes;  // Fallback to likes if no stars

    return Math.round((likes * 0.4 + downloads * 0.3 + stars * 0.3) * 10) / 10;
}

/**
 * Calculate V (Velocity) score [0-100]
 */
function calculateV(model) {
    const { MAX_VELOCITY } = CONFIG.NORMALIZATION;

    // Use existing velocity field (7-day growth rate)
    const velocity = model.velocity || model.velocity_score || 0;

    return Math.round(Math.min((velocity / MAX_VELOCITY) * 100, 100) * 10) / 10;
}

/**
 * Calculate C (Credibility) score [0-100]
 */
function calculateC(model) {
    let score = 0;

    // Academic backing (40 points)
    if (model.arxiv_id) score += 20;
    const relations = typeof model.relations === 'string'
        ? JSON.parse(model.relations || '[]')
        : (model.relations || []);
    if (relations.some(r => r.type === 'based_on_paper')) score += 20;

    // Documentation completeness (30 points)
    const readmeLength = model.body_content?.length || 0;
    if (readmeLength > 500) score += 10;
    if (readmeLength > 2000) score += 10;
    if (readmeLength > 10000) score += 10;

    // Author reputation (30 points)
    const author = (model.author || '').toLowerCase();
    if (CONFIG.BIG_CORPS.includes(author)) {
        score += 30;
    } else if (author.includes('ai') || author.includes('lab')) {
        score += 15;  // Partial credit for AI-focused orgs
    }

    return Math.min(100, Math.round(score * 10) / 10);
}

/**
 * Calculate U (Utility) score [0-100]
 * V3.3 Data Expansion: "Runtime First" Strategy
 */
function calculateU(model) {
    let score = 0;
    const { UTILITY } = CONFIG;

    // 1. Ollama support (30 points) - "Can I run this with one command?"
    if (model.has_ollama || model.ollama_id) {
        score += UTILITY.OLLAMA_BONUS;
    }

    // 2. GGUF quantization (25 points) - "Can I run this on consumer hardware?"
    if (model.has_gguf || (model.gguf_variants && model.gguf_variants.length > 0)) {
        score += UTILITY.GGUF_BONUS;
    }

    // 3. Comprehensive documentation (15 points)
    const readmeLength = model.body_content?.length || 0;
    if (readmeLength > 5000) {
        score += UTILITY.COMPLETE_README;
    } else if (readmeLength > 2000) {
        score += UTILITY.COMPLETE_README * 0.5;
    }

    // 4. Docker support (10 points)
    const tags = Array.isArray(model.tags) ? model.tags : [];
    if (tags.some(t => t.toLowerCase().includes('docker'))) {
        score += UTILITY.DOCKER_BONUS;
    }

    // 5. Has Inference API (10 points)
    const meta = typeof model.meta_json === 'string'
        ? JSON.parse(model.meta_json || '{}')
        : (model.meta_json || {});
    if (meta.has_inference_api || meta.inference) {
        score += UTILITY.API_BONUS;
    }

    return Math.min(100, Math.round(score * 10) / 10);
}

/**
 * Detect anomalies for anti-manipulation
 */
function detectAnomalies(model, allModels) {
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
    if (allModels && allModels.length > 0) {
        const avgVelocity = allModels.reduce((sum, m) => sum + (m.velocity || 0), 0) / allModels.length;
        if ((model.velocity || 0) > avgVelocity * CONFIG.ANOMALY.GROWTH_MULTIPLIER && avgVelocity > 0) {
            flags.push('SUSPICIOUS_GROWTH');
        }
    }

    return flags;
}

/**
 * Calculate anomaly multiplier (penalty)
 */
function getAnomalyMultiplier(flags) {
    if (flags.length === 0) return 1.0;

    let multiplier = 1.0;

    if (flags.includes('SUSPICIOUS_GROWTH')) multiplier *= 0.8;
    if (flags.includes('UNUSUAL_RATIO')) multiplier *= 0.9;
    if (flags.includes('CONTENT_MISMATCH')) multiplier *= 0.7;

    return Math.max(0.5, multiplier);  // Floor at 0.5
}

/**
 * Generate auto-commentary explaining the score
 * V3.3: Added Utility dimension commentary
 */
function generateCommentary(model, P, V, C, U, score, percentile, flags) {
    let commentary = `该模型 FNI 得分 ${score.toFixed(1)}（Top ${100 - percentile}%）。`;

    const strengths = [];
    const weaknesses = [];

    // Identify strengths and weaknesses
    if (P >= 80) strengths.push('社区认可度极高');
    else if (P <= 40) weaknesses.push('社区关注度较低');

    if (V >= 80) strengths.push('近期增长迅猛');
    else if (V <= 40) weaknesses.push('增长趋势平缓');

    if (C >= 80) strengths.push('学术可信度高');
    else if (C <= 40) weaknesses.push('缺乏学术背书');

    // V3.3 Utility commentary
    if (U >= 50) {
        if (model.has_ollama) strengths.push('支持 Ollama 一键部署');
        else if (model.has_gguf) strengths.push('提供 GGUF 量化版本');
        else strengths.push('本地部署友好');
    } else if (U <= 20) {
        weaknesses.push('本地部署门槛较高');
    }

    // Build commentary
    if (strengths.length > 0) {
        commentary += `凭借${strengths.join('、')}，`;
    }

    if (weaknesses.length > 0 && strengths.length > 0) {
        commentary += `虽然${weaknesses.join('、')}，`;
    } else if (weaknesses.length > 0) {
        commentary += `由于${weaknesses.join('、')}，`;
    }

    // Scenario recommendation
    if (score >= 85) {
        commentary += '它是企业落地的稳妥之选。';
    } else if (U >= 50 && P <= 50) {
        commentary += '非常适合个人开发者本地部署体验。';
    } else if (V >= 70 && P <= 50) {
        commentary += '它是值得关注的潜力股。';
    } else if (P >= 70 && C <= 50) {
        commentary += '适合快速原型验证，生产部署需谨慎。';
    } else if (C >= 70) {
        commentary += '学术研究参考价值较高。';
    } else {
        commentary += '建议结合具体场景评估。';
    }

    // Anomaly warning
    if (flags.length > 0) {
        commentary += `（注意：检测到数据异常标志）`;
    }

    return commentary;
}

/**
 * Calculate complete FNI for a model
 * V3.3: Added U dimension
 */
function calculateFNI(model, allModels) {
    const P = calculateP(model);
    const V = calculateV(model);
    const C = calculateC(model);
    const U = calculateU(model);  // V3.3 Data Expansion

    const anomalyFlags = detectAnomalies(model, allModels);
    const anomalyMultiplier = getAnomalyMultiplier(anomalyFlags);

    const rawScore = (P * CONFIG.WEIGHTS.P) + (V * CONFIG.WEIGHTS.V) + (C * CONFIG.WEIGHTS.C) + (U * CONFIG.WEIGHTS.U);
    const finalScore = rawScore * anomalyMultiplier;

    return {
        fni_score: Math.round(finalScore * 10) / 10,
        fni_p: P,
        fni_v: V,
        fni_c: C,
        fni_u: U,  // V3.3 Data Expansion
        fni_anomaly_flags: anomalyFlags,
        fni_raw_score: rawScore  // Before penalty
    };
}

/**
 * Calculate percentile rankings
 */
function calculatePercentiles(models) {
    const sorted = [...models].sort((a, b) => b.fni_score - a.fni_score);
    const total = sorted.length;

    return models.map(model => {
        const rank = sorted.findIndex(m => m.id === model.id) + 1;
        const percentile = Math.round((1 - rank / total) * 100);
        return { ...model, fni_percentile: percentile };
    });
}

// ============================================================
// MAIN EXECUTION
// ============================================================

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  FNI (Free2AI Nexus Index) Calculation Engine');
    console.log('  Constitution V3.3 - Pillar VII: Fair Index Standard');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');
    console.log('⚖️  Weights: P=' + (CONFIG.WEIGHTS.P * 100) + '% V=' + (CONFIG.WEIGHTS.V * 100) + '% C=' + (CONFIG.WEIGHTS.C * 100) + '% U=' + (CONFIG.WEIGHTS.U * 100) + '%');
    console.log('');

    // For local testing, read from JSON file
    const fs = await import('fs');
    const modelsPath = path.join(__dirname, '../data/raw.json');

    if (!fs.existsSync(modelsPath)) {
        console.error('❌ No models.json found. Run L1 Harvester first.');
        process.exit(1);
    }

    const models = JSON.parse(fs.readFileSync(modelsPath, 'utf-8'));
    console.log(`📊 Processing ${models.length} models...`);

    // Phase 1: Calculate raw FNI scores
    const processed = models.map(model => ({
        ...model,
        ...calculateFNI(model, models)
    }));

    // Phase 2: Calculate percentiles
    const withPercentiles = calculatePercentiles(processed);

    // Phase 3: Generate commentary
    const final = withPercentiles.map(model => ({
        ...model,
        fni_commentary: generateCommentary(
            model,
            model.fni_p,
            model.fni_v,
            model.fni_c,
            model.fni_u,  // V3.3 Data Expansion
            model.fni_score,
            model.fni_percentile,
            model.fni_anomaly_flags
        ),
        fni_calculated_at: new Date().toISOString()
    }));

    // Output statistics
    console.log('');
    console.log('📈 FNI Distribution:');
    const tiers = {
        elite: final.filter(m => m.fni_percentile >= 95).length,
        top10: final.filter(m => m.fni_percentile >= 90 && m.fni_percentile < 95).length,
        top25: final.filter(m => m.fni_percentile >= 75 && m.fni_percentile < 90).length,
        mid: final.filter(m => m.fni_percentile >= 50 && m.fni_percentile < 75).length,
        lower: final.filter(m => m.fni_percentile < 50).length
    };
    console.log(`   ⭐ Elite (95%+): ${tiers.elite}`);
    console.log(`   🥇 Top 10%: ${tiers.top10}`);
    console.log(`   🥈 Top 25%: ${tiers.top25}`);
    console.log(`   📊 Mid 50%: ${tiers.mid}`);
    console.log(`   📉 Lower 50%: ${tiers.lower}`);

    // Show anomalies detected
    const anomalies = final.filter(m => m.fni_anomaly_flags.length > 0);
    if (anomalies.length > 0) {
        console.log('');
        console.log(`⚠️  Anomalies detected: ${anomalies.length} models`);
    }

    // Show top 10
    console.log('');
    console.log('🏆 FNI Top 10:');
    const top10 = final.sort((a, b) => b.fni_score - a.fni_score).slice(0, 10);
    top10.forEach((m, i) => {
        console.log(`   ${i + 1}. ${m.name || m.id} - FNI: ${m.fni_score.toFixed(1)} (P:${m.fni_p.toFixed(0)} V:${m.fni_v.toFixed(0)} C:${m.fni_c.toFixed(0)} U:${m.fni_u.toFixed(0)})`);
    });

    // Save output
    const outputPath = path.join(__dirname, '../data/models_with_fni.json');
    fs.writeFileSync(outputPath, JSON.stringify(final, null, 2));
    console.log('');
    console.log(`✅ Saved to ${outputPath}`);

    // Generate SQL update statements for D1
    const sqlPath = path.join(__dirname, '../data/fni_updates.sql');
    const sqlStatements = final.map(m => {
        const flags = JSON.stringify(m.fni_anomaly_flags).replace(/'/g, "''");
        const commentary = (m.fni_commentary || '').replace(/'/g, "''");
        return `UPDATE models SET fni_score=${m.fni_score}, fni_p=${m.fni_p}, fni_v=${m.fni_v}, fni_c=${m.fni_c}, fni_percentile=${m.fni_percentile}, fni_commentary='${commentary}', fni_anomaly_flags='${flags}', fni_calculated_at='${m.fni_calculated_at}' WHERE id='${m.id}';`;
    }).join('\n');
    fs.writeFileSync(sqlPath, sqlStatements);
    console.log(`✅ SQL updates saved to ${sqlPath}`);

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  FNI Calculation Complete');
    console.log('  公信力 = 可解释性 | Public trust is our currency.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(console.error);
