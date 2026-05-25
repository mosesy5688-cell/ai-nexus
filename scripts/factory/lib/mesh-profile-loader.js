/**
 * V27.62: Load mesh profiles produced by mesh-profile-baker.js into a Map.
 * Mesh-baker writes profile-shards/shard-NNNN.jsonl.zst per 1000 entities;
 * this helper streams them back into memory so pack-db can attach
 * mesh_profile onto each entity before distiller derives ui_related_mesh.
 * Empty Map on missing dir (first cron, local dev) — caller handles defaults.
 *
 * Memory discipline: only the `relations` array is kept per entity (profile
 * also carries name/type/url/icon which pack-db already has from fused row).
 * For 530K entities × ~10 relations × ~50B → ~265MB raw, ~800MB-1.3GB heap
 * with Node Map overhead. Block-scoped `raw` + `text` allow per-shard GC.
 */
import fs from 'fs/promises';
import path from 'path';
import { autoDecompress } from './zstd-helper.js';

export async function loadMeshProfileMap(cacheDir) {
    const shardDir = path.join(cacheDir, 'mesh', 'profile-shards');
    const meshMap = new Map();
    let files;
    try {
        files = (await fs.readdir(shardDir)).filter(f => f.endsWith('.jsonl.zst'));
    } catch (e) {
        if (e.code === 'ENOENT') {
            console.warn('[MESH] profile-shards dir missing — skip mesh attach');
            return meshMap;
        }
        throw e;
    }
    if (files.length === 0) {
        console.warn('[MESH] 0 profile-shards found — skip mesh attach');
        return meshMap;
    }
    files.sort();
    for (const f of files) {
        try {
            const raw = await fs.readFile(path.join(shardDir, f));
            const text = (await autoDecompress(raw)).toString('utf-8');
            for (const line of text.split('\n')) {
                // Trim defends against \r\n / trailing whitespace lines that would
                // otherwise reach JSON.parse and trigger expensive exception throw.
                const trimmed = line.trim();
                if (!trimmed) continue;
                try {
                    const profile = JSON.parse(trimmed);
                    if (profile.id && profile.relations) {
                        meshMap.set(profile.id, { relations: profile.relations });
                    }
                } catch { /* skip malformed line */ }
            }
        } catch (e) { console.warn(`[MESH] ${f}: ${e.message}`); }
    }
    console.log(`[MESH] Loaded ${meshMap.size} mesh profiles from ${files.length} shards`);
    return meshMap;
}
