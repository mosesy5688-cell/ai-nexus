/**
 * Operation Sentinel V2 - Pre-Production Audit Script
 * 
 * Constitution V4.1 Compliance Verification
 * 
 * Modules: A (Spider), B (Inspector), B+ (Deep Link), C (Hammer)
 */

import axios from 'axios';
import * as cheerio from 'cheerio';
import { performance } from 'perf_hooks';

const BASE_URL = process.env.AUDIT_URL || 'https://free2aitools.com';
const ENDPOINTS = ['/', '/ranking', '/explore', '/methodology', '/about', '/compliance'];

// Test candidates for Deep Link Verification
const TEST_MODELS = [
    {
        id: 'arxiv:2512.07814v1',
        slug: 'arxiv%3A2512.07814v1',
        source: 'arxiv',
        expectedDomain: 'arxiv.org'
    },
    {
        id: 'hf-dataset:facebear:xvla-soft-fold',
        slug: 'hf-dataset%3Afacebear%3Axvla-soft-fold',
        source: 'huggingface',
        expectedDomain: 'huggingface.co'
    }
];

console.log('🛡️ Starting Operation Sentinel V2...');
console.log(`📍 Target: ${BASE_URL}`);
console.log('');

async function runAudit() {
    const report = {
        brokenLinks: [],
        violations: [],
        linkVerification: [],
        perf: {},
        passes: []
    };

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
    const sampleModel = TEST_MODELS[0];
    try {
        const { data } = await axios.get(`${BASE_URL}/model/${sampleModel.slug}`, { timeout: 15000 });
        const $ = cheerio.load(data);

        // Check 1: FNI Trust Panel (Pillar VII)
        const hasFNIPanel = $('[class*="fni"]').length > 0 ||
            data.includes('Free2AI Nexus Index') ||
            data.includes('FNI Score');
        if (hasFNIPanel) {
            report.passes.push('✅ FNI Trust Panel detected');
        } else {
            report.violations.push('⚠️ Missing FNI Trust Panel (Pillar VII)');
        }

        // Check 2: Check Footer Links
        const hasMethodologyLink = data.includes('href="/methodology"');
        if (hasMethodologyLink) {
            report.passes.push('✅ Footer Methodology link present');
        } else {
            report.violations.push('⚠️ Missing Methodology Link in Footer');
        }

        const hasComplianceLink = data.includes('href="/compliance"');
        if (hasComplianceLink) {
            report.passes.push('✅ Footer Compliance link present');
        } else {
            report.violations.push('⚠️ Missing Compliance Link in Footer');
        }

        // Check 3: FNI Badge with 4 dimensions (P/V/C/U)
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
    console.log(`   Ran compliance checks\n`);

    // --- MODULE B+: Deep Link Verifier (NEW in V2) ---
    console.log('🔗 Module B+: Deep Link Verification...');
    for (const model of TEST_MODELS) {
        try {
            const url = `${BASE_URL}/model/${model.slug}`;
            const { data } = await axios.get(url, { timeout: 15000 });
            const $ = cheerio.load(data);

            // Find the Download/Source button - look for external links
            const downloadLinks = $('a[target="_blank"]').toArray();
            let foundCorrectLink = false;
            let foundHref = 'none';

            for (const link of downloadLinks) {
                const href = $(link).attr('href') || '';
                if (href.includes(model.expectedDomain)) {
                    foundCorrectLink = true;
                    foundHref = href;
                    break;
                }
                // Also capture what we did find for debugging
                if (href.includes('http') && !foundHref.includes('http')) {
                    foundHref = href;
                }
            }

            if (foundCorrectLink) {
                report.linkVerification.push({
                    model: model.id,
                    source: model.source,
                    expected: model.expectedDomain,
                    found: foundHref,
                    status: '✅ PASS'
                });
                console.log(`   ✅ ${model.id}: ${model.source} → ${model.expectedDomain} verified`);
            } else {
                report.linkVerification.push({
                    model: model.id,
                    source: model.source,
                    expected: model.expectedDomain,
                    found: foundHref,
                    status: '❌ FAIL'
                });
                report.violations.push(`❌ CRITICAL: ${model.id} (${model.source}) links to ${foundHref} instead of ${model.expectedDomain}`);
                console.log(`   ❌ ${model.id}: Expected ${model.expectedDomain} but found ${foundHref}`);
            }

        } catch (e) {
            report.linkVerification.push({
                model: model.id,
                source: model.source,
                expected: model.expectedDomain,
                found: 'ERROR',
                status: '❌ ERROR'
            });
            report.violations.push(`❌ Could not verify ${model.id}: ${e.message}`);
            console.log(`   ❌ ${model.id}: Error - ${e.message}`);
        }
    }
    console.log('');

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
    console.log('📊 SENTINEL V2 REPORT');
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
    console.log('');

    console.log('🔗 Deep Link Verification (V2 NEW):');
    report.linkVerification.forEach(v => {
        console.log(`   ${v.status} ${v.model} (${v.source}) → ${v.found}`);
    });
    console.log('');

    if (report.violations.length > 0) {
        console.log('⚠️ Violations:');
        report.violations.forEach(v => console.log(`   ${v}`));
        console.log('');
    }

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
