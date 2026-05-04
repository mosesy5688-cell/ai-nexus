/**
 * Aggregator Maintenance Utilities V16.8.6 (CES Compliant)
 * Part of the Modular Aggregator refactor to satisfy Art 5.1 (< 250 lines).
 */

import fs from 'fs/promises';
import path from 'path';
import { loadDailyAccum } from './cache-manager.js';
import { generateTrendData } from './trend-data-generator.js';
import { zstdCompress } from './zstd-helper.js';

/**
 * V25.8.3: Validate AES_CRYPTO_KEY when encrypted .bin shards exist.
 * Prevents silent data drought that starves all satellite tasks.
 */
export async function validateCryptoEnv() {
    const cacheDir = process.env.CACHE_DIR || './cache';
    const regDir = path.join(cacheDir, 'registry');
    try {
        const files = await fs.readdir(regDir);
        const hasBinShards = files.some(f => f.startsWith('part-') && f.endsWith('.bin'));
        if (hasBinShards && (!process.env.AES_CRYPTO_KEY || process.env.AES_CRYPTO_KEY.length < 64)) {
            console.error('[AGGREGATOR] ⚠ CRITICAL: Encrypted .bin shards detected but AES_CRYPTO_KEY is missing or invalid (<32 bytes).');
            console.error('[AGGREGATOR] ⚠ Pass 1 will return 0 entities and ALL satellite tasks will fail.');
            console.error('[AGGREGATOR] ⚠ Set AES_CRYPTO_KEY (64 hex chars / 32 bytes) in your environment.');
        }
    } catch { /* registry dir doesn't exist yet */ }
}

/**
 * Get week number for backup file naming
 */
export function getWeekNumber() {
    const now = new Date();
    const year = now.getFullYear();
    const oneJan = new Date(year, 0, 1);
    const weekNum = Math.ceil(((now - oneJan) / 86400000 + oneJan.getDay() + 1) / 7);
    return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Generate health report (Art 8.3)
 */
export async function generateHealthReport(successfulCount, entities, totalShards, minSuccessRate, outputDir) {
    const today = new Date().toISOString().split('T')[0];
    const successful = typeof successfulCount === 'number' ? successfulCount : (successfulCount ? successfulCount.filter(s => s !== null).length : 0);

    const health = {
        date: today,
        shardSuccessRate: successful / totalShards,
        totalEntities: entities.length,
        timestamp: new Date().toISOString(),
        status: successful >= totalShards * minSuccessRate ? 'healthy' : 'degraded',
    };

    const healthDir = path.join(outputDir, 'meta', 'health');
    await fs.mkdir(healthDir, { recursive: true });
    await fs.writeFile(path.join(healthDir, `${today}.json.zst`), await zstdCompress(JSON.stringify(health, null, 2)));
    console.log(`[HEALTH] Status: ${health.status}`);
}

/**
 * Backup state files and generate trend data
 *
 * V25.13 (P1 + P6 fix): Eliminated the FNI weekly monolith snapshot write.
 *
 * Background — run 25307160858 failed at finalize with `Invalid string length`
 * because `JSON.stringify(historyData, null, 2)` on 483K entities produced a
 * ~530MB string, exceeding V8's single-string max (~512MB on 64-bit Node 22).
 *
 * Audit revealed the file `meta/backup/fni-history/fni-history-W<N>.json.zst`
 * is **dead archive**:
 *   - r2-registry-restore.js::restoreFromPrefix filters for `part-*.bin` and
 *     `part-*.json.gz` only — the weekly monolith name doesn't match
 *   - registry-history.js::loadFniHistory only reads `part-*` / `shard-*`
 *     prefixed files — same filter
 *   - No human-facing consumer (not exposed via CDN routes)
 *
 * Authoritative FNI history state = `cache/fni-history/part-*.json.zst` shards
 * (written by `saveFniHistory`, R2-backed via workflow line 360
 * `backup-dir cache/fni-history/ meta/backup/fni-history/`). The weekly
 * monolith was redundant + violated P1 (fullSet stringify).
 *
 * Per P6: thorough fix = remove the dead code, not patch the symptom.
 * Per P1: no fullSet stringify in hot paths.
 */
export async function backupStateFiles(outputDir, historyData, weekNumber) {
    const backupBase = path.join(outputDir, 'meta', 'backup');

    // V25.13: FNI snapshot REMOVED. The sharded files at cache/fni-history/
    // are authoritative state and are R2-backed via the workflow's
    // `backup-dir cache/fni-history/` step. Nothing reads the monolith.

    await generateTrendData(historyData, path.join(outputDir, 'cache'));

    // Daily Accumulator Snapshot (small, ~50 entries — no V8 risk)
    const accumBackupPath = path.join(backupBase, 'accum', `accum-${weekNumber}.json.zst`);
    await fs.mkdir(path.dirname(accumBackupPath), { recursive: true });
    try {
        const accum = await loadDailyAccum();
        await fs.writeFile(accumBackupPath, await zstdCompress(JSON.stringify(accum)));
    } catch (e) { console.warn(`[BACKUP] Accumulator skipped: ${e.message}`); }
}
