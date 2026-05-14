/**
 * Select vs Compare API Divergence Check
 *
 * Compares the Select API path (reads rankings-NN.db) against the Compare API
 * path (reads meta-NN.db) for the same top text-generation models.
 *
 * The two API paths surface different data sources downstream of the same
 * aggregator output. Any field that differs between the two paths reveals
 * a data-propagation gap in the factory pipeline (slim projection drop,
 * pack-db read source mismatch, or write-time field omission).
 *
 * Scope: Sciweon principle 2 — "verification, not existence". Fields that
 * exist in one path but are zero/missing in another are a quality failure
 * even if neither path errors.
 *
 * Usage:
 *   node scripts/audit/select-vs-compare-diff.js
 *   API_BASE=https://free2aitools.com node scripts/audit/select-vs-compare-diff.js
 *
 * Exit codes:
 *   0 — no field divergence detected
 *   1 — runtime error (API unreachable, malformed response)
 *   2 — divergence detected (Select OK and Compare 0, or vice versa)
 */

const API_BASE = process.env.API_BASE || 'https://free2aitools.com';
const SAMPLE_SIZE = parseInt(process.env.SAMPLE_SIZE || '20', 10);
const TASK = process.env.AUDIT_TASK || 'text-generation';

const COMPARE_FIELDS = [
    { path: 'specs.params_billions', label: 'params_billions' },
    { path: 'specs.context_length', label: 'context_length' },
    { path: 'specs.vram_estimate_gb', label: 'vram_estimate_gb' },
    { path: 'specs.license', label: 'license (str)' },
    { path: 'specs.pipeline_tag', label: 'pipeline_tag (str)' },
    { path: 'fni_factors.authority', label: 'fni_a' },
    { path: 'fni_factors.semantic', label: 'fni_s' },
    { path: 'fni_factors.popularity', label: 'fni_p' },
    { path: 'fni_factors.recency', label: 'fni_r' },
    { path: 'fni_factors.quality', label: 'fni_q' }
];

const SELECT_FIELDS = [
    { path: 'params_billions', label: 'params_billions' },
    { path: 'context_length', label: 'context_length' },
    { path: 'vram_estimate_gb', label: 'vram_estimate_gb' },
    { path: 'license', label: 'license (str)' },
    { path: 'pipeline_tag', label: 'pipeline_tag (str)' },
    { path: 'fni_factors.authority', label: 'fni_a' },
    { path: 'fni_factors.semantic', label: 'fni_s' },
    { path: 'fni_factors.popularity', label: 'fni_p' },
    { path: 'fni_factors.recency', label: 'fni_r' },
    { path: 'fni_factors.quality', label: 'fni_q' }
];

const AGENT_FIELDS = [
    { selectPath: 'ollama_compatible', comparePath: null, label: 'ollama_compatible' },
    { selectPath: 'license_type', comparePath: null, label: 'license_type' },
    { selectPath: 'can_run_local', comparePath: null, label: 'can_run_local' }
];

function getNested(obj, path) {
    if (!obj || !path) return undefined;
    return path.split('.').reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function isMeaningful(v) {
    if (v == null || v === '') return false;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'boolean') return v === true;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === 'string') return v.length > 0;
    return true;
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);
    if (!res.ok) {
        throw new Error(`[${options.method || 'GET'} ${url}] HTTP ${res.status}`);
    }
    return res.json();
}

