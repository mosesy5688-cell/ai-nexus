#!/usr/bin/env node
/**
 * FNI (Free2AI Nexus Index) Calculation Engine
 * 
 * Constitution V3.3 Pillar VII: Fair Index Standard
 * V3.3 Data Expansion: Runtime Ecosystem Integration
 * 
 * FNI V2.0 = 0.35*S + 0.25*A + 0.15*P + 0.15*R + 0.10*Q
 * 
 * @module scripts/calculate-fni
 */

import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

import { CONFIG } from './fni/fni-config.js';
import { calculateFNI } from './fni/fni-calc.js';
import { generateCommentary } from './fni/fni-analysis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenvConfig({ path: path.join(__dirname, '../.dev.vars') });

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
    console.log('⚖️  Weights: S=' + (CONFIG.WEIGHTS.S * 100) + '% A=' + (CONFIG.WEIGHTS.A * 100) + '% P=' + (CONFIG.WEIGHTS.P * 100) + '% R=' + (CONFIG.WEIGHTS.R * 100) + '% Q=' + (CONFIG.WEIGHTS.Q * 100) + '%');
    console.log('');

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
            model.fni_p ?? 0,
            model.fni_a ?? 0,
            model.fni_q ?? 0,
            model.fni_r ?? 0,
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
        console.log(`   ${i + 1}. ${m.name || m.id} - FNI: ${m.fni_score.toFixed(1)} (S:${(m.fni_s ?? 50).toFixed(0)} A:${(m.fni_a ?? 0).toFixed(0)} P:${(m.fni_p ?? 0).toFixed(0)} R:${(m.fni_r ?? 0).toFixed(0)} Q:${(m.fni_q ?? 0).toFixed(0)})`);
    });

    // Save output
    const outputPath = path.join(__dirname, '../data/models_with_fni.json');
    const outputDir = path.dirname(outputPath); // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(final, null, 2));
    console.log('');
    console.log(`✅ Saved to ${outputPath}`);

    // V16.9: D1/KV SQL Generation Removed (Zero-Runtime Pipeline)
    console.log(`✅ FNI data processed for ${final.length} entities.`);

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  FNI Calculation Complete');
    console.log('  Public trust is our currency. Explainability is our moat.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(console.error);
