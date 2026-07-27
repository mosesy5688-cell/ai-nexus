import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Requirement 11 of the 2026-07-26 Factory 1/4 S2 incident repair: "Ecosystem
// authority and `Merge & Upload` remain BLOCKED on failure."
//
// That guarantee is STRUCTURAL, not behavioural, so it is asserted here against the
// workflow text rather than inferred from a run. Three independent links, each of
// which would silently unblock publication if it drifted:
//
//   L1  the `Harvest Semantic Scholar` step carries NO `|| echo` exit-code mask, so
//       harvest-single's exit 1 actually reddens the step;
//   L2  the Ecosystem "Establish Authoritative R2 Harvest Source Authority" step is
//       NOT `if: always()`, so a failed prior step in the job prevents it running;
//   L3  `merge-and-upload` `needs:` harvest-ecosystem and is NOT `if: always()`, so
//       a red Ecosystem job leaves it skipped.
//
// Nothing here requires opening a dashboard: the evidence is the repository text.

const WF = path.join(process.cwd(), '.github', 'workflows', 'factory-harvest.yml');
// Line endings normalised so the block-slicing below is checkout-agnostic (this
// repo is developed on Windows; a CRLF checkout must not silently skip assertions).
const yml = fs.readFileSync(WF, 'utf8').replace(/\r\n/g, '\n');

/** The `- name: X` step block, up to the next step at the same indentation. */
function stepBlock(name: string): string {
    const start = yml.indexOf(`- name: ${name}`);
    expect(start, `step not found: ${name}`).toBeGreaterThan(-1);
    const rest = yml.slice(start + 1);
    const next = rest.indexOf('\n      - name: ');
    return next === -1 ? rest : rest.slice(0, next);
}

/** The `<job>:` block, up to the next top-level job key. */
function jobBlock(job: string): string {
    const start = yml.indexOf(`\n  ${job}:\n`);
    expect(start, `job not found: ${job}`).toBeGreaterThan(-1);
    const rest = yml.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
}

describe('S2 fail-closed publication chain (requirement 11)', () => {
    it('L1: the Semantic Scholar harvest step is NOT exit-code masked', () => {
        const block = stepBlock('Harvest Semantic Scholar');
        expect(block).toContain('harvest-single.js semanticscholar');
        // A `|| echo "... skipped"` mask would make exit 1 invisible to the runner and
        // re-launder every repair in this PR back into a green job.
        expect(block).not.toMatch(/harvest-single\.js semanticscholar[^\n]*\|\|/);
    });

    it('L2: the Ecosystem R2 source-authority step is NOT if: always()', () => {
        const eco = jobBlock('harvest-ecosystem');
        expect(eco).toContain('Establish Authoritative R2 Harvest Source Authority');
        expect(eco).toContain('harvest-handoff-establish --role=ecosystem');
        const authority = eco.slice(eco.indexOf('- name: Establish Authoritative R2 Harvest Source Authority'));
        expect(authority).toContain("if: github.event.inputs.skip_harvest != 'true'");
        expect(authority).not.toContain('always()');
    });

    it('L2b: the Ecosystem R2 STREAM step is NOT if: always() either', () => {
        // The upload that precedes the authority artifact must also not run after a
        // failed harvest step, or partial masters would reach R2 ahead of the gate.
        const eco = jobBlock('harvest-ecosystem');
        const stream = eco.slice(eco.indexOf('- name: Stream Ecosystem to R2'));
        expect(stream).toContain("if: github.event.inputs.skip_harvest != 'true'");
        expect(stream.slice(0, stream.indexOf('run:'))).not.toContain('always()');
    });

    it('L3: merge-and-upload needs harvest-ecosystem and is NOT if: always()', () => {
        const merge = jobBlock('merge-and-upload');
        expect(merge).toContain('name: Merge & Upload');
        expect(merge).toMatch(/needs:\s*\[[^\]]*harvest-ecosystem[^\]]*\]/);
        const header = merge.slice(0, merge.indexOf('steps:'));
        expect(header).not.toContain('always()');
        expect(header).not.toMatch(/^\s{4}if:/m);
    });

    it('sidecar persistence is DELIBERATELY always() -- forensics must survive a red harvest', () => {
        // The one place always() is correct in this chain: the cache SAVE of the
        // per-source terminal-state sidecars. Publication stays blocked; evidence does not.
        const eco = jobBlock('harvest-ecosystem');
        const solidify = eco.slice(eco.indexOf('- name: Solidify Ecosystem Batches (Cache)'));
        expect(solidify).toContain('always()');
        expect(solidify).toContain('data/state/harvest-state-*.json');
    });
});
