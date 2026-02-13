/**
 * V12 Explicit Relations Extractor
 * Extracts base_model, datasets_used, arxiv_refs from entity cache
 * Outputs to data/relations.json for D1 sync
 * @module l5/v12-relations-extract
 */
import fs from 'fs';
import path from 'path';
import pako from 'pako';
import { execSync } from 'child_process';

const R2_BUCKET = 'ai-nexus-assets';
const ENTITY_TYPES = ['model', 'dataset', 'space', 'agent', 'paper'];
const OUTPUT_FILE = 'data/relations.json';

// V12 Relation type mapping
const RELATION_MAP = {
    base_model: { type: 'BASED_ON', target_type: 'model' },
    datasets_used: { type: 'TRAINED_ON', target_type: 'dataset' },
    arxiv_refs: { type: 'CITES', target_type: 'paper' },
    models_used: { type: 'USES', target_type: 'model' }
};

async function fetchEntitiesFromR2(entityType) {
    console.log(`📥 Fetching ${entityType} entities from R2...`);
    try {
        const listResult = execSync(
            `npx wrangler r2 object list ${R2_BUCKET} --prefix=cache/entities/${entityType}/ --json`,
            { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
        );
        const objects = JSON.parse(listResult);
        console.log(`   Found ${objects.length} ${entityType} entities`);
        return objects;
    } catch (e) {
        console.warn(`   ⚠️ Failed to list ${entityType}: ${e.message}`);
        return [];
    }
}

function extractRelations(entity, sourceId) {
    const relations = [];
    for (const [field, config] of Object.entries(RELATION_MAP)) {
        const value = entity[field];
        if (!value) continue;
        const values = Array.isArray(value) ? value : [value];
        for (const targetId of values) {
            if (!targetId || targetId.length < 2) continue;
            relations.push({
                source_id: sourceId,
                target_id: normalizeTargetId(targetId, config.target_type),
                relation_type: config.type,
                confidence: 1.0,
                source: 'tag'
            });
        }
    }
    return relations;
}

function normalizeTargetId(id, targetType) {
    if (id.startsWith('huggingface--') || id.startsWith('hf-')) return id;
    if (id.includes('/')) return `huggingface--${id.replace(/\//g, '--')}`;
    if (targetType === 'paper' && /^\d{4}\.\d{4,5}$/.test(id)) return `arxiv--${id}`;
    return id;
}

async function main() {
    console.log('🔗 V12 Explicit Relations Extractor\n');
    const allRelations = [];
    const stats = {};

    for (const entityType of ENTITY_TYPES) {
        const objects = await fetchEntitiesFromR2(entityType);
        let typeRelations = 0;
        for (const obj of objects.slice(0, 1000)) { // Limit for safety
            try {
                const data = execSync(
                    `npx wrangler r2 object get ${R2_BUCKET} "${obj.key}" --pipe`,
                    { encoding: 'buffer', maxBuffer: 1024 * 1024 }
                );
                const entity = JSON.parse(data.toString('utf8'));
                // V16.6 Fix: Strip extensions agnostic of .gz
                const sourceId = entity.id || entity.entity?.id || path.basename(obj.key).replace(/\.json(\.gz)?$/, '');
                const relations = extractEntityRelations(entity.entity || entity, sourceId);
                allRelations.push(...relations);
                typeRelations += relations.length;
            } catch (e) { /* skip */ }
        }
        stats[entityType] = typeRelations;
        console.log(`   ✅ ${entityType}: ${typeRelations} relations`);
    }

    // Write output
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(allRelations, null, 2));
    console.log(`\n📦 Total: ${allRelations.length} relations → ${OUTPUT_FILE}`);
    console.log('📊 Stats:', stats);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
