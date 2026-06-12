import { promises as fs } from 'fs';

/**
 * Generates the integrity manifest and outputs to GITHUB_STEP_SUMMARY.
 */
export async function finalizeMerge(options) {
    const {
        manifestFile,
        outputFile,
        mergedContent,
        mergedHash,
        allEntitiesCount,
        batchManifests,
        sourceStats,
        batchFilesCount,
        fullSet,
        MAX_BATCH_SIZE_MB,
        MAX_ENTITIES_PER_BATCH,
        byteLength,
        avgVelocityOverride
    } = options;

    const avgVelocity = avgVelocityOverride !== undefined ? avgVelocityOverride : (fullSet.reduce((sum, m) => sum + (m.velocity || 0), 0) / (fullSet.length || 1));
    const finalByteLength = byteLength || (mergedContent ? Buffer.byteLength(mergedContent) : 0);

    const manifest = {
        version: 'INTEGRITY-V1.1',
        job_id: process.env.GITHUB_RUN_ID || 'local',
        timestamp: new Date().toISOString(),
        total_entities: allEntitiesCount,
        stats: {
            avgVelocity: parseFloat(avgVelocity.toFixed(4))
        },
        output: {
            file: 'merged.json.gz',
            hash: `sha256:${mergedHash}`,
            size: finalByteLength
        },
        batches: batchManifests,
        validation: {
            max_batch_size_mb: MAX_BATCH_SIZE_MB,
            max_entities_per_batch: MAX_ENTITIES_PER_BATCH
        }
    };

    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    console.log(`   Manifest: ${manifestFile}`);

    if (process.env.GITHUB_STEP_SUMMARY) {
        const summary = [
            `## Factory 1/4 - Harvest Complete 🌾`,
            ``,
            `### 📊 Pipeline Stats`,
            `| Metric | Value |`,
            `|--------|-------|`,
            `| **Total Entities** | **${allEntitiesCount}** |`,
            `| Source Files | ${batchFilesCount} |`,
            `| Total Size | ${(finalByteLength / 1024 / 1024).toFixed(2)} MB |`,
            ``,
            `### 🛡️ Integrity Check`,
            `- Manifest: \`INTEGRITY-V1.1\``,
            `- Merged Hash: \`${mergedHash.substring(0, 8)}...\``,
            ``,
            // PR-H2c: the old "Source Breakdown" table was FAKE — sourceStats is keyed
            // by the post-merge `raw_batch_<N>` shard filename (merge-batches.js:113),
            // not by harvest source, because the Bridge step cats all *_master.ndjson
            // into one stream and re-shards by size. So every "Source" row was a shard
            // index (raw_batch_0, raw_batch_1, ...), never huggingface/arxiv/etc. Per-source
            // truth now comes from the HARVEST SOURCE HEALTH table (harvest-health.js),
            // which keys off the per-source terminal-state sidecars. Stop rendering the
            // misleading breakdown rather than print a lie.
            `### 📦 Source Breakdown`,
            `- Per-source yield + health: see the **HARVEST SOURCE HEALTH** table (PR-H2c).`,
            `- Post-merge shard count: ${sourceStats.length} raw_batch shard(s).`,
            ``
        ].join('\n');

        await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    }
}
