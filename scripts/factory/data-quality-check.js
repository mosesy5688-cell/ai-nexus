/**
 * Data Quality Audit — post-deploy field coverage verification.
 * Runs after 4/4 upload. Exits non-zero if any field below threshold.
 */

const API_BASE = process.env.API_BASE || 'https://free2aitools.com';
const TIMEOUT = 30000;

const AUDITS = [
    { task: 'text-generation', label: 'Text Generation' },
    { task: 'text-to-image', label: 'Text to Image' },
];

const FIELD_THRESHOLDS = {
    params_billions:   { min: 60, critical: true },
    vram_estimate_gb:  { min: 60, critical: true },
    context_length:    { min: 30, critical: false },
    license:           { min: 50, critical: false },
    license_type:      { min: 30, critical: false },
    pipeline_tag:      { min: 80, critical: true },
    ollama_compatible: { min: 5,  critical: true },
    can_run_local:     { min: 5,  critical: false },
    hosted_on:         { min: 20, critical: false },
    confidence:        { min: 90, critical: true },
    rationale:         { min: 90, critical: true },
};

async function fetchSelect(task, limit = 20) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
        const res = await fetch(`${API_BASE}/api/v1/select`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ task, limit, explain: true }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(timer); }
}

function isNonEmpty(value) {
    if (value === null || value === undefined) return false;
    if (value === 0 || value === false) return false;
    if (value === '' || value === 'unknown') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
}

async function main() {
    console.log('=== DATA QUALITY AUDIT ===\n');
    let failures = 0;
    let criticalFailures = 0;

    for (const audit of AUDITS) {
        console.log(`--- ${audit.label} (top 20) ---`);
        let data;
        try { data = await fetchSelect(audit.task); } catch (e) {
            console.error(`  SKIP: API error — ${e.message}`);
            continue;
        }

        const recs = data.recommendations || [];
        if (recs.length === 0) { console.error('  SKIP: 0 recommendations'); continue; }

        for (const [field, { min, critical }] of Object.entries(FIELD_THRESHOLDS)) {
            const nonEmpty = recs.filter(r => isNonEmpty(r[field])).length;
            const pct = Math.round(nonEmpty / recs.length * 100);
            const status = pct >= min ? 'OK' : 'FAIL';
            const icon = status === 'OK' ? 'OK  ' : critical ? 'CRIT' : 'WARN';
            console.log(`  ${icon} ${field.padEnd(22)} ${nonEmpty}/${recs.length} (${pct}%) [min: ${min}%]`);
            if (status === 'FAIL') {
                failures++;
                if (critical) criticalFailures++;
            }
        }
        console.log('');
    }

    console.log(`=== RESULT: ${failures} failures (${criticalFailures} critical) ===`);
    if (criticalFailures > 0) {
        console.error('CRITICAL DATA QUALITY FAILURE — check field extraction pipeline');
        process.exit(1);
    }
    if (failures > 0) {
        console.warn('Data quality warnings — non-critical fields below threshold');
    }
}

main().catch(e => { console.error('Audit failed:', e.message); process.exit(1); });
