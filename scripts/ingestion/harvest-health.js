/**
 * Harvest Health Aggregator (PR-H2c, observation layer) — orchestrator.
 *
 * Runs once in merge-and-upload (after Merge Batches). Reads per-source
 * terminal-state sidecars from the 4 harvest jobs, cross-checks workflow step
 * outcomes + prior R2 latest.json, and renders an HONEST `HARVEST SOURCE HEALTH`
 * table replacing the FAKE "Source Breakdown" (which was keyed by raw_batch
 * shard, not source). Pure evaluation lives in lib/harvest-health-eval.js; this
 * file is IO + the defense-in-depth exit only (CES Art 5.1 split).
 *
 * RED is strictly defense-in-depth — exit 1 ONLY for an H2a-class state that
 * escaped/masked into a green merge. Everything else NEVER exits 1. A crash in
 * this OBSERVATION layer must NOT redden the merge (no-new-gates boundary).
 * DRAFT thresholds (NOT a long-term contract): yield<50% prev, enrichment>25%,
 * freshness>7d. H2a (floor gate / arXiv spin / SS de-mask) stays bit-identical.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
    EXPECTED_SOURCES, indexPrevious, evaluateSource, evaluateEnrichment,
    rollUp, renderTable, finalLine,
} from './lib/harvest-health-eval.js';

const STATE_DIR = path.join('data', 'state');

/** Read + parse a JSON file, returning null on any failure (never throws). */
export function readJsonSafe(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
    catch { return null; }
}

/** Load all terminal-state sidecars from data/state, keyed by source. */
export function loadSidecars(dir = STATE_DIR) {
    const map = {};
    let files = [];
    try { files = fs.readdirSync(dir).filter(f => /^harvest-state-.+\.json$/.test(f)); }
    catch { return map; }
    for (const f of files) {
        const sc = readJsonSafe(path.join(dir, f));
        if (sc && sc.source) map[sc.source] = sc;
    }
    return map;
}

// Step-outcome map from STEP_OUTCOMES_JSON env (workflow JSON {source: outcome}).
function loadStepOutcomes() {
    const raw = process.env.STEP_OUTCOMES_JSON;
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

/** Drift check (::warning): a sidecar exists for a source not in EXPECTED_SOURCES. */
function driftCheck(sidecars) {
    const expected = new Set(EXPECTED_SOURCES.map(e => e.source));
    for (const s of Object.keys(sidecars)) {
        if (!expected.has(s)) console.warn(`::warning::harvest-health drift: sidecar for unlisted source '${s}' (update EXPECTED_SOURCES)`);
    }
}

/** Minimal manifest-vs-terminal consistency assert (::warning on mismatch). */
function manifestAssert(manifest, rows) {
    if (!manifest || !Number.isFinite(manifest.total_entities)) return;
    const anyYield = rows.some(r => r.yield > 0);
    if (manifest.total_entities > 0 && !anyYield) {
        console.warn('::warning::harvest-health: manifest reports entities but no source sidecar carries yield>0 (terminal-state inconsistency)');
    }
}

/** Build the aggregated R2 doc. last_yielded_at carries forward freshness history. */
export function buildDoc(overall, rows, enrichment, prevLastYieldedAt, ts) {
    const nowIso = new Date(ts).toISOString();
    return {
        schema_version: 1, run_id: process.env.GITHUB_RUN_ID || 'local', timestamp: nowIso,
        harvest_health: overall,
        sources: rows.map(r => ({
            source: r.source, tier: r.tier, gated: r.gated, status: r.status,
            yield: r.yield, previous_yield: r.previous_yield, freshness: r.freshness,
            verdict: r.verdict, draft: r.draft,
            // Carry-forward: last time this source yielded>0 (for next run's freshness).
            last_yielded_at: r.yield > 0 ? nowIso : (prevLastYieldedAt[r.source] || null),
        })),
        enrichment: enrichment ? [enrichment] : [],
        final_line: finalLine(overall, rows),
    };
}

async function main() {
    const ts = Date.now();
    const sidecars = loadSidecars();
    driftCheck(sidecars);
    const stepOutcomes = loadStepOutcomes();
    const prevDoc = readJsonSafe(process.env.PREV_HEALTH_PATH || path.join(STATE_DIR, 'prev-latest.json'));
    const { prevYield, lastYieldedAt } = indexPrevious(prevDoc);
    const enrichRec = readJsonSafe(path.join(STATE_DIR, 'enrichment-params-backfill.json'));
    const manifest = readJsonSafe(path.join('data', 'manifest.json'));

    const rows = EXPECTED_SOURCES.map(e => evaluateSource(
        e, sidecars[e.source] || null, stepOutcomes[e.source] || null,
        prevYield[e.source], lastYieldedAt[e.source], ts,
    ));
    const enrichment = evaluateEnrichment(enrichRec);
    const overall = rollUp(rows, enrichment);
    manifestAssert(manifest, rows);

    const table = renderTable(rows, enrichment, overall);
    const line = finalLine(overall, rows);
    console.log(table);
    console.log(line);

    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, '\n' + table + '\n' + line + '\n');
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `HARVEST_HEALTH=${overall}\n`);

    // Write the aggregated doc for the workflow's R2 upload step.
    const doc = buildDoc(overall, rows, enrichment, lastYieldedAt, ts);
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(path.join(STATE_DIR, 'harvest-health-latest.json'), JSON.stringify(doc, null, 2));
    } catch (e) {
        console.warn(`::warning::harvest-health: failed to write aggregated doc: ${e.message}`);
    }

    // RED = defense-in-depth only. exit 1 reddens the merge; all else exits 0.
    if (overall === 'red') {
        console.error('::error::HARVEST_HEALTH=red - a gated/H2a-class source escaped into a green merge');
        process.exit(1);
    }
}

if (process.argv[1]?.endsWith('harvest-health.js')) {
    main().catch((err) => {
        // A crash in the OBSERVATION layer must not redden the merge (no-new-gates).
        console.warn(`::warning::harvest-health aggregator crashed (observation-only, not failing merge): ${err && err.stack ? err.stack : err}`);
    });
}

export { STATE_DIR, loadStepOutcomes };
// Re-export the eval surface so existing import sites + tests can use one entry.
export {
    EXPECTED_SOURCES, indexPrevious, evaluateSource, evaluateEnrichment,
    rollUp, renderTable, finalLine, DRAFT_YIELD_DROP, DRAFT_ENRICH_RATIO, DRAFT_STALE_DAYS,
} from './lib/harvest-health-eval.js';
