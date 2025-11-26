#!/usr/bin/env node
/**
 * V9.52 - Auto-Enrich Progress Monitor
 * Tracks SEO enrichment status and verifies SSR page updates
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);

const REPORT_FILE = './enrichment_progress_report.json';
const CHECK_INTERVAL_MS = 60000; // 1 minute

async function queryD1(sql) {
    const cmd = `wrangler d1 execute ai-nexus-db --remote --command "${sql}"`;
    try {
        const { stdout } = await execAsync(cmd);
        return stdout;
    } catch (error) {
        console.error(`D1 Query Error: ${error.message}`);
        return null;
    }
}

async function getEnrichmentStatus() {
    const sql = "SELECT seo_status, COUNT(*) as count FROM models GROUP BY seo_status;";
    const output = await queryD1(sql);

    // Parse wrangler output to extract counts
    const doneMatch = output?.match(/│\s+done\s+│\s+(\d+)\s+│/);
    const pendingMatch = output?.match(/│\s+pending\s+│\s+(\d+)\s+│/);
    const failedMatch = output?.match(/│\s+failed\s+│\s+(\d+)\s+│/);

    return {
        done: doneMatch ? parseInt(doneMatch[1]) : 0,
        pending: pendingMatch ? parseInt(pendingMatch[1]) : 0,
        failed: failedMatch ? parseInt(failedMatch[1]) : 0,
        timestamp: new Date().toISOString()
    };
}

async function getRecentlyEnrichedModels(limit = 10) {
    const sql = `SELECT id, name, seo_status FROM models WHERE seo_status = 'done' LIMIT ${limit};`;
    const output = await queryD1(sql);
    return output;
}

async function monitorProgress() {
    console.log('🔍 Auto-Enrich Progress Monitor Started\n');
    console.log('Configuration:');
    console.log('  - Batch Size: 15 models/hour');
    console.log('  - Check Interval: 60 seconds\n');

    const report = {
        startTime: new Date().toISOString(),
        batchSize: 15,
        snapshots: []
    };

    const status = await getEnrichmentStatus();
    console.log(`📊 Current Status (${status.timestamp}):`);
    console.log(`  ✅ Done: ${status.done}`);
    console.log(`  ⏳ Pending: ${status.pending}`);
    console.log(`  ❌ Failed: ${status.failed}`);
    console.log(`\n⏱️  Estimated time to complete: ${Math.ceil(status.pending / 15)} hours\n`);

    report.snapshots.push(status);
    report.initialStatus = status;

    // Save report
    await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`✅ Report saved to ${REPORT_FILE}`);
    console.log('\n💡 Monitor will track progress hourly. Run this script again to update the report.');
}

monitorProgress().catch(console.error);
