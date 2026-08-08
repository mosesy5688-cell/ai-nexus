// CI-integrity guard (D-2026-0808-410 N3): every `scripts/**/*.test.mjs` file on
// disk MUST be registered in the EXPLICIT `node --test` file list of the required
// `unit-test` job in .github/workflows/test-suite.yml.
//
// WHY THIS EXISTS
// The .mjs node:test suites are NOT collected by vitest (which globs only
// **/*.{test,spec}.ts). They run ONLY because they are named, one by one, in that
// one `run:` line. A suite that is written, reviewed and merged but never added to
// the list is not a gate at all -- it is a file. That gap is silent by
// construction: nothing goes red, the suite simply never executes. This guard
// turns that silence into a RED test.
//
// SHAPE (same as the M8.f probe): the workflow text is READ ONLY, parsed into
// tokens, and compared against a real directory walk. Nothing is written, no
// network, no credentials. The only in-memory mutation is in the clearly labelled
// #NEG parser-sensitivity test at the bottom, which makes no claim about the real
// workflow file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'test-suite.yml');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

// This guard's OWN repo-relative path. It must appear in the list it polices --
// an unregistered guard polices nothing (see the self-registration test).
const SELF = 'scripts/ci/test-suite-registration-guard.test.mjs';

// ---------------------------------------------------------------------------
// EXCLUSIONS: on-disk `scripts/**/*.test.mjs` files that are deliberately NOT in
// the required list. Each entry MUST carry a written reason on its own line.
//
// Current census (2026-08-08, base f74792175): ZERO exclusions. Every .test.mjs
// under scripts/ is registered. This array is empty ON PURPOSE -- it is not a
// placeholder for convenience. Adding an entry is a governance act: it removes a
// suite from the required gate, so the reason must say why the suite must not be
// blocking, not merely that it is slow or awkward.
// ---------------------------------------------------------------------------
const EXCLUSIONS = [
    // (intentionally empty -- see the note above)
];
const EXCLUDED = new Set(EXCLUSIONS.map((e) => e.path));

// --- workflow parsing -------------------------------------------------------

/** Read the workflow, normalised to LF (a Windows checkout may hold CRLF). */
const readWorkflow = () => fs.readFileSync(WORKFLOW, 'utf8').replace(/\r\n/g, '\n');

/**
 * Extract the explicit `node --test <paths...>` file list from a workflow text.
 * Returns { paths, line }. Throws (via assert) if the invocation is not unique --
 * a second `node --test` line would make "the list" ambiguous and this guard
 * would silently police the wrong one.
 */
function parseNodeTestList(text) {
    const lines = text.split('\n');
    const hits = lines.filter((l) => /^\s*run:\s*node --test\s/.test(l));
    assert.equal(hits.length, 1,
        `exactly one \`run: node --test ...\` line must exist in test-suite.yml; found ${hits.length}`);
    const line = hits[0];
    const tail = line.slice(line.indexOf('node --test ') + 'node --test '.length).trim();
    const paths = tail.split(/\s+/).filter(Boolean);
    return { paths, line };
}

// --- disk enumeration -------------------------------------------------------

/** Recursively collect every *.test.mjs under scripts/, repo-relative + posix. */
function walkTestMjs(dir, acc = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) walkTestMjs(abs, acc);
        else if (ent.isFile() && ent.name.endsWith('.test.mjs')) {
            acc.push(path.relative(ROOT, abs).split(path.sep).join('/'));
        }
    }
    return acc;
}

const onDisk = () => walkTestMjs(SCRIPTS_DIR).sort();

/** The core difference: on-disk suites that the workflow never runs. */
function unregistered(listedPaths, diskPaths, excluded = EXCLUDED) {
    const listed = new Set(listedPaths);
    return diskPaths.filter((p) => !listed.has(p) && !excluded.has(p));
}

// ===========================================================================
// 1. THE GATE: no on-disk suite may be missing from the required list.
// ===========================================================================
test('N3 every scripts/**/*.test.mjs is registered in the required node --test list', () => {
    const { paths } = parseNodeTestList(readWorkflow());
    const disk = onDisk();
    const missing = unregistered(paths, disk);
    assert.deepEqual(missing, [],
        `these .mjs suites exist on disk but are NOT run by the required unit-test job, so they gate nothing. `
        + `Add them to the \`node --test\` list in .github/workflows/test-suite.yml (or add an EXCLUSIONS entry `
        + `with a written reason): ${missing.join(' | ')}`);
});

// ===========================================================================
// 2. The reverse leak: a listed path that no longer exists silently breaks the
//    whole step (node --test exits non-zero on a missing file), so name it here
//    with a clear message instead.
// ===========================================================================
test('N3 every path in the node --test list exists on disk', () => {
    const { paths } = parseNodeTestList(readWorkflow());
    const dead = paths.filter((p) => !fs.existsSync(path.join(ROOT, p)));
    assert.deepEqual(dead, [],
        `the required list names files that do not exist: ${dead.join(' | ')}`);
});

