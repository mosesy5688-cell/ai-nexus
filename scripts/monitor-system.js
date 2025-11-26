#!/usr/bin/env node
/**
 * AI-Nexus V9.53 - Full System Monitor
 * Comprehensive monitoring for Auto-Ingest, Weekly Maintenance, and Auto-Enrich
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';

const execAsync = promisify(exec);

const REPORT_FILE = './ai-nexus-status-report.json';

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

async function getSystemStatus() {
    console.log('🔍 AI-Nexus V9.53 System Status Check\n');
    console.log('='.repeat(60));

    const report = {
        timestamp: new Date().toISOString(),
        components: {}
    };

    // 1. Auto-Enrich Status
    console.log('\n📊 AUTO-ENRICH STATUS:');
    const seoStatus = await queryD1("SELECT seo_status, COUNT(*) as count FROM models GROUP BY seo_status;");
    const doneMatch = seoStatus?.match(/│\s+done\s+│\s+(\d+)\s+│/);
    const pendingMatch = seoStatus?.match(/│\s+pending\s+│\s+(\d+)\s+│/);
    const failedMatch = seoStatus?.match(/│\s+failed\s+│\s+(\d+)\s+│/);

    const enrichmentStatus = {
        done: doneMatch ? parseInt(doneMatch[1]) : 0,
        pending: pendingMatch ? parseInt(pendingMatch[1]) : 0,
        failed: failedMatch ? parseInt(failedMatch[1]) : 0,
        batchSize: 15,
        estimatedHoursRemaining: pendingMatch ? Math.ceil(parseInt(pendingMatch[1]) / 15) : 0
    };

    report.components.autoEnrich = enrichmentStatus;
    console.log(`  ✅ Done: ${enrichmentStatus.done}`);
    console.log(`  ⏳ Pending: ${enrichmentStatus.pending}`);
    console.log(`  ❌ Failed: ${enrichmentStatus.failed}`);
    console.log(`  ⏱️  Estimated completion: ${enrichmentStatus.estimatedHoursRemaining} hours`);

    // 2. Database Stats
    console.log('\n💾 DATABASE STATUS:');
    const totalModels = await queryD1("SELECT COUNT(*) as total FROM models;");
    const totalMatch = totalModels?.match(/│\s+(\d+)\s+│/);
    const total = totalMatch ? parseInt(totalMatch[1]) : 0;

    report.components.database = {
        totalModels: total,
        lastChecked: new Date().toISOString()
    };
    console.log(`  📦 Total Models: ${total}`);

    // 3. Workflow Status (placeholders - requires GitHub API)
    console.log('\n🔄 WORKFLOW STATUS:');
    console.log('  ⚠️  Auto-Ingest: Needs manual trigger via GitHub Actions');
    console.log('  ⚠️  Weekly Maintenance: Needs manual trigger via GitHub Actions');

    report.components.workflows = {
        autoIngest: 'pending_manual_trigger',
        weeklyMaintenance: 'pending_manual_trigger',
        note: 'Requires GitHub Actions workflow_dispatch'
    };

    // 4. SSR Verification (sample check)
    console.log('\n🌐 SSR VERIFICATION:');
    console.log('  💡 Sample check: /model/github-Netflix-metaflow');
    report.components.ssr = {
        sampleUrl: 'https://009a977d.ai-nexus-293.pages.dev/model/github-Netflix-metaflow',
        status: 'manual_verification_required'
    };

    // Save report
    await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n✅ Report saved to ${REPORT_FILE}`);

    // Next steps
    console.log('\n📋 NEXT STEPS:');
    console.log('  1. Go to GitHub → Actions → "Auto-Ingest (Rust Powered)"');
    console.log('  2. Click "Run workflow" to trigger manual execution');
    console.log('  3. Monitor logs and download artifacts');
    console.log('  4. Run this script again to track progress');

    return report;
}

getSystemStatus().catch(console.error);
