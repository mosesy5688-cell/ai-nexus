/** Aggregator Shard Manager V25.8.6 (Split from aggregator-utils) */
import fs from 'fs/promises';
import path from 'path';
import { autoDecompress, zstdDecompress } from './zstd-helper.js';
import { partitionMonolithStreamingly } from './aggregator-stream-utils.js';

/** V25.8.6: Direct FNI overlay from 2/4 artifacts onto fullSet. Bypasses merge path. */
export async function overlayFniFromArtifacts(fullSet, artifactDir, totalShards) {
    const fniMap = new Map();
    for (let i = 0; i < totalShards; i++) {
        const p = path.join(artifactDir, `shard-${i}.json.zst`);
        try {
            const raw = await fs.readFile(p);
            const json = JSON.parse((await zstdDecompress(raw)).toString('utf-8'));
            for (const r of (json.entities || [])) {
                const e = r.enriched || r;
                if (e.id && e.fni_score != null) fniMap.set(e.id, e.fni_score);
            }
        } catch (err) {
            console.warn(`[FNI-OVERLAY] Shard ${i}: ${err.message}`);
        }
    }
    if (fniMap.size === 0) { console.warn('[FNI-OVERLAY] No FNI scores found in artifacts.'); return 0; }
    let patched = 0;
    for (const e of fullSet) {
        const score = fniMap.get(e.id);
        if (score !== undefined) { e.fni_score = score; e.fni = score; patched++; }
    }
    console.log(`[FNI-OVERLAY] Patched ${patched}/${fullSet.length} entities (${fniMap.size} scores from artifacts).`);
    return patched;
}

/** Iterative Shard Processor (V18.12.5.12 OOM Guard) */
export async function processShardsIteratively(defaultArtifactDir, totalShards, options = {}, callback, startShard = 0, endShard = null) {
    const { slim = false } = options;
    const searchPaths = [defaultArtifactDir, './artifacts', './output/cache/shards', './cache/registry', './output/registry'];
    const limit = endShard === null ? totalShards : Math.min(endShard, totalShards);

    for (let i = startShard; i < limit; i++) {
        let shardData = null;
        for (const p of searchPaths) {
            try {
                const candidates = [
                    path.join(p, `merged_shard_${i}.json.zst`),
                    path.join(p, `merged_shard_${i}.json.gz`),
                    path.join(p, `shard-${i}.json.zst`),
                    path.join(p, `shard-${i}.json.gz`),
                    path.join(p, `shard-${i}.json`)
                ];

                let data;
                let found = false;
                for (const candidate of candidates) {
                    if (await fs.access(candidate).then(() => true).catch(() => false)) {
                        const raw = await fs.readFile(candidate);
                        data = (await autoDecompress(raw)).toString('utf-8');
                        found = true;
                        break;
                    }
                }
                if (!found) continue;

                const parsed = JSON.parse(data);
                if (slim && parsed.entities) {
                    const slimFields = [
                        'id', 'umid', 'slug', 'name', 'type', 'author', 'description',
                        'tags', 'metrics', 'stars', 'forks', 'downloads', 'likes',
                        'citations', 'size', 'runtime', 'fni_score', 'fni_percentile',
                        'fni_trend_7d', 'is_rising_star', 'primary_category',
                        'pipeline_tag', 'published_date', 'last_modified',
                        'last_updated', 'lastModified', '_updated',
                        'params_billions', 'context_length', 'architecture',
                        'mmlu', 'gsm8k', 'avg_score', 'humaneval',
                        'deploy_score', 'has_gguf', 'has_ollama', 'ollama_id',
                        'benchmark_avg', 'license', 'source'
                    ];
                    for (let j = 0; j < parsed.entities.length; j++) {
                        const ent = parsed.entities[j].enriched || parsed.entities[j];
                        const projected = {};
                        for (const f of slimFields) {
                            if (ent[f] !== undefined) projected[f] = ent[f];
                        }
                        if (parsed.entities[j].enriched) parsed.entities[j].enriched = projected;
                        else parsed.entities[j] = projected;
                    }
                }
                shardData = parsed;
                break;
            } catch (e) { continue; }
        }

        if (shardData) {
            await callback(shardData, i);
        }
        shardData = null;
    }
}

/** Pass 1.5: Pre-process updates (Monolith or Shards) */
export async function preProcessDeltas(artifactDir, totalShards, registryMap, monolithPath = null) {
    const deltaDir = './cache/deltas';
    await fs.mkdir(deltaDir, { recursive: true });

    // Clear old deltas
    const files = await fs.readdir(deltaDir).catch(() => []);
    for (const f of files) await fs.unlink(path.join(deltaDir, f));

    const updateBuffers = new Map(); // shardIdx -> string[]
    const FLUSH_THRESHOLD = 5000;
    let updateCount = 0;
    let totalProcessed = 0;

    const flushBuffers = async () => {
        for (const [idx, lines] of updateBuffers.entries()) {
            if (lines.length > 0) {
                await fs.appendFile(path.join(deltaDir, `reg-${idx}.jsonl`), lines.join('\n') + '\n');
                lines.length = 0;
            }
        }
    };

    if (monolithPath && await fs.access(monolithPath).then(() => true).catch(() => false)) {
        await partitionMonolithStreamingly(monolithPath, async (incoming) => {
            const regIdx = registryMap.get(incoming.id);
            if (regIdx !== undefined) {
                if (!updateBuffers.has(regIdx)) updateBuffers.set(regIdx, []);
                updateBuffers.get(regIdx).push(JSON.stringify(incoming));
                updateCount++;
                totalProcessed++;
                if (totalProcessed % FLUSH_THRESHOLD === 0) await flushBuffers();
            }
        });
    } else {
        await processShardsIteratively(artifactDir, totalShards, { slim: true }, async (shard) => {
            if (shard?.entities) {
                for (const result of shard.entities) {
                    const incoming = result.enriched || result;
                    const regIdx = registryMap.get(incoming.id);
                    if (regIdx !== undefined) {
                        if (!updateBuffers.has(regIdx)) updateBuffers.set(regIdx, []);
                        updateBuffers.get(regIdx).push(JSON.stringify(incoming));
                        updateCount++;
                        totalProcessed++;
                        if (totalProcessed % FLUSH_THRESHOLD === 0) await flushBuffers();
                    }
                }
            }
        });
    }

    await flushBuffers();
    updateBuffers.clear();
    console.log(`  [DELTAS] Aligned ${updateCount} updates across all shards.`);
}