// ===========================================================================
// 3. The list must be a literal, unambiguous file list.
// ===========================================================================
test('N3 the required list is literal: no duplicates, no flags, no globs', () => {
    const { paths } = parseNodeTestList(readWorkflow());

    const seen = new Set();
    const dupes = [];
    for (const p of paths) {
        if (seen.has(p)) dupes.push(p);
        seen.add(p);
    }
    assert.deepEqual(dupes, [], `duplicate entries in the required list: ${dupes.join(' | ')}`);

    const flags = paths.filter((p) => p.startsWith('-'));
    assert.deepEqual(flags, [],
        `no flag may follow \`node --test\` on this line -- a flag would be parsed as a path by this guard `
        + `and could silently change the runner's semantics: ${flags.join(' | ')}`);

    const globs = paths.filter((p) => /[*?[\]]/.test(p));
    assert.deepEqual(globs, [],
        `no wildcard is permitted: a glob would silently pull in files nobody reviewed (and, on the shard-oom `
        + `family, would drag the ~7-minute slow suite into the fast set): ${globs.join(' | ')}`);

    const shape = paths.filter((p) => !/^scripts\/[A-Za-z0-9._/-]+\.test\.mjs$/.test(p));
    assert.deepEqual(shape, [],
        `every entry must be a scripts/**/*.test.mjs path: ${shape.join(' | ')}`);
});

// ===========================================================================
// 4. SELF-REGISTRATION. If this guard is not itself in the list, it never runs
//    in CI and the gap it exists to close reopens with nothing going red.
// ===========================================================================
test('N3 this guard is itself registered in the required list', () => {
    const { paths } = parseNodeTestList(readWorkflow());
    assert.ok(fs.existsSync(path.join(ROOT, SELF)),
        `SELF must name this file's real repo-relative path; got ${SELF}`);
    assert.ok(paths.includes(SELF),
        `the registration guard must appear in its own list, or it is not a gate: ${SELF}`);
});

// ===========================================================================
// 5. EXCLUSIONS hygiene. Empty today; this keeps a future entry honest.
// ===========================================================================
test('N3 every EXCLUSIONS entry is real, reasoned and not simultaneously listed', () => {
    const { paths } = parseNodeTestList(readWorkflow());
    const disk = new Set(onDisk());
    for (const e of EXCLUSIONS) {
        assert.equal(typeof e.path, 'string', 'each exclusion needs a path');
        assert.ok(disk.has(e.path), `exclusion names a file that does not exist: ${e.path}`);
        assert.ok(typeof e.reason === 'string' && e.reason.trim().length >= 20,
            `exclusion ${e.path} needs a written reason (>= 20 chars), not a bare path`);
        assert.equal(paths.includes(e.path), false,
            `${e.path} is BOTH excluded and listed -- one of the two is wrong`);
    }
});

// ===========================================================================
// 6. ANTI-VACUITY. If the parser or the walk silently returned nothing, every
//    difference above would be empty and this file would pass while checking
//    nothing. Pin non-trivial lower bounds on BOTH inputs.
// ===========================================================================
test('N3 anti-vacuity: both the parsed list and the disk walk are non-trivial', () => {
    const { paths } = parseNodeTestList(readWorkflow());
    const disk = onDisk();
    assert.ok(paths.length >= 20,
        `the parsed list collapsed to ${paths.length} entries -- the parser is probably broken`);
    assert.ok(disk.length >= 20,
        `the disk walk found only ${disk.length} suites -- the walk is probably broken`);
    // Both sides must actually cover more than one directory, so a walk that
    // bottomed out in a single folder cannot masquerade as a full census.
    const dirs = new Set(disk.map((p) => p.slice(0, p.lastIndexOf('/'))));
    assert.ok(dirs.size >= 2, `expected suites in >= 2 directories under scripts/, saw: ${[...dirs].join(', ')}`);
});

// ===========================================================================
// 7. #NEG parser sensitivity (D-2026-0808-410 N1 naming rule).
//
//    THIS IS NOT A MUTATION PROOF. It does not touch, rewrite or re-run the real
//    workflow file; it only feeds the SAME parser + difference function a
//    synthetic text with one path deleted, to show the difference function is not
//    a constant-empty no-op. The real falsifiability evidence for this guard is
//    the on-disk mutation recorded in the PR body (delete one path from the
//    workflow's node --test list -> test 1 goes RED -> restore byte-for-byte).
// ===========================================================================
test('#NEG parser sensitivity: a synthetic list missing one path yields a non-empty difference', () => {
    const text = readWorkflow();
    const { paths } = parseNodeTestList(text);
    const victim = paths.find((p) => p !== SELF);
    assert.ok(victim, 'need at least one non-self entry to drop');

    // Synthetic text only -- never written back.
    const synthetic = text.replace(` ${victim}`, '');
    assert.notEqual(synthetic, text, 'the synthetic edit must apply');
    const { paths: shortened } = parseNodeTestList(synthetic);
    assert.equal(shortened.length, paths.length - 1, 'exactly one entry must be gone');

    // Measured as a DELTA against the real list's own result, so this control
    // stays meaningful (and stays green) even while test 1 is legitimately red.
    const disk = onDisk();
    const before = unregistered(paths, disk);
    const after = unregistered(shortened, disk);
    assert.equal(after.length, before.length + 1,
        'dropping one registered path must add exactly one entry to the difference -- otherwise it is a no-op');
    assert.ok(after.includes(victim), `the dropped path must be the one newly reported: ${victim}`);
});

test('#NEG parser sensitivity: an ambiguous second node --test line is rejected, not silently picked', () => {
    const text = readWorkflow();
    const { line } = parseNodeTestList(text);
    const synthetic = text.replace(line, `${line}\n${line}`);
    assert.throws(() => parseNodeTestList(synthetic), /exactly one/,
        'two node --test lines must fail loudly rather than let this guard police an arbitrary one');
});
