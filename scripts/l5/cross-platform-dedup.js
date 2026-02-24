/**
 * L5 Cross-Platform Deduplication - V12 Phase 6
 * 
 * Constitution Compliant:
 * - Runs in L5 Sidecar (GitHub Actions)
 * - Identifies duplicate models across HuggingFace, Ollama, GitHub
 * - Creates canonical_id mappings for unified entity access
 * 
 * Deduplication Strategy:
 * 1. Name-based matching (case-insensitive)
 * 2. Author + name combination
 * 3. Base model relationships
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const OUTPUT_DIR = path.join(__dirname, '../../public/api/cache');
const MODELS_CACHE = path.join(__dirname, '../../public/api/cache/models.json');

/**
 * Normalize model name for comparison
 */
function normalizeName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/[\-_\.]/g, '')
        .replace(/gguf$/i, '')
        .replace(/ggml$/i, '')
        .replace(/\d+b$/i, '')
        .replace(/\d+m$/i, '')
        .replace(/fp16$/i, '')
        .replace(/int[48]$/i, '')
        .replace(/q[48]_[01k]$/i, '')
        .trim();
}

/**
 * Calculate similarity score between two models
 * V22.4: Hardware-aware precision matching
 */
function calculateSimilarity(model1, model2) {
    const name1 = normalizeName(model1.name);
    const name2 = normalizeName(model2.name);

    // 1. Precise hardware match (parameters + architecture)
    const p1 = model1.meta_json?.params_billions || model1.params_billions;
    const p2 = model2.meta_json?.params_billions || model2.params_billions;
    const a1 = (model1.meta_json?.architecture || model1.architecture || '').toLowerCase();
    const a2 = (model2.meta_json?.architecture || model2.architecture || '').toLowerCase();

    // If both have architecture/params and they mismatch, they are NOT the same (e.g., Llama-7B vs Llama-70B)
    if (a1 && a2 && a1 !== a2) return 0;
    if (p1 && p2 && Math.abs(p1 - p2) > 0.1) return 0;

    // 2. Exact name match
    if (name1 === name2) return 1.0;

    // 3. High-confidence containment
    if (name1.includes(name2) || name2.includes(name1)) {
        // If they share the same author and have similar names, high confidence
        if (model1.author && model1.author === model2.author) return 0.95;
        return 0.8;
    }

    // 4. Author-based matching
    const author1 = (model1.author || '').toLowerCase();
    const author2 = (model2.author || '').toLowerCase();

    if (author1 === author2 && author1 !== '') {
        const baseName1 = name1.split('/').pop() || name1;
        const baseName2 = name2.split('/').pop() || name2;

        if (baseName1.includes(baseName2) || baseName2.includes(baseName1)) {
            return 0.85;
        }
    }

    return 0;
}

/**
 * Find duplicate groups
 */
function findDuplicateGroups(models) {
    const groups = [];
    const processed = new Set();

    for (let i = 0; i < models.length; i++) {
        if (processed.has(models[i].umid)) continue;

        const group = [models[i]];
        processed.add(models[i].umid);

        for (let j = i + 1; j < models.length; j++) {
            if (processed.has(models[j].umid)) continue;

            const similarity = calculateSimilarity(models[i], models[j]);
            if (similarity >= 0.7) {
                group.push(models[j]);
                processed.add(models[j].umid);
            }
        }

        if (group.length > 1) {
            groups.push(group);
        }
    }

    return groups;
}

/**
 * Select canonical model from a group
 * Priority: Most downloads > Oldest > First in list
 */
function selectCanonical(group) {
    return group.sort((a, b) => {
        // Prefer most downloads
        const dlDiff = (b.downloads || 0) - (a.downloads || 0);
        if (dlDiff !== 0) return dlDiff;

        // Prefer HuggingFace source
        if (a.source?.includes('huggingface') && !b.source?.includes('huggingface')) return -1;
        if (b.source?.includes('huggingface') && !a.source?.includes('huggingface')) return 1;

        // Prefer older (established)
        const dateA = new Date(a.created_at || 0);
        const dateB = new Date(b.created_at || 0);
        return dateA - dateB;
    })[0];
}

/**
 * Main deduplication function
 */
async function runDeduplication() {
    console.log('🔄 L5 Cross-Platform Deduplication Starting...');

    // Load models
    let models = [];
    try {
        if (fs.existsSync(MODELS_CACHE)) {
            const data = JSON.parse(fs.readFileSync(MODELS_CACHE, 'utf-8'));
            models = data.data || data.models || [];
        } else {
            console.log('No models cache found, skipping');
            return;
        }
    } catch (e) {
        console.error('Failed to load models:', e.message);
        return;
    }

    console.log(`Loaded ${models.length} models`);

    // Find duplicates
    const duplicateGroups = findDuplicateGroups(models);
    console.log(`Found ${duplicateGroups.length} duplicate groups`);

    // Build canonical mappings
    const canonicalMap = {};
    const stats = {
        total_models: models.length,
        duplicate_groups: duplicateGroups.length,
        total_duplicates: 0,
        platforms: {}
    };

    duplicateGroups.forEach((group, idx) => {
        const canonical = selectCanonical(group);
        stats.total_duplicates += group.length - 1;

        group.forEach(model => {
            if (model.umid !== canonical.umid) {
                canonicalMap[model.umid] = {
                    canonical_id: canonical.umid,
                    canonical_name: canonical.name,
                    reason: 'name_similarity',
                    similarity: calculateSimilarity(model, canonical)
                };
            }

            // Track platform stats
            const platform = model.source?.split(':')[0] || 'unknown';
            stats.platforms[platform] = (stats.platforms[platform] || 0) + 1;
        });
    });

    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Write deduplication map
    const outputPath = path.join(OUTPUT_DIR, 'deduplication-map.json');
    const output = {
        generated_at: new Date().toISOString(),
        contract_version: 'V12',
        stats,
        canonical_map: canonicalMap,
        sample_groups: duplicateGroups.slice(0, 5).map(g => g.map(m => ({
            umid: m.umid,
            name: m.name,
            author: m.author,
            source: m.source,
            downloads: m.downloads
        })))
    };

    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`✅ Deduplication map written to ${outputPath}`);
    console.log(`   - ${stats.duplicate_groups} duplicate groups`);
    console.log(`   - ${stats.total_duplicates} total duplicates mapped`);

    return output;
}

// Run
runDeduplication()
    .then(() => console.log('🎉 Deduplication complete!'))
    .catch(err => {
        console.error('❌ Error:', err);
        process.exit(1);
    });
