// D-2026-0806-404 B1: empty-chunk parity for the byte-bounded reader.
//
// DEFECT REPAIRED HERE. `pendingCR = endsWithLoneCR(joined)` was recomputed
// unconditionally. A ZERO-LENGTH source chunk made `joined` empty, silently
// clearing a CR carried from the previous chunk; the next chunk's leading LF
// was then read as a fresh terminator and a spurious empty line was emitted.
// Reproduction: ["abc\r", <empty>, "\ndef"] gave ["abc","","def"] against real
// readline's ["abc","def"], falsifying the reader's own exactness claim.
//
// Zero-length chunks are not hypothetical: a Readable may emit them, and the
// decompress stage can flush an empty buffer between records.
//
// Hermetic: in-memory fixtures only. The mutation writes a scratch copy of the
// reader beside the original (so its relative imports resolve) and removes it
// in a finally; the pattern is gitignored.
import test from 'node:test';
import assert from 'node:assert/strict';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { readNdjsonLines } from './lib/ndjson-byte-reader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READER = path.join(HERE, 'lib', 'ndjson-byte-reader.js');
const E = Buffer.alloc(0);
const B = (s) => Buffer.from(s);

// Each case is a CHUNK LIST. The golden value is real node readline fed the
// concatenation, so terminator semantics are never asserted against a model.
const CASES = {
    'CR then empty then LF (the reported defect)': [B('abc\r'), E, B('\ndef')],
    'empty chunk between LF and next line': [B('abc\n'), E, B('def\n')],
    'leading empty chunk': [E, B('abc\ndef\n')],
    'trailing empty chunk': [B('abc\ndef\n'), E],
    'only empty chunks': [E, E, E],
    'empty chunk mid-record': [B('{"id":'), E, B('"a"}\n')],
    'CRLF split by an empty chunk': [B('abc\r'), E, B('\n'), E, B('def')],
    'many empty chunks around a bare CR': [E, B('abc\r'), E, E, B('def\r'), E],
    'empty chunk before a lone CR terminator': [B('abc'), E, B('\r'), E, B('def')],
    'empty chunk then LF only': [B('abc\r'), E, B('\n')],
};

async function viaReadline(chunks) {
    const rl = readline.createInterface({ input: Readable.from([Buffer.concat(chunks)]), crlfDelay: Infinity });
    const out = [];
    for await (const l of rl) out.push(l);
    return out;
}
async function viaReader(chunks, mod = null) {
    const gen = (mod || { readNdjsonLines }).readNdjsonLines;
    const out = [];
    for await (const l of gen(Readable.from(chunks), {})) out.push(l);
    return out;
}

test('T-3a empty-chunk parity: reader equals real readline for every chunk list', async () => {
    for (const [name, chunks] of Object.entries(CASES)) {
        const golden = await viaReadline(chunks);
        const got = await viaReader(chunks);
        assert.deepEqual(got, golden, `${name}: expected ${JSON.stringify(golden)}, got ${JSON.stringify(got)}`);
    }
});

test('T-3a empty chunks never perturb reader state (explicit defect assertion)', async () => {
    const got = await viaReader([B('abc\r'), E, B('\ndef')]);
    assert.deepEqual(got, ['abc', 'def'], 'a CR carried across an empty chunk must still pair with the next LF');
    assert.equal(got.includes(''), false, 'no spurious empty line may be emitted');
});

test('B1 MUTATION: reverting to the unconditional pendingCR recompute turns the fixtures RED', async () => {
    const original = fs.readFileSync(READER, 'utf8');
    const guard = '        if (buf.length === 0) continue;';
    assert.ok(original.includes(guard), 'the empty-chunk guard must be present in the shipped reader');
    // MUTATION = delete the guard, restoring the unconditional recompute path.
    const mutatedSrc = original.replace(guard, '        // MUTATION: guard removed');
    assert.notEqual(mutatedSrc, original, 'the mutation must change the reader');

    const mutantPath = path.join(HERE, 'lib', `.tmp-mutant-reader-${process.pid}.js`);
    try {
        fs.writeFileSync(mutantPath, mutatedSrc);
        const mod = await import(`file://${mutantPath.replace(/\\/g, '/')}`);

        // The reported case must diverge from readline under the mutation.
        const chunks = [B('abc\r'), E, B('\ndef')];
        const golden = await viaReadline(chunks);
        const mutated = await viaReader(chunks, mod);
        assert.deepEqual(golden, ['abc', 'def']);
        assert.deepEqual(mutated, ['abc', '', 'def'], 'the mutation reproduces the original defect exactly');
        assert.notDeepEqual(mutated, golden, 'mutation diverges from readline => the fixture is non-vacuous');

        // At least one more case must also go red, so the pin is not a single point.
        const alsoRed = [];
        for (const [name, cl] of Object.entries(CASES)) {
            const g = await viaReadline(cl);
            const m = await viaReader(cl, mod);
            if (JSON.stringify(g) !== JSON.stringify(m)) alsoRed.push(name);
        }
        assert.ok(alsoRed.length >= 2, `the mutation must falsify multiple fixtures; falsified: ${alsoRed.join(' | ')}`);
        console.log(`[B1 MUTATION] fixtures turned RED (${alsoRed.length}): ${alsoRed.join(' | ')}`);
    } finally {
        fs.rmSync(mutantPath, { force: true });
    }
});
