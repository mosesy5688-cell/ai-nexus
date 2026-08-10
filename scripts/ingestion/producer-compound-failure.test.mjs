// N1 (ruling D-2026-0810-418): COMPOUND-FAILURE LABELLING in harvest-single.js.
//
// THE DEFECT. D3 exempts a producer-emission breach from `had_adapter_error`,
// because a record the PRODUCER refused to emit is not the adapter failing. The
// pre-N1 code expressed that as `had_adapter_error: !lineBreach` -- it read the
// mere PRESENCE of a breach. But a breach is only the cause when it is the SOLE
// cause: the promotion at the top of that block is guarded by `!fetchHardError`,
// so when the source ALSO failed for real, the breach is NOT promoted and the
// adapter/fetch error is the true terminal cause. `!lineBreach` reported that
// compound case as "not an adapter error", hiding a genuine adapter failure
// from the terminal sidecar and from harvest health.
//
// N1 captures the PROMOTION DECISION instead:
//     const breachPromoted = Boolean(lineBreach) && !fetchHardError;   // before promotion
//     had_adapter_error: !breachPromoted
//
// This file is separate from producer-escalation.test.mjs only because that
// file is at the 250-line bound. Same discipline: the REAL harvestSingle(), an
// injected adapter, a throwaway cwd, no network / credentials / R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harvestSingle } from './harvest-single.js';

const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const sidecarOf = () => JSON.parse(read(path.join('data', 'state', 'harvest-state-kaggle.json')));

/**
 * COMPOUND fixture: the emitter records a real breach (the record exceeds the
 * injected line bound and the harvester's rethrow is swallowed by the adapter's
 * catch-all, exactly as all 15 live adapters do), and THEN the source itself
 * fails independently. Both failures are real and simultaneous.
 */
function compoundFailureAdapter(records, sourceError) {
    return {
        entityTypes: ['dataset'],
        fetch: async ({ onBatch }) => {
            try {
                await onBatch(records);
            } catch (error) {
                console.error(`   [fixture] swallowed: ${error.message}`);
            }
            throw sourceError;
        },
        normalize: (r) => r,
    };
}

/** Run one fixture inside a throwaway cwd and hand back the sidecar + result. */
async function inTemp(prefix, fn) {
    const cwd = process.cwd();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    process.chdir(tmp);
    try {
        return await fn();
    } finally {
        process.chdir(cwd);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

test('N1 compound: a real source failure ALONGSIDE a breach is reported AS an adapter error', async () => {
    await inTemp('n1c-', async () => {
        const record = { id: 'kaggle-dataset--synthetic--compound', source: 'kaggle', type: 'dataset' };
        const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');
        const sourceError = new Error('upstream 503 from the source API');

        const res = await harvestSingle('kaggle', {
            limit: 10, skipBridge: true,
            _adapter: compoundFailureAdapter([record], sourceError),
            _bounds: { screenMaxBytes: bytes * 2, lineMaxBytes: bytes - 1 },
        });

        const sidecar = sidecarOf();
        assert.equal(sidecar.status, 'failed', 'a compound failure is still a failure');

        // The breach really was recorded -- otherwise this test would be vacuous
        // and would pass for the wrong reason under the pre-N1 code too.
        const breach = sidecar.terminal_meta.producer_bounds.producer_line_breach;
        assert.ok(breach, 'the fixture must actually record a producer-line breach');
        assert.equal(breach.id, 'kaggle-dataset--synthetic--compound');

        // THE N1 ASSERTION. Pre-N1 (`!lineBreach`) this is false -> RED.
        assert.equal(sidecar.had_adapter_error, true,
            'a genuine source failure must NOT be laundered into "not an adapter error" by a co-occurring breach');

        // The TRUE cause must be the one surfaced: the breach was never promoted,
        // so the terminal message is the source error, not the producer terminal.
        assert.equal(String(res.error), 'upstream 503 from the source API');
        assert.equal(sidecar.errors[0], 'upstream 503 from the source API');
    });
});

test('N1 control A: a SOLE breach keeps its D3 exemption (had_adapter_error=false)', async () => {
    await inTemp('n1a-', async () => {
        const record = { id: 'kaggle-dataset--synthetic--sole-breach', source: 'kaggle', type: 'dataset' };
        const bytes = Buffer.byteLength(JSON.stringify(record), 'utf8');

        // Same fixture shape, but the source does NOT fail: fetch() returns
        // cleanly, so the breach is the sole cause and IS promoted.
        const adapter = {
            entityTypes: ['dataset'],
            fetch: async ({ onBatch }) => {
                try { await onBatch([record]); } catch { /* adapter catch-all */ }
                return [];
            },
            normalize: (r) => r,
        };

        const res = await harvestSingle('kaggle', {
            limit: 10, skipBridge: true, _adapter: adapter,
            _bounds: { screenMaxBytes: bytes * 2, lineMaxBytes: bytes - 1 },
        });

        const sidecar = sidecarOf();
        assert.equal(sidecar.status, 'failed');
        assert.equal(sidecar.had_adapter_error, false,
            'D3 must survive N1: a breach that is the SOLE cause is still not an adapter error');
        assert.match(String(res.error), /PRODUCER_LINE_BYTES_LIMIT_EXCEEDED/,
            'the promoted terminal must be the producer-line terminal');
    });
});

test('N1 control B: a source failure with NO breach is an adapter error (unchanged)', async () => {
    await inTemp('n1b-', async () => {
        const record = { id: 'kaggle-dataset--synthetic--clean', source: 'kaggle', type: 'dataset' };
        const sourceError = new Error('upstream 500, no breach involved');

        const res = await harvestSingle('kaggle', {
            limit: 10, skipBridge: true,
            _adapter: compoundFailureAdapter([record], sourceError),
        });

        const sidecar = sidecarOf();
        assert.equal(sidecar.status, 'failed');
        assert.equal(sidecar.terminal_meta.producer_bounds.producer_line_breach, null,
            'control must carry no breach');
        assert.equal(sidecar.had_adapter_error, true);
        assert.equal(String(res.error), 'upstream 500, no breach involved');
    });
});
