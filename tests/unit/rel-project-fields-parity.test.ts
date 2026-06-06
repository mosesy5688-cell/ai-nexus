/**
 * REL_PROJECT_FIELDS Cross-Language Parity Test
 *
 * CONFIRMED DEFECT (P0): the LIVE relation projection path is 100% JS
 * (scripts/factory/lib/registry-loader.js projectEntityForRelations, driven by
 * relations-generator.js). The Rust per-entity relation projector
 * (rust/stream-aggregator/src/project.rs project_entity_for_relations) is DEAD
 * CODE — its only JS wrapper projectEntityForRelationsFFI has ZERO callers since
 * the FFI round-trip was removed (#2112, "JS is single source"). benchmark
 * (#2144) added `benchmarks` to the Rust REL_FIELDS allowlist but NOT to the
 * live JS REL_PROJECT_FIELDS, so relation-extractors.js never saw
 * entity.benchmarks and EVALUATED_ON (model->benchmark) silently emitted 0.
 *
 * This is the asymmetry guard: the JS allowlist MUST be a superset of the Rust
 * allowlist. Both lists are parsed straight from source so the check tracks the
 * real arrays without needing either symbol exported. If the two ever diverge
 * (a field added to Rust but not JS, the silent-strip class), this fails.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

/** Extract a string-array literal's members (the quoted tokens) from a source
 *  slice. Tolerates comments between elements (regex matches only quoted
 *  string literals) and both ' and " quoting. */
function parseStringList(src: string): string[] {
    const tokens = src.match(/['"]([A-Za-z0-9_]+)['"]/g) || [];
    return tokens.map((t) => t.slice(1, -1));
}

/** Slice the body of a named array/slice declaration up to its closing
 *  bracket+marker. Throws if the declaration or terminator is not found. */
function sliceDecl(src: string, startMarker: string, endMarker: string): string {
    const start = src.indexOf(startMarker);
    if (start === -1) throw new Error(`marker not found: ${startMarker}`);
    const end = src.indexOf(endMarker, start);
    if (end === -1) throw new Error(`terminator not found: ${endMarker}`);
    return src.slice(start + startMarker.length, end);
}

function readJsRelFields(): string[] {
    const src = readFileSync(
        path.join(repoRoot, 'scripts/factory/lib/registry-loader.js'),
        'utf-8'
    );
    // const REL_PROJECT_FIELDS = [ ... ];
    return parseStringList(sliceDecl(src, 'const REL_PROJECT_FIELDS = [', '];'));
}

function readRustRelFields(): string[] {
    const src = readFileSync(
        path.join(repoRoot, 'rust/stream-aggregator/src/project.rs'),
        'utf-8'
    );
    // const REL_FIELDS: &[&str] = &[ ... ];
    return parseStringList(sliceDecl(src, 'const REL_FIELDS: &[&str] = &[', '];'));
}

describe('REL_PROJECT_FIELDS JS<->Rust relation-allowlist parity', () => {
    it('both source lists parse to a non-trivial set', () => {
        const js = readJsRelFields();
        const rust = readRustRelFields();
        expect(js.length).toBeGreaterThan(10);
        expect(rust.length).toBeGreaterThan(10);
    });

    it('JS REL_PROJECT_FIELDS is a SUPERSET of Rust REL_FIELDS (no silent strip)', () => {
        const js = new Set(readJsRelFields());
        const rust = readRustRelFields();
        const missing = rust.filter((f) => !js.has(f));
        expect(
            missing,
            `Rust REL_FIELDS has relation fields absent from the LIVE JS ` +
                `REL_PROJECT_FIELDS (these edges would silently emit 0): ${missing.join(', ')}`
        ).toEqual([]);
    });

    it('benchmarks is present in the live JS allowlist (EVALUATED_ON regression lock)', () => {
        expect(readJsRelFields()).toContain('benchmarks');
    });
});
