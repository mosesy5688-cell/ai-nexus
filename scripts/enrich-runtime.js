/**
 * Runtime Data Enricher
 * 
 * Constitution V3.3 Data Expansion
 * 
 * Enriches existing models with Ollama + GGUF data
 * This activates the FNI Utility (U) dimension
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { OllamaAdapter } from './ingestion/adapters/ollama-adapter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Runtime Data Enricher');
    console.log('  V3.3 Data Expansion: "Runtime First" Strategy');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('');

    // Load existing models
    const rawPath = path.join(__dirname, '../data/raw.json');

    if (!fs.existsSync(rawPath)) {
        console.error('❌ No raw.json found. Run L1 Harvester first.');
        process.exit(1);
    }

    const models = JSON.parse(fs.readFileSync(rawPath, 'utf-8'));
    console.log(`📊 Loaded ${models.length} models from raw.json`);
    console.log('');

    // Step 1: Enrich with Ollama data
    console.log('🦙 Step 1: Ollama Enrichment');
    console.log('───────────────────────────────────────');
    const ollama = new OllamaAdapter();
    await ollama.enrichModels(models);

    // Count Ollama matches
    const ollamaCount = models.filter(m => m.has_ollama).length;
    console.log(`✅ Ollama supported: ${ollamaCount}/${models.length}`);
    console.log('');

    // Step 2: Detect GGUF files
    console.log('📦 Step 2: GGUF Detection');
    console.log('───────────────────────────────────────');
    let ggufCount = 0;
    for (const model of models) {
        // Check siblings for GGUF files
        if (model.siblings && Array.isArray(model.siblings)) {
            const ggufFiles = model.siblings.filter(s =>
                s.rfilename?.toLowerCase().endsWith('.gguf') ||
                s.filename?.toLowerCase().endsWith('.gguf')
            );

            if (ggufFiles.length > 0) {
                model.has_gguf = true;
                model.gguf_variants = ggufFiles.map(f => {
                    const name = f.rfilename || f.filename || '';
                    const match = name.match(/(Q[0-9]+_[A-Z0-9_]+|q[0-9]+_[a-z0-9_]+)/i);
                    return match ? match[1].toUpperCase() : 'GGUF';
                }).filter((v, i, a) => a.indexOf(v) === i);
                ggufCount++;
            }
        }

        // Also check model name/id for GGUF indicators
        if (!model.has_gguf) {
            const modelId = (model.id || model.name || '').toLowerCase();
            if (modelId.includes('gguf') || modelId.includes('quantized')) {
                model.has_gguf = true;
                model.gguf_variants = ['GGUF'];
                ggufCount++;
            }
        }
    }
    console.log(`✅ GGUF available: ${ggufCount}/${models.length}`);
    console.log('');

    // Step 3: Show enriched models
    console.log('🎯 Enriched Models (Utility Boost):');
    console.log('───────────────────────────────────────');
    const enriched = models.filter(m => m.has_ollama || m.has_gguf);
    enriched.slice(0, 15).forEach(m => {
        const badges = [];
        if (m.has_ollama) badges.push(`🦙 ${m.ollama_id}`);
        if (m.has_gguf) badges.push(`📦 GGUF(${m.gguf_variants?.length || 1})`);
        console.log(`   ${m.name || m.id}: ${badges.join(' + ')}`);
    });
    if (enriched.length > 15) {
        console.log(`   ... and ${enriched.length - 15} more`);
    }
    console.log('');

    // Save enriched data
    const enrichedPath = path.join(__dirname, '../data/raw_enriched.json');
    fs.writeFileSync(enrichedPath, JSON.stringify(models, null, 2));
    console.log(`✅ Saved enriched data to ${enrichedPath}`);

    // Also update raw.json in place
    fs.writeFileSync(rawPath, JSON.stringify(models, null, 2));
    console.log(`✅ Updated raw.json with runtime data`);

    console.log('');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('  Runtime Enrichment Complete');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch(console.error);
