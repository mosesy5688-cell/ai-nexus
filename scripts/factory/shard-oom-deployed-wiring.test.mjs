// D-2026-0806-404 GAP 5: bind the R2a pin to the DEPLOYED path.
// This test executes the PRODUCTION scripts/factory/shard-processor.js entry -
// not a reimplementation - and then re-executes a SCRATCH COPY of that same file
// with the R2a ceiling neutered, proving the assertion is falsifiable through the
// deployed wiring. This is the M8.e / F-1 lesson: a pin that never touches the
// shipped code path can pass while the property it claims to protect is gone.
//
// Hermetic: synthetic shard written to a temp cwd; no network, no credentials,
// no real shard data. The scratch mutant lives beside the original only so its
// relative ./lib/ imports resolve, and is removed in a finally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_RECORD_BYTES, RECORD_SIZE_TERMINAL } from './lib/ndjson-byte-reader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROD = path.join(HERE, 'shard-processor.js');

/** Build a temp cwd holding one synthetic shard with an oversize record. */
function makeCwd(oversizeBytes) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oomdw-'));
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    const fh = fs.openSync(path.join(dir, 'cache', 'merged_shard_0.json.zst'), 'w');
    fs.writeSync(fh, JSON.stringify({ id: 'hf:a/b', type: 'model' }) + '\n');
    // Stream the oversize record so the fixture never sits in the test's heap.
    const block = Buffer.alloc(1024 * 1024, 0x79);
    let written = 0;
    while (written < oversizeBytes) {
        const n = Math.min(block.length, oversizeBytes - written);
        fs.writeSync(fh, block, 0, n);
        written += n;
    }
    fs.writeSync(fh, '\n' + JSON.stringify({ id: 'hf:c/d', type: 'model' }) + '\n');
    fs.closeSync(fh);
    return dir;
}

function run(script, cwd) {
    try {
        const out = execFileSync(process.execPath, [script, '--shard=0', '--total=20'], {
            cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CACHE_DIR: './cache' }, timeout: 300000,
        });
        return { status: 0, out, err: '' };
    } catch (e) {
        return { status: e.status ?? -1, out: e.stdout || '', err: e.stderr || '' };
    }
}

test('GAP-5 DEPLOYED: production shard-processor.js fails closed on an oversize record', () => {
    const cwd = makeCwd(MAX_RECORD_BYTES + 1);
    try {
        const r = run(PROD, cwd);
        assert.notEqual(r.status, 0, 'the production entry MUST exit non-zero');
        const all = r.out + r.err;
        assert.ok(all.includes(RECORD_SIZE_TERMINAL), `named terminal ${RECORD_SIZE_TERMINAL} must appear; got: ${all.slice(-500)}`);
        assert.ok(all.includes(`ceilingBytes=${MAX_RECORD_BYTES}`), 'the configured ceiling must be reported');
        assert.equal(/yyyyyyyyyy/.test(all), false, 'record CONTENT must never be logged');
        assert.equal(fs.existsSync(path.join(cwd, 'artifacts', 'shard-0.json.zst')), false,
            'no shard artifact may be emitted after a ceiling breach');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('GAP-5 MUTATION: neutering the R2a ceiling INSIDE shard-processor.js turns the pin RED', () => {
    const original = fs.readFileSync(PROD, 'utf8');
    const mutantPath = path.join(HERE, `.tmp-mutant-${process.pid}.js`);
    // Neuter every R2a ceiling wiring in the DEPLOYED file: both reader call
    // sites and the gate's independent record criterion.
    const mutated = original
        .split('maxRecordBytes: MAX_RECORD_BYTES').join('maxRecordBytes: Number.MAX_SAFE_INTEGER')
        .split('recordCeilingBytes: MAX_RECORD_BYTES').join('recordCeilingBytes: 0');
    assert.notEqual(mutated, original, 'the mutation must actually change the deployed file');
    assert.equal(mutated.includes('maxRecordBytes: MAX_RECORD_BYTES'), false);

    const cwd = makeCwd(MAX_RECORD_BYTES + 1);
    try {
        fs.writeFileSync(mutantPath, mutated);
        const r = run(mutantPath, cwd);
        const all = r.out + r.err;
        // With the ceiling neutered the run SUCCEEDS and emits an artifact -
        // exactly the silent-acceptance defect R2a exists to prevent.
        assert.equal(r.status, 0, `mutant should complete; status=${r.status} err=${r.err.slice(-400)}`);
        assert.equal(all.includes(RECORD_SIZE_TERMINAL), false, 'mutant must NOT emit the terminal');
        assert.ok(fs.existsSync(path.join(cwd, 'artifacts', 'shard-0.json.zst')),
            'mutant emits an artifact despite the oversize record => the baseline assertion is falsifiable');
    } finally {
        fs.rmSync(mutantPath, { force: true });
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
