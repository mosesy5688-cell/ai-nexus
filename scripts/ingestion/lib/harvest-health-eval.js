/**
 * Harvest Health — pure evaluation core (PR-H2c, observation layer).
 *
 * Split out of harvest-health.js to keep both modules under the CES Art 5.1
 * 250-line monolith ceiling. This file is PURE (no IO, no process exit): it
 * turns sidecars + step outcomes + previous-yield index into health rows, an
 * overall verdict, the markdown table and the final-line contract. The
 * orchestrator (harvest-health.js) does all IO and the defense-in-depth exit.
 *
 * RED is strictly defense-in-depth — overall 'red' (the orchestrator exits 1)
 * ONLY for an H2a-class state that escaped/masked into a green merge. Everything
 * else NEVER reds. ANTI-LYING: an EXPECTED source with no sidecar is `missing`
 * (never default green), severity LAYERED by tier. Previous-based checks are
 * COLD-START RESILIENT: unreadable history => previous_yield=null + skipped.
 * DRAFT thresholds (NOT a long-term contract): yield<50% prev, enrichment>25%,
 * freshness>7d.
 */

import { STATUS } from '../harvest-state.js';

// EXPECTED_SOURCES — hand-maintained, mirrors the harvest-single.js invocations
// in .github/workflows/factory-harvest.yml (15 sources). H2b will replace this
// with a 15-source contract; until then a drift check (::warning) flags any
// sidecar for an unlisted source. `gated` = present in harvest-floors
// DEFAULT_FLOORS (known-large, H2a floor-gated). `tier`: gated|small.
export const EXPECTED_SOURCES = Object.freeze([
    { source: 'huggingface', tier: 'gated', gated: true },
    { source: 'github', tier: 'gated', gated: true },
    { source: 'arxiv', tier: 'gated', gated: true },
    { source: 'huggingface-papers', tier: 'gated', gated: true },
    { source: 'huggingface-datasets', tier: 'gated', gated: true },
    { source: 'semanticscholar', tier: 'gated', gated: true },
    { source: 'ollama', tier: 'small', gated: false },
    { source: 'mcp', tier: 'small', gated: false },
    { source: 'replicate', tier: 'small', gated: false },
    { source: 'kaggle', tier: 'small', gated: false },
    { source: 'civitai', tier: 'small', gated: false },
    { source: 'openllm', tier: 'small', gated: false },
    { source: 'benchmark', tier: 'small', gated: false },
    { source: 'deepspec', tier: 'small', gated: false },
    { source: 'agents', tier: 'small', gated: false },
]);

export const DRAFT_YIELD_DROP = 0.5;     // DRAFT: gated yield < 50% of previous => degraded
export const DRAFT_ENRICH_RATIO = 0.25;  // DRAFT: enrichment blocked ratio > 25% => degraded
export const DRAFT_STALE_DAYS = 7;       // DRAFT: > 7 days since last yield>0 => stale

const FAILED_CLASS = new Set([STATUS.FAILED, STATUS.TIMEOUT, STATUS.RETRY_EXHAUSTED]);

// Index previous-yield + last-yielded-at from a prior latest.json. COLD-START
// RESILIENT: null/old-schema doc -> empty index -> previous-based checks skipped.
export function indexPrevious(prevDoc) {
    const prevYield = {}, lastYieldedAt = {};
    if (!prevDoc || prevDoc.schema_version !== 1 || !Array.isArray(prevDoc.sources)) {
        return { prevYield, lastYieldedAt };
    }
    for (const s of prevDoc.sources) {
        if (!s || !s.source) continue;
        if (Number.isFinite(s.yield)) prevYield[s.source] = s.yield;
        if (s.last_yielded_at) lastYieldedAt[s.source] = s.last_yielded_at;
    }
    return { prevYield, lastYieldedAt };
}

