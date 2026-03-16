/**
 * Aggregator Maintenance Utilities V16.8.6 (CES Compliant)
 * Part of the Modular Aggregator refactor to satisfy Art 5.1 (< 250 lines).
 */

import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';
import { loadDailyAccum } from './cache-manager.js';
import { generateTrendData } from './trend-data-generator.js';

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
    await fs.writeFile(path.join(healthDir, `${today}.json.gz`), zlib.gzipSync(JSON.stringify(health, null, 2)));
    console.log(`[HEALTH] Status: ${health.status}`);
}

/**
 * Backup state files and generate trend data
 */
export async function backupStateFiles(outputDir, historyData, weekNumber) {
    const backupBase = path.join(outputDir, 'meta', 'backup');

    // FNI Snapshot
    const fniBackupPath = path.join(backupBase, 'fni-history', `fni-history-${weekNumber}.json.gz`);
    await fs.mkdir(path.dirname(fniBackupPath), { recursive: true });
    await fs.writeFile(fniBackupPath, zlib.gzipSync(JSON.stringify(historyData, null, 2)));

    await generateTrendData(historyData, path.join(outputDir, 'cache'));

    // Daily Accumulator Snapshot
    const accumBackupPath = path.join(backupBase, 'accum', `accum-${weekNumber}.json.gz`);
    await fs.mkdir(path.dirname(accumBackupPath), { recursive: true });
    try {
        const accum = await loadDailyAccum();
        await fs.writeFile(accumBackupPath, zlib.gzipSync(JSON.stringify(accum, null, 2)));
    } catch (e) { console.warn(`[BACKUP] Accumulator skipped: ${e.message}`); }
}
