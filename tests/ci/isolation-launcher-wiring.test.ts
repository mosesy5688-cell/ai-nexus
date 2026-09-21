/**
 * Work order N, N5-4 -- the isolation launcher is REALLY wired in, and there is
 * no unisolated bypass left behind.
 *
 * WHY THIS FILE EXISTS: an expectation table in a `.md` does not execute
 * anything. This suite is an executable carrier: it runs in the required
 * `unit-test` job and fails it if the wiring regresses.
 *
 * WHAT IT PROVES: the entry that used to run #2326's Astro compile / render /
 * reader-mutant cases now runs inside the boundary, with the command after `--`
 * byte-identical to the one it replaced; no second vitest entry runs the root
 * config outside the boundary in any workflow; no job and no workflow file was
 * added; and the mesh guard test is still collected rather than quietly dropped.
 *
 * WHAT IT DOES NOT PROVE: that the runner can actually create a network
 * namespace. That is ruling B1 and is settled by a normal PR run, not here.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WORKFLOWS = path.join(ROOT, '.github', 'workflows');
const SUITE = path.join(WORKFLOWS, 'test-suite.yml');
const LAUNCHER = 'scripts/ci/isolation/netns-launch.sh';
const DRIVER = 'scripts/ci/isolation/counterexamples.sh';
const MESH_GUARD = 'tests/unit/mesh-visualizer-no-metadata-read.test.ts';
/** Byte-identical to the command this step ran before work order N. */
const VITEST_CMD = 'npx vitest run --coverage';
const ISOLATED_VITEST = `bash ${LAUNCHER} -- ${VITEST_CMD}`;

const read = (p: string): string => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const suite = read(SUITE);

const jobNames = (yml: string): string[] =>
    [...yml.matchAll(/^ {2}([A-Za-z0-9_-]+):\n(?= {4})/gm)]
        .map((m) => m[1])
        .filter((n) => yml.indexOf(`\n  ${n}:`) > yml.indexOf('\njobs:'));

const runLines = (yml: string): string[] =>
    [...yml.matchAll(/^\s*run: (.*)$/gm)].map((m) => m[1].trim());

const stepNames = (yml: string): string[] =>
    [...yml.matchAll(/^ {6}- name: (.*)$/gm)].map((m) => m[1].trim());

const workflowFiles = (): string[] =>
    fs.readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

describe('N5-4: the Tier-1 vitest entry runs inside the boundary', () => {
    it('the isolated vitest command is present verbatim, exactly once', () => {
        const hits = runLines(suite).filter((l) => l === ISOLATED_VITEST);
        expect(hits, `expected exactly one \`${ISOLATED_VITEST}\``).toHaveLength(1);
    });

    it('the command after -- is byte-identical to the pre-change entry', () => {
        const line = runLines(suite).find((l) => l.includes(LAUNCHER) && l.includes('vitest'));
        expect(line).toBeDefined();
        expect(line!.slice(line!.indexOf(' -- ') + 4)).toBe(VITEST_CMD);
    });

    it('no run: line invokes the ROOT vitest config outside the launcher', () => {
        const offenders: string[] = [];
        for (const f of workflowFiles()) {
            for (const line of runLines(read(path.join(WORKFLOWS, f)))) {
                if (!/\bvitest\b/.test(line)) continue;
                if (line.includes(LAUNCHER)) continue;              // isolated: fine
                if (/--workspace\s+@free2aitools\/sdk/.test(line)) continue; // own config
                offenders.push(`${f}: ${line}`);
            }
        }
        expect(offenders, 'an unisolated root-vitest entry would be a bypass').toEqual([]);
    });

    it('the counterexample driver runs in the same job, BEFORE the isolated vitest', () => {
        const names = stepNames(suite);
        const lines = runLines(suite);
        expect(lines).toContain(`bash ${DRIVER}`);
        const driverAt = lines.findIndex((l) => l === `bash ${DRIVER}`);
        const vitestAt = lines.findIndex((l) => l === ISOLATED_VITEST);
        expect(driverAt).toBeGreaterThanOrEqual(0);
        expect(vitestAt).toBeGreaterThan(driverAt);
        expect(names.some((n) => n.includes('counterexamples'))).toBe(true);
    });
});

describe('F-3: no new workflow file and no new job', () => {
    it('test-suite.yml still declares exactly the two original jobs', () => {
        expect(jobNames(suite)).toEqual(['iron-gates', 'unit-test']);
    });

    it('only test-suite.yml references the isolation facility', () => {
        const referencing = workflowFiles()
            .filter((f) => read(path.join(WORKFLOWS, f)).includes('scripts/ci/isolation/'));
        expect(referencing).toEqual(['test-suite.yml']);
    });

    it('the unit-test job sets no continue-on-error key', () => {
        const job = suite.slice(suite.indexOf('\n  unit-test:'));
        const keys = job.split('\n').filter((l) => /^\s*continue-on-error\s*:/.test(l));
        expect(keys, 'a comment mentioning it is fine; a key is not').toEqual([]);
    });

    it('nothing in the isolation steps changes secrets, permissions or triggers', () => {
        const added = suite.split('\n').filter((l) => l.includes('scripts/ci/isolation/'));
        expect(added.length).toBeGreaterThan(0);
        for (const l of added) {
            expect(l).not.toMatch(/secrets\.|permissions:|environment:|on:\s/);
        }
    });
});

describe('N5-4: entry census -- the mesh guard is collected, not dropped', () => {
    it('the #2326 guard test is still on disk and still a collected .test.ts', () => {
        const p = path.join(ROOT, MESH_GUARD);
        expect(fs.existsSync(p), `${MESH_GUARD} must not be deleted to remove a bypass`).toBe(true);
        expect(MESH_GUARD.endsWith('.test.ts')).toBe(true);
    });

    it('the root vitest config still collects it and excludes nothing that would drop it', () => {
        const cfg = read(path.join(ROOT, 'vitest.config.ts'));
        expect(cfg).toContain("include: ['**/*.{test,spec}.ts']");
        const exclude = cfg.match(/exclude: \[(.*?)\]/s)?.[1] ?? '';
        expect(exclude).not.toMatch(/tests\/unit|mesh-visualizer/);
    });

    it('it still carries the Astro compile, render and reader-mutant entries', () => {
        const src = read(path.join(ROOT, MESH_GUARD));
        // These are the call entries the census names; all of them now run
        // inside the boundary because the whole root suite does.
        expect(src).toContain("from '@astrojs/compiler'");
        expect(src).toContain('AstroContainer.create()');
        expect(src).toContain('renderToString');
        expect(src).toContain('const MUTANT');
        const cases = src.match(/^\s*it\(/gm) ?? [];
        expect(cases.length).toBeGreaterThanOrEqual(14);
    });
});