// Evaluate one EXPECTED source into a health row (pure, no IO). REINFORCEMENT 2
// (layered severity) + REINFORCEMENT 3 (cold-start) live here. stepOutcome:
// 'success'|'failure'|'cancelled'|'skipped'|null. Returns a row object.
export function evaluateSource(entry, sidecar, stepOutcome, previousYield, lastYieldedAt, now = Date.now()) {
    const notes = [];
    const row = {
        source: entry.source, tier: entry.tier, gated: entry.gated,
        status: sidecar ? sidecar.status : STATUS.MISSING,
        yield: sidecar && Number.isFinite(sidecar.yield) ? sidecar.yield : 0,
        previous_yield: Number.isFinite(previousYield) ? previousYield : null,
        freshness: 'unknown', draft: false, notes,
    };

    // ANTI-LYING (b): missing sidecar -> step outcome is the 2nd independent input.
    // gated missing => RED (absence=failure); small missing => DEGRADED never red.
    if (!sidecar) {
        if (entry.gated) {
            row.verdict = 'red';
            row.status = (stepOutcome === 'failure' || stepOutcome === 'cancelled') ? STATUS.TIMEOUT : STATUS.MISSING;
            if (row.status === STATUS.TIMEOUT) row.timeout_kind = 'step_killed';
            notes.push('gated source missing sidecar (absence=failure)');
        } else {
            row.verdict = 'degraded';
            notes.push('small source missing sidecar (degraded, not red)');
        }
        return row;
    }

    // Sidecar present. Verdict from status; RED only for H2a-class escapes.
    const st = sidecar.status;
    if (st === STATUS.FLOOR_VIOLATION) {
        row.verdict = 'red';
        notes.push('floor_violation reached merge (H2a semantics escaped)');
    } else if (entry.gated && FAILED_CLASS.has(st)) {
        row.verdict = 'red';
        notes.push(`gated ${st} reached merge (H2a-class escaped)`);
    } else if (st === STATUS.RATE_LIMITED) {
        row.verdict = 'degraded';
        notes.push('rate_limited');
    } else if (!entry.gated && FAILED_CLASS.has(st)) {
        row.verdict = 'degraded';
        notes.push(`small source ${st} (visibility, not red)`);
    } else {
        row.verdict = 'green'; // success / valid_zero / partial-by-design
    }
    if (sidecar.partial_reason === 'rate_limit_early_finish' && row.verdict === 'green') {
        row.verdict = 'degraded';
        notes.push('partial rate_limit_early_finish');
    }

    // Freshness (gated only, DRAFT). stale = days since last yield>0 record > 7.
    if (entry.gated && lastYieldedAt) {
        const ageDays = (now - Date.parse(lastYieldedAt)) / 86400000;
        if (Number.isFinite(ageDays)) {
            row.freshness = ageDays > DRAFT_STALE_DAYS ? 'stale' : 'fresh';
            if (row.freshness === 'stale' && row.verdict === 'green') {
                row.verdict = 'degraded'; row.draft = true;
                notes.push(`freshness stale >${DRAFT_STALE_DAYS}d (DRAFT)`);
            }
        }
    }

    // DRAFT: gated yield < 50% of previous despite passing floor => degraded (DRAFT).
    if (entry.gated && Number.isFinite(previousYield) && previousYield > 0 && row.verdict === 'green') {
        if (row.yield < previousYield * DRAFT_YIELD_DROP) {
            row.verdict = 'degraded'; row.draft = true;
            notes.push(`yield ${row.yield} < 50% prev ${previousYield} (DRAFT)`);
        }
    }
    return row;
}

// Evaluate the params-backfill enrichment record. Can pull DEGRADED above 25%
// (DRAFT) but NEVER red. Missing record => degraded note, never red.
export function evaluateEnrichment(rec) {
    if (!rec) return { name: 'params-backfill', present: false, verdict: 'degraded', note: 'enrichment record missing (note, not red)' };
    const ratio = Number.isFinite(rec.ratio) ? rec.ratio : 0;
    const over = ratio > DRAFT_ENRICH_RATIO;
    return {
        name: rec.name || 'params-backfill', present: true,
        fetched: rec.fetched, blocked: rec.blocked, ratio,
        verdict: over ? 'degraded' : 'green', draft: over,
        note: over ? `blocked ratio ${(ratio * 100).toFixed(1)}% > 25% (DRAFT)` : null,
    };
}

// Fold rows + enrichment into overall verdict. RED wins (exit 1), else DEGRADED,
// else GREEN. Enrichment can only contribute degraded.
export function rollUp(rows, enrichment) {
    let red = false, degraded = false;
    for (const r of rows) {
        if (r.verdict === 'red') red = true;
        else if (r.verdict === 'degraded') degraded = true;
    }
    if (enrichment && enrichment.verdict === 'degraded') degraded = true;
    return red ? 'red' : (degraded ? 'degraded' : 'green');
}

/** Render the fixed `HARVEST SOURCE HEALTH` markdown table. */
export function renderTable(rows, enrichment, overall) {
    const verdictIcon = { green: 'OK', degraded: 'WARN', red: 'FAIL' };
    const lines = [
        '## HARVEST SOURCE HEALTH',
        '',
        `Overall: **${overall.toUpperCase()}**`,
        '',
        '| Source | Tier | Status | Yield | Prev | Freshness | Verdict | Notes |',
        '|--------|------|--------|-------|------|-----------|---------|-------|',
    ];
    for (const r of rows) {
        const prev = r.previous_yield == null ? '-' : r.previous_yield;
        const note = (r.notes && r.notes.length) ? r.notes.join('; ') : '';
        lines.push(`| ${r.source} | ${r.tier} | ${r.status} | ${r.yield} | ${prev} | ${r.freshness} | ${verdictIcon[r.verdict] || r.verdict} | ${note} |`);
    }
    lines.push('');
    lines.push('### Enrichment');
    if (enrichment && enrichment.present) {
        lines.push(`- params-backfill: blocked ratio ${(enrichment.ratio * 100).toFixed(1)}% (${verdictIcon[enrichment.verdict]})${enrichment.note ? ' - ' + enrichment.note : ''}`);
    } else {
        lines.push(`- params-backfill: ${enrichment ? enrichment.note : 'no record'}`);
    }
    lines.push('');
    return lines.join('\n');
}

/** Build the FINAL LINE per the contract (replaces "Complete | Total: X"). */
export function finalLine(overall, rows) {
    const healthy = rows.filter(r => r.verdict === 'green').length;
    if (overall === 'green') return `HARVEST_HEALTH=green | Complete | ${healthy}/${rows.length} sources healthy`;
    if (overall === 'degraded') {
        const list = rows.filter(r => r.verdict === 'degraded').map(r => r.source).join(', ') || '(enrichment)';
        return `HARVEST_HEALTH=degraded | Complete with degraded sources: ${list}`;
    }
    const reasons = rows.filter(r => r.verdict === 'red').map(r => `${r.source}:${r.status}`).join(', ');
    return `HARVEST_HEALTH=red | Failed: ${reasons}`;
}
