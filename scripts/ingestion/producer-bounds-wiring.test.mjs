// FINDING-GR-1 / D-2026-0809-416: LIVE-PATH WIRING pins (static).
//
// The repo has a history of no-op fixes landed on dead paths, so this suite
// asserts that the code changed by PR-GR-A is the code the cron actually runs:
//   .github/workflows/factory-harvest.yml -> scripts/ingestion/harvest-single.js
//   harvest-single.js -> adapter.normalize() -> emitNormalizedRecord()
//   producer-emitter.js -> assertEmittedLineBytes() CALL before the write
//   harvest-single.js -> rethrow + adapter-agnostic breach promotion (D1/D3)
//   kaggle-adapter.js -> applyFieldContracts() BEFORE generateContentHash()
// The BEHAVIOURAL end-to-end runs live in producer-escalation.test.mjs (this
// file was split at the 250-line CES bound; .mjs is not scanned by CES but is
// held to the same standard).
//
// HERMETIC: reads source text only. No network, no credentials, no R2.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');

test('W1 workflow -> harvest-single.js is the Kaggle entry point (live path)', () => {
    const wf = read(path.join(ROOT, '.github', 'workflows', 'factory-harvest.yml'));
    assert.ok(wf.includes('node scripts/ingestion/harvest-single.js kaggle'),
        'factory-harvest.yml must invoke harvest-single.js for kaggle');
});

test('W2 harvest-single.js emits ONLY through the guarded emitter', () => {
    const src = read(path.join(HERE, 'harvest-single.js'));
    assert.ok(src.includes('emitNormalizedRecord(norm, writeStream, bounds, options._bounds)'),
        'the normalise->emit chokepoint must go through emitNormalizedRecord');
    assert.equal(src.includes('writeStream.write(JSON.stringify'), false,
        'no unguarded serialise-and-write bypass may remain');
    assert.ok(src.includes('producer_bounds: pb'), 'counters must ride the terminal state');
});

test('W2b the emitter CALLS the assertion (call-site pin, not just behaviour)', () => {
    // REQUIRED-F1(i): deleting the assertEmittedLineBytes(...) CALL from the emit
    // path previously left every suite green -- the behavioural tests only proved
    // that the function throws when invoked, never that the producer invokes it.
    const src = read(path.join(HERE, 'lib', 'producer-emitter.js'));
    // Scope the pin to the emitter's own body: `assertEmittedLineBytes(line` also
    // matches the function's own DECLARATION, so an unscoped substring check would
    // survive deletion of the call. Slice from the emitter signature onward.
    const at = src.indexOf('export async function emitNormalizedRecord(');
    assert.ok(at > 0, 'emitNormalizedRecord must exist');
    const body = src.slice(at);
    assert.ok(/assertEmittedLineBytes\(line,\s*\{/.test(body),
        'emitNormalizedRecord must CALL assertEmittedLineBytes on the emitted line');
    assert.ok(body.indexOf('writeStream.write(line)') > body.search(/assertEmittedLineBytes\(line,\s*\{/),
        'the assertion must run BEFORE the write, not after it');
});

test('W2c harvest-single.js escalates the producer-line terminal (no failed++ laundering)', () => {
    // REQUIRED-F2(i): the per-record catch must rethrow the typed terminal.
    const src = read(path.join(HERE, 'harvest-single.js'));
    assert.ok(src.includes('if (e && e.code === PRODUCER_LINE_TERMINAL) throw e;'),
        'the per-record catch must rethrow the producer-line terminal');
    assert.ok(src.includes('terminal_meta: { producer_bounds: producerBoundSummary() }'),
        'the top-level catch must still publish the producer-bound counters');
    // D1: the rethrow alone is not enough -- adapters swallow it. The promotion of
    // the RECORDED breach after fetch() is what makes escalation adapter-agnostic.
    assert.ok(src.includes('const lineBreach = bounds.producer_line_breach || null;'),
        'the harvester must read the recorded breach after fetch() returns');
    assert.ok(src.includes('if (lineBreach && !fetchHardError) fetchHardError ='),
        'a recorded breach must be promoted onto the hard-failure path');
    // N1 (D-2026-0810-418): the D3 exemption belongs to the breach that is the
    // SOLE cause, so the label must read the PROMOTION decision, not the mere
    // presence of a breach. The capture must also precede the promotion, or it
    // would observe the already-mutated fetchHardError and always be false.
    assert.ok(src.includes('const breachPromoted = Boolean(lineBreach) && !fetchHardError;'),
        'the promotion decision must be captured before fetchHardError is mutated');
    assert.ok(src.indexOf('const breachPromoted =') < src.indexOf('if (lineBreach && !fetchHardError) fetchHardError ='),
        'breachPromoted must be captured BEFORE the promotion line, not after it');
    assert.ok(src.includes('had_adapter_error: !breachPromoted'),
        'a SOLE producer-emission breach must NOT be reported as an adapter error (D3), but a compound failure must (N1)');
    assert.equal(src.includes('had_adapter_error: !lineBreach'), false,
        'the pre-N1 label must not survive: it mislabels the compound case');
});

test('W3 kaggle-adapter.js applies the contract BEFORE content_hash', () => {
    const src = read(path.join(HERE, 'adapters', 'kaggle-adapter.js'));
    assert.ok(src.includes("from '../lib/field-contract-enforcer.js'"));
    const applies = [...src.matchAll(/applyFieldContracts\(entity\);/g)];
    assert.equal(applies.length, 2, 'both normalizeDataset and normalizeModel must be governed');
    for (const m of applies) {
        const after = src.slice(m.index);
        const hashAt = after.indexOf('this.generateContentHash(entity)');
        assert.ok(hashAt > 0, 'content_hash must be computed AFTER the contract is applied');
    }
});

