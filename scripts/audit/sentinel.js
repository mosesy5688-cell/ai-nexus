/**
 * Operation Sentinel - Pre-Production Audit Script
 * 
 * Constitution V4.1 Quality Assurance
 * 
 * Modules:
 * - Module A: Spider - Core link integrity check
 * - Module B: Inspector - Constitution compliance verification  
 * - Module C: Hammer - API stress test
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { performance } from 'perf_hooks';

const BASE_URL = process.env.AUDIT_URL || 'https://free2aitools.com';
const ENDPOINTS = ['/', '/ranking', '/explore', '/methodology', '/about', '/compliance'];
const SAMPLE_MODEL = '/model/hf-dataset%3Adeepmind%3Acode_contests';

console.log('🛡️ Starting Operation Sentinel...');
console.log(`📍 Target: ${BASE_URL}`);
console.log('');

async function runAudit() {
    const report = { brokenLinks: [], violations: [], perf: {}, passes: [] };

    // --- MODULE A: The Spider (Integrity) ---
    console.log('🕷️ Module A: Checking Core Links...');
    for (const path of ENDPOINTS) {
        try {
            const res = await axios.get(BASE_URL + path, { timeout: 10000 });
            if (res.status === 200) {
                report.passes.push(`✅ ${path}`);
            } else {
                report.brokenLinks.push(`${path} (Status: ${res.status})`);
            }
        } catch (e) {
            report.brokenLinks.push(`${path} (${e.message})`);
        }
    }
    console.log(`   Checked ${ENDPOINTS.length} endpoints\n`);

    // --- MODULE B: The Inspector (Constitution Compliance) ---
    console.log('🧐 Module B: Verifying V4.1 Features...');
    try {
        const { data } = await axios.get(BASE_URL + SAMPLE_MODEL, { timeout: 15000 });
        const $ = cheerio.load(data);

        // Check 1: FNI Trust Panel (Pillar VII)
        const hasFNIPanel = $('[class*="fni"]').length > 0 ||
            $('text:contains("FNI")').length > 0 ||
            data.includes('Free2AI Nexus Index');
        if (hasFNIPanel) {
            report.passes.push('✅ FNI Trust Panel detected');
        } else {
            report.violations.push('⚠️ Missing FNI Trust Panel (Pillar VII)');
        }

        // Check 2: Source URL (Download button)
        const hasSourceLink = $('a[target="_blank"]').length > 0 ||
            data.includes('huggingface.co');
        if (hasSourceLink) {
            report.passes.push('✅ Source URL link detected');
        } else {
            report.violations.push('⚠️ Missing Source URL/Download link');
        }

        // Check 3: Footer Methodology Link (Pillar VII Trust)
        const hasMethodologyLink = $('footer a[href="/methodology"]').length > 0 ||
            data.includes('href="/methodology"');
        if (hasMethodologyLink) {
            report.passes.push('✅ Footer Methodology link present');
        } else {
            report.violations.push('⚠️ Missing Methodology Link in Footer');
        }

        // Check 4: Footer Compliance Link
        const hasComplianceLink = $('footer a[href="/compliance"]').length > 0 ||
            data.includes('href="/compliance"');
        if (hasComplianceLink) {
            report.passes.push('✅ Footer Compliance link present');
        } else {
            report.violations.push('⚠️ Missing Compliance Link in Footer');
        }

        // Check 5: FNI Badge with 4 dimensions (P/V/C/U)
        const hasFNIBadge = data.includes('Pop') && data.includes('Vel') &&
            data.includes('Cred') && data.includes('Util');
        if (hasFNIBadge) {
            report.passes.push('✅ FNI Badge shows all 4 dimensions (P/V/C/U)');
        } else {
            report.violations.push('⚠️ FNI Badge may be missing U (Utility) dimension');
        }

    } catch (e) {
        report.violations.push(`❌ Could not fetch model page for inspection: ${e.message}`);
    }
    console.log(`   Ran ${5} compliance checks\n`);

    // --- MODULE C: The Hammer (Stress Test) ---
    console.log('🔨 Module C: Stress Testing Trending API...');
    const start = performance.now();
    let errors = 0;
    let successes = 0;
    const REQUESTS = 20;

    const promises = Array(REQUESTS).fill(0).map(() =>
        axios.get(`${BASE_URL}/api/trending.json`, { timeout: 10000 })
            .then(() => { successes++; })
            .catch(() => { errors++; })
    );

    await Promise.all(promises);
    const duration = performance.now() - start;

    report.perf = {
        totalRequests: REQUESTS,
        successCount: successes,
        totalTime: `${duration.toFixed(0)}ms`,
        avgLatency: `${(duration / REQUESTS).toFixed(0)}ms`,
        errorRate: `${((errors / REQUESTS) * 100).toFixed(1)}%`,
        status: errors === 0 ? '✅ PASS' : errors < REQUESTS / 2 ? '⚠️ DEGRADED' : '❌ FAIL'
    };
    console.log(`   Sent ${REQUESTS} concurrent requests\n`);

    // --- FINAL REPORT ---
    console.log('═══════════════════════════════════════════════════════');
    console.log('📊 SENTINEL REPORT');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('🔗 Link Integrity:');
    if (report.brokenLinks.length === 0) {
        console.log('   ✅ All core endpoints accessible');
    } else {
        console.log('   ❌ Broken Links Found:');
        report.brokenLinks.forEach(l => console.log(`      - ${l}`));
    }
    console.log('');

    console.log('📋 Constitution Compliance:');
    report.passes.forEach(p => console.log(`   ${p}`));
    if (report.violations.length > 0) {
        report.violations.forEach(v => console.log(`   ${v}`));
    }
    console.log('');

    console.log('⚡ Performance (Trending API):');
    console.log(`   Total Requests: ${report.perf.totalRequests}`);
    console.log(`   Success Count:  ${report.perf.successCount}`);
    console.log(`   Total Time:     ${report.perf.totalTime}`);
    console.log(`   Avg Latency:    ${report.perf.avgLatency}`);
    console.log(`   Error Rate:     ${report.perf.errorRate}`);
    console.log(`   Status:         ${report.perf.status}`);
    console.log('');

    console.log('═══════════════════════════════════════════════════════');

    const hasFailures = report.violations.length > 0 || report.brokenLinks.length > 0;
    if (hasFailures) {
        console.log('🚨 AUDIT RESULT: ISSUES DETECTED');
        process.exit(1);
    } else {
        console.log('✅ AUDIT RESULT: ALL CHECKS PASSED');
        process.exit(0);
    }
}

runAudit().catch(e => {
    console.error('❌ Sentinel failed to run:', e.message);
    process.exit(1);
});
