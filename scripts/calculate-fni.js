#!/usr/bin/env node
/**
 * FNI (Free2AI Nexus Index) Calculation Engine
 * 
 * Constitution V3.3 Pillar VII: Fair Index Standard
 * V3.3 Data Expansion: Runtime Ecosystem Integration
 * 
 * FNI = P(25%) + V(25%) + C(30%) + U(20%)
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
    console.log('⚖️  Weights: P=' + (CONFIG.WEIGHTS.P * 100) + '% V=' + (CONFIG.WEIGHTS.V * 100) + '% C=' + (CONFIG.WEIGHTS.C * 100) + '% U=' + (CONFIG.WEIGHTS.U * 100) + '%');
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
    const outputDir = path.dirname(outputPath); // Ensure directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
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
    console.log('  Public trust is our currency. Explainability is our moat.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(console.error);