async function main() {
    console.log(`[AUDIT] API_BASE=${API_BASE} TASK=${TASK} SAMPLE_SIZE=${SAMPLE_SIZE}`);
    console.log('[AUDIT] Step 1/3: Fetching top models from Select API ...');

    const selectResp = await fetchJson(`${API_BASE}/api/v1/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: TASK, limit: SAMPLE_SIZE, explain: false })
    });
    const recommendations = selectResp.recommendations || [];
    if (recommendations.length === 0) {
        console.error('[FAIL] Select API returned 0 recommendations');
        process.exit(1);
    }
    console.log(`[AUDIT] Got ${recommendations.length} recommendations`);

    console.log('[AUDIT] Step 2/3: Fetching same entities from Compare API ...');
    const ids = recommendations.map(r => r.model_id).slice(0, 10);
    const compareResp = await fetchJson(`${API_BASE}/api/v1/compare?ids=${encodeURIComponent(ids.join(','))}`);
    const compareEntities = (compareResp.entities || []).filter(e => e.found);
    console.log(`[AUDIT] Got ${compareEntities.length} compare entities (Compare API max ${ids.length})`);

    const idToSelect = new Map(recommendations.map(r => [r.model_id, r]));
    const idToCompare = new Map(compareEntities.map(e => [e.id, e]));

    console.log('[AUDIT] Step 3/3: Computing divergence ...\n');
    const stats = {};
    for (const field of COMPARE_FIELDS) {
        stats[field.label] = {
            select_nonzero: 0,
            compare_nonzero: 0,
            divergent: 0,
            samples: []
        };
    }

    for (const id of idToCompare.keys()) {
        const sel = idToSelect.get(id);
        const cmp = idToCompare.get(id);
        if (!sel || !cmp) continue;
        for (let i = 0; i < COMPARE_FIELDS.length; i++) {
            const sField = SELECT_FIELDS[i];
            const cField = COMPARE_FIELDS[i];
            const sVal = getNested(sel, sField.path);
            const cVal = getNested(cmp, cField.path);
            const sOk = isMeaningful(sVal);
            const cOk = isMeaningful(cVal);
            if (sOk) stats[cField.label].select_nonzero++;
            if (cOk) stats[cField.label].compare_nonzero++;
            if (sOk !== cOk) {
                stats[cField.label].divergent++;
                if (stats[cField.label].samples.length < 3) {
                    stats[cField.label].samples.push({ id, select: sVal, compare: cVal });
                }
            }
        }
    }

    const N = idToCompare.size;
    console.log(`Sample size: ${N} (Compare API capped at 10 ids per call)\n`);
    console.log('Field                  | Select OK   | Compare OK  | Divergent | Status');
    console.log('-----------------------|-------------|-------------|-----------|--------');
    let hasGap = false;
    for (const field of COMPARE_FIELDS) {
        const s = stats[field.label];
        const pctS = N === 0 ? 0 : Math.round((s.select_nonzero / N) * 100);
        const pctC = N === 0 ? 0 : Math.round((s.compare_nonzero / N) * 100);
        let status;
        if (s.divergent > 0) {
            status = 'GAP';
            hasGap = true;
        } else if (s.select_nonzero === 0 && s.compare_nonzero === 0) {
            status = 'BOTH-ZERO';
        } else {
            status = 'OK';
        }
        console.log(`${field.label.padEnd(22)} | ${String(pctS).padStart(3)}% (${String(s.select_nonzero).padStart(2)}/${N}) | ${String(pctC).padStart(3)}% (${String(s.compare_nonzero).padStart(2)}/${N}) | ${String(s.divergent).padStart(3)}/${N}    | ${status}`);
    }

    console.log('\nAgent-only fields (Compare API does not surface — checked Select-side only):');
    const agentStats = {};
    for (const f of AGENT_FIELDS) {
        agentStats[f.label] = { nonzero: 0, samples: [] };
    }
    for (const rec of recommendations) {
        for (const f of AGENT_FIELDS) {
            const v = getNested(rec, f.selectPath);
            if (isMeaningful(v)) {
                agentStats[f.label].nonzero++;
                if (agentStats[f.label].samples.length < 2) {
                    agentStats[f.label].samples.push({ id: rec.model_id, value: v });
                }
            }
        }
    }
    for (const f of AGENT_FIELDS) {
        const s = agentStats[f.label];
        const N2 = recommendations.length;
        const pct = N2 === 0 ? 0 : Math.round((s.nonzero / N2) * 100);
        console.log(`  ${f.label.padEnd(20)}: ${pct}% non-zero (${s.nonzero}/${N2})`);
    }

    console.log('\nDivergence samples (Select OK but Compare zero, or vice versa):');
    let printed = 0;
    for (const field of COMPARE_FIELDS) {
        if (stats[field.label].samples.length === 0) continue;
        console.log(`\n  ${field.label}:`);
        for (const sample of stats[field.label].samples) {
            const sStr = JSON.stringify(sample.select);
            const cStr = JSON.stringify(sample.compare);
            console.log(`    ${sample.id}: select=${sStr}  compare=${cStr}`);
            printed++;
        }
    }
    if (printed === 0) console.log('  (none)');

    console.log('\nMachine-readable summary:');
    const summary = {
        api_base: API_BASE,
        task: TASK,
        sample_size: N,
        timestamp: new Date().toISOString(),
        compare_path_fields: Object.fromEntries(COMPARE_FIELDS.map(f => [f.label, stats[f.label]])),
        select_only_fields: Object.fromEntries(AGENT_FIELDS.map(f => [f.label, agentStats[f.label]]))
    };
    console.log(JSON.stringify(summary, null, 2));

    if (hasGap) {
        console.log('\n[FAIL] Sciweon principle 2 violation: Select and Compare paths disagree on at least one field.');
        process.exit(2);
    }
    console.log('\n[PASS] No Select-vs-Compare divergence detected on sampled fields.');
    process.exit(0);
}

main().catch(err => {
    console.error('[ERROR]', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(1);
});
