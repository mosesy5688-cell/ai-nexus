/**
 * Aggregator Shard Manager V56.2 (Rust FFI streaming, O(1) memory)
 *
 * V56.2: Removed `fs.readFile → decompress → toString('utf-8') → JSON.parse` anti-pattern.
 * Each 2/4 artifact shard is now streamed via `partitionMonolithStreamingly`, which uses
 * Rust FFI streaming Zstd decompress + an O(1) incremental JSON object scanner. This kills
 * the V8 512 MiB single-string ceiling (`Cannot create a string longer than 0x1fffffe8
 * characters`) that silently dropped 12/20 shards in 3/4 run 24249641009 after PR #1726
 * restored full 22k-entity shards.
 *
 * Constitutional law: Rust is primary, streaming is mandatory. Same anti-pattern that
 * #1723 eliminated from shard-processor.js — eliminated here too. Hard-fail on zero-entity
 * shards (refuses silent loss).
 *
 * Callback contract change: `processShardsIteratively` now invokes its callback **per
 * entity**, not per shard. The old `(shard) => for (entity of shard.entities)` pattern
 * required buffering whole shards into memory. Both internal callsites (preProcessDeltas
 * in aggregator-utils.js) updated to match.
 */
import fs from 'fs/promises';
import path from 'path';
import { partitionMonolithStreamingly } from './aggregator-stream-utils.js';

/** Slim projection field set — used by preProcessDeltas to drop unused payload fields. */
const SLIM_FIELDS = [
    'id', 'umid', 'slug', 'name', 'type', 'author', 'description',
    'tags', 'metrics', 'stars', 'forks', 'downloads', 'likes',
    'citations', 'size', 'runtime', 'fni_score', 'fni_percentile',
    'fni_s', 'fni_a', 'fni_p', 'fni_r', 'fni_q', 'fni_metrics',
    'fni_trend_7d', 'is_rising_star', 'primary_category',
    'pipeline_tag', 'published_date', 'last_modified',
    'last_updated', 'lastModified', '_updated',
    'params_billions', 'context_length', 'architecture',
    'mmlu', 'gsm8k', 'avg_score', 'humaneval',
    'deploy_score', 'has_gguf', 'has_ollama', 'ollama_id',
    'benchmark_avg', 'license', 'source'
];

function projectSlim(result) {
    const ent = result.enriched || result;
    const projected = {};
    for (const f of SLIM_FIELDS) {
        if (ent[f] !== undefined) projected[f] = ent[f];
    }
    if (result.enriched) {
        return { ...result, enriched: projected };
    }
    return projected;
}

/**
 * V56.2: Streaming FNI map builder.
 *
 * Streams each 2/4 artifact shard one entity at a time via `partitionMonolithStreamingly`
 * (Rust FFI streaming Zstd decompress + O(1) JSON object scanner). Never materializes the
 * full shard payload as a single string, so payload size is bounded only by disk, not by
 * V8's 512 MiB single-string limit.
 *
 * Hard-fails on missing or empty shards — never silently builds a partial fniMap.
 */
export async function buildFniMap(artifactDir, totalShards) {
    const fniMap = new Map();
    let totalEntities = 0;
    let skippedNoScore = 0;

    for (let i = 0; i < totalShards; i++) {
        const p = path.join(artifactDir, `shard-${i}.json.zst`);
        if (!(await fs.stat(p).catch(() => null))) {
            throw new Error(`[FNI-MAP] Shard ${i} artifact missing at ${p} — refusing partial map (post-#1726 every shard MUST exist)`);
        }

        let shardCount = 0;
        await partitionMonolithStreamingly(p, (result) => {
            const e = result.enriched || result;
            if (e.id && e.fni_score != null) {
                fniMap.set(e.id, e.fni_score);
            } else {
                skippedNoScore++;
            }
            shardCount++;
        });

        if (shardCount === 0) {
            throw new Error(`[FNI-MAP] Shard ${i} streamed 0 entities from ${p} — refusing silent loss (V8 string limit or corrupt artifact)`);
        }
        totalEntities += shardCount;
    }

    console.log(`[FNI-MAP] Built ${fniMap.size} scores from ${totalShards} artifact shards (${totalEntities} total entities, ${skippedNoScore} skipped/no-score, 0 missed shards).`);
    return fniMap;
}

/**
 * V56.2: Streaming shard entity iterator.
 *
 * Replaces V18.12.5.12 buffered approach (`fs.readFile → toString → JSON.parse`).
 * Each shard file is streamed entity-by-entity via `partitionMonolithStreamingly`, so
 * peak memory is O(1 entity) regardless of shard payload size.
 *
 * **Callback contract change**: `entityCallback(entity, shardIdx)` is invoked once per
 * entity, NOT once per shard. Both production callsites (preProcessDeltas in
 * aggregator-utils.js) updated accordingly.
 *
 * Hard-fails on present-but-empty shards (silent loss prevention). Missing shards are
 * skipped (matches the legacy multi-path search behavior).
 *
 * @param {string} defaultArtifactDir
 * @param {number} totalShards
 * @param {{slim?: boolean}} options
 * @param {(entity: object, shardIdx: number) => void|Promise<void>} entityCallback
 * @param {number} startShard
 * @param {number|null} endShard
 */
export async function processShardsIteratively(defaultArtifactDir, totalShards, options = {}, entityCallback, startShard = 0, endShard = null) {
    const { slim = false } = options;
    const searchPaths = [defaultArtifactDir, './artifacts', './output/cache/shards', './cache/registry', './output/registry'];
    const limit = endShard === null ? totalShards : Math.min(endShard, totalShards);

    for (let i = startShard; i < limit; i++) {
        // V56.2: Only the 2/4 artifact format (`shard-${i}.json.*`) is supported here.
        // The legacy `merged_shard_${i}.json.*` candidates were 1/4 Consolidator NDJSON
        // output (the 2/4 *input*), wrong format for the aggregator and never matched
        // in production. Removed to keep the search-path contract honest.
        let foundPath = null;
        for (const p of searchPaths) {
            const candidates = [
                path.join(p, `shard-${i}.json.zst`),
                path.join(p, `shard-${i}.json.gz`),
                path.join(p, `shard-${i}.json`)
            ];
            for (const candidate of candidates) {
                if (await fs.stat(candidate).catch(() => null)) {
                    foundPath = candidate;
                    break;
                }
            }
            if (foundPath) break;
        }
        if (!foundPath) continue;

        let shardCount = 0;
        await partitionMonolithStreamingly(foundPath, (result) => {
            const projected = slim ? projectSlim(result) : result;
            entityCallback(projected, i);
            shardCount++;
        });

        if (shardCount === 0) {
            throw new Error(`[SHARDS] Shard ${i} streamed 0 entities from ${foundPath} — refusing silent loss (V8 string limit or corrupt artifact)`);
        }
    }
}
