/**
 * Output Writer for Ingestion Pipeline
 */
import fs from 'fs';
import path from 'path';
import { zstdCompress } from '../factory/lib/zstd-helper.js';

export async function saveOutput(entities, outputDir, outputFile) {
    // Ensure output directory exists
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Transform to output format (matching Rust processor expectations)
    const output = entities.map(e => ({
        id: e.id,
        name: e.title,
        author: e.author,
        description: e.description,
        tags: e.tags,
        pipeline_tag: e.pipeline_tag || e.meta_json?.pipeline_tag || 'other',
        likes: e.popularity || 0,
        downloads: e.downloads || 0,
        source: e.source,
        source_url: e.source_url,
        image_url: e.raw_image_url,
        // V3.2 fields
        type: e.type,
        body_content: e.body_content,
        meta_json: JSON.stringify(e.meta_json || {}),
        assets_json: JSON.stringify(e.assets || []),
        relations_json: JSON.stringify(e.relations || []),
        canonical_id: e.canonical_id || null,
        license_spdx: e.license_spdx,
        compliance_status: e.compliance_status,
        quality_score: e.quality_score,
        content_hash: e.content_hash,
        velocity: e.velocity || null,
        raw_image_url: e.raw_image_url,
        // V15.8: Preserve existing trail if present (from Augmentative Merging)
        source_trail: e.source_trail ? (typeof e.source_trail === 'string' ? e.source_trail : JSON.stringify(e.source_trail)) : JSON.stringify([{
            source_platform: e.source,
            source_url: e.source_url,
            fetched_at: new Date().toISOString(),
            adapter_version: '3.2.0'
        }]),
        commercial_slots: null, // Will be calculated by existing logic
        notebooklm_summary: null,
        velocity_score: e.velocity || 0,
        last_commercial_at: null,
        // V24.12: Schema expansion fields (promoted from meta_json)
        task_categories: e.task_categories || '',
        num_rows: e.num_rows || 0,
        primary_language: e.primary_language || '',
        forks: e.forks || 0,
        citation_count: e.citation_count || 0
    }));

    // V18.2.1 GA: Sharded Output Logic (Art 3.1 Compliance)
    // To prevent RangeError: Invalid string length, we MUST shard the 140k+ rich entities.
    const TOTAL_SHARDS = 20;

    console.log(`   📦 Sharding ${output.length} entities into ${TOTAL_SHARDS} chunks...`);

    for (let s = 0; s < TOTAL_SHARDS; s++) {
        const shardSlice = output.filter((_, idx) => idx % TOTAL_SHARDS === s);
        const shardContent = JSON.stringify(shardSlice);
        const compressedShard = await zstdCompress(shardContent);
        const shardPath = path.join(outputDir, `merged_shard_${s}.json.zst`);
        fs.writeFileSync(shardPath, compressedShard);
    }

    console.log(`   ✓ Sharded output saved to ${outputDir}/merged_shard_*.json.zst (Zstd)`);

    console.log(`   ✓ Saved ${output.length} entities (via Sharding)`);
    return output.length;
}
