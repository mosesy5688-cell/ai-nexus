/**
 * Output Writer for Ingestion Pipeline
 */
import fs from 'fs';
import path from 'path';

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
        last_commercial_at: null
    }));

    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

    console.log(`   ✓ Saved ${output.length} entities to ${outputFile}`);
    return output.length;
}
