// FINDING-GR-1 / D-2026-0809-416: PRODUCER-BOUND ESCALATION, end to end.
//
// Split out of producer-bounds-wiring.test.mjs at the 250-line CES bound. Every
// test here drives the REAL harvestSingle() with an injected adapter, so it
// covers the harvester half AND the adapter half of the path.
//
// TERMINAL-STATE SCOPE (honest claim): a breach produces `sidecar.status=failed`
// plus a distinct `producer_line_breach` marker, surfaced through harvest health.
// It does NOT make the GHA step red -- factory-harvest.yml:345 runs kaggle with
// `|| echo "Kaggle adapter skipped"` (pre-existing, out of scope for this PR).
//
// HERMETIC: synthetic records, throwaway cwd, no network/credentials/R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harvestSingle } from './harvest-single.js';
import { PRODUCER_LINE_MAX_BYTES, QUARANTINE_REASON } from './lib/field-contracts.js';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('W4 end-to-end: giant record quarantined, conforming record emitted, both disclosed', async () => {
    const cwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grw-'));
    process.chdir(tmp);
    try {
        const giant = {
            id: 'kaggle-dataset--synthetic--giant', source: 'kaggle', type: 'dataset',
            body_content: 'q'.repeat(PRODUCER_LINE_MAX_BYTES),
        };
        const small = { id: 'kaggle-dataset--synthetic--small', source: 'kaggle', type: 'dataset' };
        const adapter = {
            entityTypes: ['dataset'],
            fetch: async ({ onBatch }) => { await onBatch([giant, small]); return []; },
            normalize: (r) => r,
        };

        const res = await harvestSingle('kaggle', { limit: 10, skipBridge: true, _adapter: adapter });

        assert.equal(res.error, undefined, 'a quarantine is a disposition, not a harvest failure');
        assert.equal(res.count, 1, 'only the conforming record is counted as harvested');

        const lines = fs.readFileSync(path.join('data', 'kaggle_master.ndjson'), 'utf8')
            .split('\n').filter(Boolean);
        assert.equal(lines.length, 1);
        assert.equal(JSON.parse(lines[0]).id, 'kaggle-dataset--synthetic--small');

        const sidecar = JSON.parse(read(path.join('data', 'state', 'harvest-state-kaggle.json')));
        const pb = sidecar.terminal_meta.producer_bounds;
        assert.equal(pb.records_quarantined, 1);
        assert.equal(pb.producer_line_max_bytes, PRODUCER_LINE_MAX_BYTES);

        const manifest = JSON.parse(read(path.join('data', 'state', 'harvest-quarantine-kaggle.json')));
        assert.equal(manifest.quarantined, 1);
        assert.equal(manifest.records[0].id, 'kaggle-dataset--synthetic--giant');
        assert.equal(manifest.records[0].reason, QUARANTINE_REASON.RECORD_BYTES_OVER_PRODUCER_BOUND);
    } finally {
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

/**
 * The REAL adapter shape. Copied verbatim from kaggle-adapter.js fetchDatasets
 * (lines 141-149) / fetchModels (236-246): `await onBatch(...)` inside a
 * catch-ALL that logs, `break`s, and lets fetch() return cleanly. All 15 live
 * adapters share it. A rethrow from the harvester DIES here -- which is why the
 * escalation cannot depend on the exception surviving the adapter.
 */
function realCatchShapeAdapter(records) {
    return {
        entityTypes: ['dataset'],
        fetch: async ({ onBatch }) => {
            let page = 1;
            while (true) {
                try {
                    if (page > 1) break;
                    await onBatch(records);
                    page++;
                } catch (error) {
                    console.error(`   [fixture] Error: ${error.message}`);
                    break;
                }
            }
            return [];
        },
        normalize: (r) => r,
    };
}

test('W6 REAL adapter catch shape: a swallowed breach still lands status=failed + marker', async () => {
    // BLOCKING D1. W5 used a naked adapter and was structurally blind to the
    // adapter half: with the real catch-all the rethrow is swallowed, fetch()
    // returns [] and the run previously ended a GREEN valid_zero.
    const cwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grw6-'));
    process.chdir(tmp);
    try {
        const record = { id: 'kaggle-dataset--synthetic--swallowed', source: 'kaggle', type: 'dataset' };
        const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');

        const res = await harvestSingle('kaggle', {
            limit: 10, skipBridge: true, _adapter: realCatchShapeAdapter([record]),
            _bounds: { screenMaxBytes: bytes * 2, lineMaxBytes: bytes - 1 },
        });

        assert.match(String(res.error), /PRODUCER_LINE_BYTES_LIMIT_EXCEEDED/);
        const sidecar = JSON.parse(read(path.join('data', 'state', 'harvest-state-kaggle.json')));
        assert.equal(sidecar.status, 'failed', 'must NOT end as a green valid_zero');
        const breach = sidecar.terminal_meta.producer_bounds.producer_line_breach;
        assert.equal(breach.code, 'PRODUCER_LINE_BYTES_LIMIT_EXCEEDED');
        assert.equal(breach.id, 'kaggle-dataset--synthetic--swallowed');
        assert.equal(breach.source, 'kaggle');
        assert.equal(breach.max_bytes, bytes - 1);
        assert.ok(breach.line_bytes > breach.max_bytes);
        assert.equal(sidecar.had_adapter_error, false,
            'D3: a producer-emission breach is NOT an adapter error');
    } finally {
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('W6b A/B control: the same fixture WITHOUT a breach stays green (non-vacuity)', async () => {
    const cwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grw6b-'));
    process.chdir(tmp);
    try {
        const record = { id: 'kaggle-dataset--synthetic--ok', source: 'kaggle', type: 'dataset' };
        const res = await harvestSingle('kaggle', {
            limit: 10, skipBridge: true, _adapter: realCatchShapeAdapter([record]),
        });

        assert.equal(res.error, undefined);
        const sidecar = JSON.parse(read(path.join('data', 'state', 'harvest-state-kaggle.json')));
        assert.equal(sidecar.status, 'success');
        assert.equal(sidecar.terminal_meta.producer_bounds.producer_line_breach, null);
    } finally {
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('W7 top-level catch also publishes the counters (buffered-adapter breach path)', async () => {
    // D2 (advisory, closed): a non-streaming adapter returns its batch, which the
    // harvester feeds through processBatch OUTSIDE the fetch try/catch. A breach
    // there reaches the TOP-LEVEL catch -- the path previously pinned only by a
    // source grep. Behavioural coverage now.
    const cwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grw7-'));
    process.chdir(tmp);
    try {
        const record = { id: 'kaggle-dataset--synthetic--buffered', source: 'kaggle', type: 'dataset' };
        const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
        const adapter = { entityTypes: ['dataset'], fetch: async () => [record], normalize: (r) => r };

        const res = await harvestSingle('kaggle', {
            limit: 10, skipBridge: true, _adapter: adapter,
            _bounds: { screenMaxBytes: bytes * 2, lineMaxBytes: bytes - 1 },
        });

        assert.match(String(res.error), /PRODUCER_LINE_BYTES_LIMIT_EXCEEDED/);
        const sidecar = JSON.parse(read(path.join('data', 'state', 'harvest-state-kaggle.json')));
        assert.equal(sidecar.status, 'failed');
        assert.equal(sidecar.terminal_meta.producer_bounds.producer_line_breach.code,
            'PRODUCER_LINE_BYTES_LIMIT_EXCEEDED');
    } finally {
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('W5 naked adapter: a breach lands a FAILED terminal, not a per-record failed++', async () => {
    // REQUIRED-F2. A record that clears the quarantine screen but breaches the
    // emitted-line assertion must escalate out of the per-record catch and produce
    // result.error + a FAILED sidecar. NOTE: this is a TERMINAL-STATE claim, not a
    // step-outcome claim -- factory-harvest.yml:345 runs kaggle with
    // `|| echo "Kaggle adapter skipped"`, so the GHA step cannot go red
    // (pre-existing, out of scope here). The honest surface is the sidecar status
    // + the distinct breach marker, read by harvest health.
    const cwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grw5-'));
    process.chdir(tmp);
    try {
        const record = { id: 'kaggle-dataset--synthetic--breach', source: 'kaggle', type: 'dataset' };
        const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
        const adapter = {
            entityTypes: ['dataset'],
            fetch: async ({ onBatch }) => { await onBatch([record]); return []; },
            normalize: (r) => r,
        };

        const res = await harvestSingle('kaggle', {
            limit: 10, skipBridge: true, _adapter: adapter,
            _bounds: { screenMaxBytes: bytes * 2, lineMaxBytes: bytes - 1 },
        });

        assert.match(String(res.error), /PRODUCER_LINE_BYTES_LIMIT_EXCEEDED/,
            'must surface the named terminal, not report a green zero');
        assert.equal(res.count, 0);

        const sidecar = JSON.parse(read(path.join('data', 'state', 'harvest-state-kaggle.json')));
        assert.equal(sidecar.status, 'failed');
        assert.match(sidecar.errors[0], /PRODUCER_LINE_BYTES_LIMIT_EXCEEDED/);
        assert.equal(typeof sidecar.terminal_meta.producer_bounds.producer_line_max_bytes, 'number');
    } finally {
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
