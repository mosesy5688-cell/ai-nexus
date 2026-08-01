// tests/unit/vfs-derived-health-census-workflow.test.ts
// T-2 (2026-08-01 VFS Derived timeout repair). The FAIL-CLOSED, INDEPENDENT-AUTHORITY,
// MEMBER-SET census gate on the V23.1 SQL Health Check step.
//
// WHY. On 2026-07-31 (run 30630342243) this loop checked 81 of 98 databases and nothing
// ASSERTED the shortfall: "Final Upload cannot publish after partial health checking" held
// only IMPLICITLY (a cancelled step skips the downstream `if: success()` steps and
// `upload.needs` then skips) — step ordering, not an invariant.
// WHAT THIS FILE LOCKS: EXPECTED_MEMBER_SET must come ENTIRELY from an independent producer
// authority; runtime globbing may enumerate PRESENT/COMPLETED but must NEVER define EXPECTED;
// the comparison must be over MEMBER IDENTITIES (count-only is insufficient). String matching
// alone would not prove that, so the assertions are REGION-SCOPED: the census script's
// EXPECTED-derivation region is sliced by its own delimiters and proven free of enumeration.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

function block(src: string, header: string, indent: number): string {
    const lines = src.split('\n');
    const start = lines.indexOf(' '.repeat(indent) + header);
    expect(start, `block header not found: "${header}"`).toBeGreaterThan(-1);
    const shallower = new RegExp(`^ {0,${indent}}[^\\s#]`);
    for (let i = start + 1; i < lines.length; i++) {
        if (lines[i].trim() && shallower.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}
function step(job: string, name: string): string {
    const lines = job.split('\n');
    const start = lines.indexOf(`      - name: ${name}`);
    expect(start, `step not found: ${name}`).toBeGreaterThan(-1);
    for (let i = start + 1; i < lines.length; i++) {
        if (/^ {6}- /.test(lines[i])) return lines.slice(start, i).join('\n');
    }
    return lines.slice(start).join('\n');
}
/** Slice strictly BETWEEN two delimiters; fails loud if either is missing or out of order. */
function between(src: string, open: string, close: string) {
    const a = src.indexOf(open);
    const b = src.indexOf(close);
    expect(a, `open delimiter missing: ${open}`).toBeGreaterThan(-1);
    expect(b, `close delimiter missing: ${close}`).toBeGreaterThan(a);
    return src.slice(a + open.length, b);
}

const derived = block(yml, 'vfs-derived:', 2);
const health = step(derived, 'V23.1 SQL Health Check');
const EXPECTED_OPEN = '>>> EXPECTED-DERIVATION BEGIN (INDEPENDENT PRODUCER AUTHORITY ONLY) <<<';
const EXPECTED_CLOSE = '>>> EXPECTED-DERIVATION END <<<';
const PRESENT_OPEN = '>>> PRESENT-DERIVATION BEGIN (RUNTIME DIRECTORY ENUMERATION) <<<';
const PRESENT_CLOSE = '>>> PRESENT-DERIVATION END <<<';
const expectedRegion = between(health, EXPECTED_OPEN, EXPECTED_CLOSE);
const presentRegion = between(health, PRESENT_OPEN, PRESENT_CLOSE);

describe('T-2 EXPECTED comes ENTIRELY from an independent producer authority', () => {
    it('EXPECTED is derived from the vfs-pack PRODUCER MANIFEST, restored from R2 by a DIFFERENT job', () => {
        expect(health).toContain('VFS_PACK_MANIFEST: /tmp/vfs-pack-manifest.json');
        expect(expectedRegion).toContain('JSON.parse(fs.readFileSync(MANIFEST, "utf8"))');
        expect(expectedRegion).toContain('manifest.files');
        // the carrier identity itself is asserted — a foreign manifest cannot be substituted
        expect(expectedRegion).toContain('manifest.carrier_type !== "vfs-pack-authority"');
        expect(expectedRegion).toContain('MANIFEST_CARRIER_WRONG');
        expect(block(yml, 'vfs-pack-db:', 2)).toContain( // the producer really does generate it
            'scripts/factory/vfs-derived-handoff-manifest.mjs generate output/data/ /tmp/vfs-pack-manifest.json --carrier=vfs-pack-authority --ext=.db');
    });

    it('the EXPECTED-derivation region performs NO directory enumeration whatsoever', () => {
        // THE assertion the rejected design could not make: any future re-derivation of
        // EXPECTED from the directory under test (readdir / shell glob / ls / PRESENT) reds.
        expect(expectedRegion).not.toMatch(/readdir/i);
        expect(expectedRegion).not.toMatch(/DATA_DIR/);
        expect(expectedRegion).not.toMatch(/output\/data\/\*/);
        expect(expectedRegion).not.toMatch(/\bls -/);
        expect(expectedRegion).not.toMatch(/\bglob\b/i);
        expect(expectedRegion).not.toMatch(/\bpresent\b/);
        expect(expectedRegion).not.toMatch(/\bcompleted\b/i);
    });

    it('`const expected =` is assigned EXACTLY ONCE, and only inside the EXPECTED region', () => {
        // ANTI-VACUITY: `EXPECTED := COMPLETED` (or := PRESENT) cannot be smuggled in.
        expect(health.split('const expected =').length - 1).toBe(1);
        expect(expectedRegion).toContain('const expected = carried.filter((n) => !RANKINGS.has(n)).sort();');
        expect(health).not.toMatch(/const expected\s*=\s*(present|completed)/i);
        expect(health).not.toMatch(/CENSUS_EXPECTED_FILE"?\s*=/);      // never shell-reassigned
        expect(health).not.toMatch(/> *"\$CENSUS_EXPECTED_FILE"/);     // never shell-overwritten
        // the ONLY writer of the expected file is the manifest-sourced census script
        expect(health.split('CENSUS_EXPECTED_FILE,').length - 1).toBe(1);
        expect(health).toContain('fs.writeFileSync(process.env.CENSUS_EXPECTED_FILE, expected.join("\\n") + "\\n");');
    });

    it('PRESENT — and only PRESENT — comes from runtime enumeration; the loop is EXPECTED-driven', () => {
        expect(presentRegion).toContain('fs.readdirSync(DATA_DIR, { withFileTypes: true })');
        expect(presentRegion).toContain('const present = dirents.filter');
        expect(presentRegion).not.toContain('MANIFEST');
        expect(health).toContain('done < "$CENSUS_EXPECTED_FILE"');
        expect(health).not.toContain('for db in output/data/*.db');
        expect(health).not.toMatch(/for .* in output\/data\/\*/);
    });
});

describe('T-2 the expected set covers ALL 98 currently required non-ranking databases', () => {
    it('meta-knowledge.db and meta-report.db are asserted BY NAME against the manifest', () => {
        // PRODUCER-SIDE FLOOR GAP. The manifest's ONLY declared required class is meta_db
        // (META_DB_RE = /(^|\/)meta-\d+\.db$/, min: 1). Neither anchor DB matches it, so a
        // manifest missing them would be SELF-CONSISTENT, pass its own verification, and yield
        // 97. Counting manifest members alone INHERITS that gap; the by-name assertion closes
        // it. Declared in the census preamble, ENFORCED inside the EXPECTED region.
        expect(health).toContain('const ANCHOR_MEMBERS = ["meta-knowledge.db", "meta-report.db"];');
        expect(expectedRegion).toContain('ANCHOR_MEMBER_ABSENT');
        expect(expectedRegion).toMatch(/for \(const a of ANCHOR_MEMBERS\)[\s\S]*!expected\.includes\(a\)[\s\S]*ANCHOR_MEMBER_ABSENT/);
        // and the names are load-bearing repo constants, not invented here: produced by
        // meta-anchors.js and independently pinned by the EXISTING fixed-key consumer suite.
        const anchors = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/lib/meta-anchors.js'), 'utf8');
        const pinned = fs.readFileSync(path.resolve(__dirname, 'r5-vfs-idindex-b4.test.ts'), 'utf8');
        for (const n of ["'meta-report.db'", "'meta-knowledge.db'"]) {
            expect(anchors, `meta-anchors.js does not produce ${n}`).toContain(n);
            expect(pinned, `r5-vfs-idindex-b4 does not pin ${n}`).toContain(n);
        }
    });

    it('the 10 rankings DBs are excluded by the CANONICAL name list, not by pattern guessing', () => {
        expect(expectedRegion).toContain('src/constants/rankings-groups.js');
        expect(expectedRegion).toContain('RANKINGS_DB_NAMES');
        expect(expectedRegion).toContain('RANKINGS.size !== 10 || RANKINGS.size !== rg.RANKINGS_DB_COUNT');
        expect(expectedRegion).toContain('RANKINGS_AUTHORITY_UNEXPECTED');
        // the canonical authority really is EXACTLY 10
        const rg = fs.readFileSync(path.resolve(__dirname, '../../src/constants/rankings-groups.js'), 'utf8');
        expect(rg).toContain('export const RANKINGS_DB_NAMES');
        expect(rg).toContain('export const RANKINGS_DB_COUNT = RANKINGS_GROUPS.length;');
        // the step never guesses the rankings family by prefix
        expect(health).not.toContain("rankings-*)");
        expect(health).not.toMatch(/grep -v .\^?rankings-/);
    });
});

describe('T-2 the gate compares MEMBER IDENTITIES and fails closed on every named condition', () => {
    it('the post-loop gate is a line-for-line identity diff, not a count comparison', () => {
        expect(health).toContain('sort -o "$CENSUS_COMPLETED_FILE" "$CENSUS_COMPLETED_FILE"');
        expect(health).toContain('if ! diff -u "$CENSUS_EXPECTED_FILE" "$CENSUS_COMPLETED_FILE"');
        expect(health).toContain('MEMBER_SET_DIVERGED');
        expect(health).toMatch(/MEMBER_SET_DIVERGED[\s\S]*exit 1/);
        // a same-count/different-member set is explicitly in scope
        expect(health).toContain('compared by member identity');
        expect(health).not.toMatch(/\[ *"\$COMPLETED_N" *= *"\$TOTAL" *\] *(\|\||&&)/); // no count-only gate
    });

    it('fail-closed conditions each carry their own error code and exit 1', () => {
        for (const code of [
            'MANIFEST_ABSENT', 'MANIFEST_UNREADABLE', 'MANIFEST_CARRIER_WRONG', 'MANIFEST_FILES_EMPTY',
            'EXPECTED_SET_EMPTY', 'MEMBER_MISSING', 'MEMBER_UNEXPECTED', 'MEMBER_DUPLICATE',
            'MEMBER_NAME_INVALID', 'EXPECTED_META_ZERO', 'ANCHOR_MEMBER_ABSENT',
            'DATA_DIR_UNREADABLE', 'RANKINGS_AUTHORITY_UNEXPECTED', 'MEMBER_SET_DIVERGED',
        ]) {
            expect(health, `missing fail-closed code ${code}`).toContain(code);
        }
        // every `die()` terminates the process — no warn-and-continue path exists
        expect(expectedRegion.includes('die(') || presentRegion.includes('die(')).toBe(true);
        expect(health).toContain('process.exit(1);');
        expect(health).toContain('node /tmp/vfs-derived-census.mjs');
    });

    it('every guard is pinned by its FULL PREDICATE, not merely by its error code', () => {
        // Anti-vacuity hardening (mutation drill M6/M8): several error codes are raised by MORE
        // THAN ONE guard, so `toContain(code)` alone survives deleting one. Pin each in full.
        for (const guard of [
            'if (manifest.carrier_type !== "vfs-pack-authority") die("MANIFEST_CARRIER_WRONG"',
            'if (!Array.isArray(manifest.files) || manifest.files.length === 0) die("MANIFEST_FILES_EMPTY"',
            'if (rel.includes("/")) die("MEMBER_NAME_INVALID"',
            'if (dupes.length) die("MEMBER_DUPLICATE"',
            'if (expected.length === 0) die("EXPECTED_SET_EMPTY"',
            'if (!META_SHARD_RE.test(n) && !ANCHOR_MEMBERS.includes(n)) die("MEMBER_NAME_INVALID"',
            'if (!expected.some((n) => META_SHARD_RE.test(n))) die("EXPECTED_META_ZERO"',
            'if (!expected.includes(a)) die("ANCHOR_MEMBER_ABSENT"',
            'if (missing.length) die("MEMBER_MISSING"',
            'if (unexpected.length) die("MEMBER_UNEXPECTED"',
        ]) {
            expect(health, `guard predicate missing: ${guard}`).toContain(guard);
        }
        // and the two SHELL-level guards, which are separate from their JS namesakes
        expect(health).toContain('[ -s "$VFS_PACK_MANIFEST" ] || { echo "::error::VFS-DERIVED-CENSUS MANIFEST_ABSENT');
        expect(health).toContain('[ "$TOTAL" -gt 0 ] || { echo "::error::VFS-DERIVED-CENSUS EXPECTED_SET_EMPTY');
        // the invalid-name code is raised by TWO distinct predicates; both must survive
        expect(health.split('MEMBER_NAME_INVALID').length - 1).toBeGreaterThanOrEqual(2);
        expect(health.split('EXPECTED_SET_EMPTY').length - 1).toBeGreaterThanOrEqual(2);
    });

    it('the empty-expected guard runs BEFORE the loop and the identity gate AFTER it', () => {
        const emptyGuard = health.indexOf('EXPECTED_SET_EMPTY: refusing to health-check a vacuous set');
        const loop = health.indexOf('node scripts/factory/verify-db.js');
        const gate = health.indexOf('MEMBER_SET_DIVERGED');
        expect(emptyGuard).toBeGreaterThan(0);
        expect(loop).toBeGreaterThan(emptyGuard);
        expect(gate).toBeGreaterThan(loop);
    });

    it('the progress line carries BOTH an index and the total (81/98 would have been readable)', () => {
        expect(health).toContain('echo "[HEALTH $I/$TOTAL] $NAME elapsed=');
    });
});

describe('T-2 nothing existing is weakened; fail-closed shell semantics preserved', () => {
    it('the same verify-db.js call on the same member set is retained; verify-db.js is untouched', () => {
        expect(health).toContain('node scripts/factory/verify-db.js "output/data/$NAME"');
        // CES ceiling headroom deliberately preserved — the repair adds ZERO lines to it.
        const vdb = fs.readFileSync(path.resolve(__dirname, '../../scripts/factory/verify-db.js'), 'utf8');
        expect(vdb.split('\n').length).toBeLessThanOrEqual(250);
    });

    it('#NEG no skip/swallow behaviour anywhere in the health step', () => {
        expect(health).toContain('set -euo pipefail');
        expect(health).not.toContain('|| true');
        expect(health).not.toContain('continue-on-error');
        expect(health).not.toMatch(/verify-db\.js[^\n]*\|\|/);
        expect(health).not.toMatch(/^ {8}if: /m);     // the health step is never conditionally skipped
    });

    it('#NEG the handoff + cache-save if: success() wiring and upload.needs are UNCHANGED', () => {
        expect(derived).toMatch(/- name: Produce Exact-Producer R2 Handoff \(VFS-DERIVED sitemaps\/RSS, D-245\)\n {8}id: vfs-derived-handoff\n {8}if: success\(\)/);
        expect(derived).toMatch(/- name: Save VFS Assets to Cache\n {8}if: success\(\)/);
        expect(derived).toMatch(/- name: Save RSS Feeds to Cache\n {8}if: success\(\)/);
        expect(block(yml, 'upload:', 2)).toContain(
            'needs: [mesh-baking, master-fusion-persist, vfs-derived, vfs-pack-db, check-upstream]');
    });
});

describe('T-2 READER anti-vacuity — the region slicer actually discriminates', () => {
    it('the two headline mutants are provably caught, not merely assumed to be', () => {
        // (a) EXPECTED re-sourced from an output/data glob
        const globbed = expectedRegion.replace(
            'const expected = carried.filter((n) => !RANKINGS.has(n)).sort();',
            'const expected = fs.readdirSync(DATA_DIR).filter((n) => n.endsWith(".db")).sort();');
        expect(globbed).not.toBe(expectedRegion);         // the mutation applied
        expect(globbed).toMatch(/readdir/i);              // and the live assertion WOULD red
        expect(expectedRegion).not.toMatch(/readdir/i);   // while the shipped text does not
        // (b) the member-identity gate deleted
        const ungated = health.replace('if ! diff -u "$CENSUS_EXPECTED_FILE" "$CENSUS_COMPLETED_FILE"', 'if false');
        expect(ungated).not.toBe(health);
        expect(ungated).not.toContain('if ! diff -u "$CENSUS_EXPECTED_FILE" "$CENSUS_COMPLETED_FILE"');
        expect(health).toContain('if ! diff -u "$CENSUS_EXPECTED_FILE" "$CENSUS_COMPLETED_FILE"');
    });

    it('`between()` fails loud rather than returning a vacuously-empty region', () => {
        expect(() => between('no delimiters here', EXPECTED_OPEN, EXPECTED_CLOSE)).toThrow();
        expect(expectedRegion.trim().length).toBeGreaterThan(600);
        expect(presentRegion.trim().length).toBeGreaterThan(150);
    });
});
