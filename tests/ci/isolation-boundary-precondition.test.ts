/**
 * Work order N, ruling D d5 -- ANTI-VACUITY for the boundary precondition.
 *
 * The finding this answers: five "fail-closed precondition" cases in the #2326
 * guard passed on Windows with no boundary at all. A guard that is green with
 * and without the boundary has zero discriminating power, so the replacement
 * has to be shown to go RED when the boundary is removed, when the marker is
 * forged, and when an in-process monkey patch is substituted for it.
 *
 * Each case spawns scripts/ci/isolation/boundary-precondition.mjs as a REAL
 * process and asserts the real exit code, so nothing is judged by a log line.
 *
 * THIS FILE ITSELF MUST NOT REQUIRE THE BOUNDARY: it is the test OF the
 * requirement, and it must run wherever the reviewer is. Every case terminates
 * at the marker step, so no case emits a packet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GUARD = path.join(ROOT, 'scripts', 'ci', 'isolation', 'boundary-precondition.mjs');
const MESH_GUARD = path.join(ROOT, 'tests', 'unit', 'mesh-visualizer-no-metadata-read.test.ts');
const FATAL = 71;

const tmp = (tag: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `f2ai-${tag}-`));

const run = (env: NodeJS.ProcessEnv, extraArgs: string[] = []) =>
    spawnSync(process.execPath, [...extraArgs, GUARD, '--assert'], {
        encoding: 'utf8', timeout: 30000,
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env }
    });

/** A marker file the launcher would have written, with fields we control. */
const writeMarker = (dir: string, f: Record<string, string>): void =>
    fs.writeFileSync(path.join(dir, 'launch.nonce'),
        `${Object.entries(f).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);

describe('d5 mutant: the boundary is absent', () => {
    it('no launcher environment at all terminates with 71, and does not pass', () => {
        const r = run({});
        expect(r.status, 'a missing boundary must terminate, not skip and not pass').toBe(FATAL);
        expect(r.stderr).toContain('E_ISOLATION_BOUNDARY_ABSENT(71)');
        expect(r.stderr).toContain('F2AI_ISO_EVID');
        expect(r.stdout).not.toContain('markerVerified');
    });

    it('an evidence directory with no marker file terminates with 71', () => {
        const dir = tmp('nomarker');
        const r = run({ F2AI_ISO_EVID: dir, F2AI_ISO_NONCE: 'abc123' });
        expect(r.status).toBe(FATAL);
        expect(r.stderr).toContain('launch.nonce is missing');
    });
});

describe('d5 mutant: the marker is forged', () => {
    it('a marker whose nonce does not match the environment terminates with 71', () => {
        const dir = tmp('badnonce');
        writeMarker(dir, { nonce: 'NOT-THE-ONE', sub_netns: 'net:[1]', host_netns: 'net:[2]' });
        const r = run({ F2AI_ISO_EVID: dir, F2AI_ISO_NONCE: 'abc123' });
        expect(r.status).toBe(FATAL);
        expect(r.stderr).toContain('do not correspond');
    });

    it('a marker claiming the host namespace as the subtree terminates with 71', () => {
        const dir = tmp('samens');
        writeMarker(dir, { nonce: 'abc123', sub_netns: 'net:[4026531840]', host_netns: 'net:[4026531840]' });
        const r = run({ F2AI_ISO_EVID: dir, F2AI_ISO_NONCE: 'abc123' });
        expect(r.status).toBe(FATAL);
        expect(r.stderr).toContain('no new namespace');
    });

    it('a well-formed marker with no real namespace behind it terminates with 71', () => {
        // The nonce pairing is satisfiable by anyone who can write a file and
        // set an env var. What is NOT forgeable is the kernel's answer, so this
        // case is the one that proves the marker alone is not the criterion.
        const dir = tmp('fakens');
        writeMarker(dir, { nonce: 'abc123', sub_netns: 'net:[4026539999]', host_netns: 'net:[4026531840]' });
        const r = run({ F2AI_ISO_EVID: dir, F2AI_ISO_NONCE: 'abc123' });
        expect(r.status).toBe(FATAL);
        // On Linux the process is in some other namespace; off Linux /proc is
        // unreadable. Either way the claim is refused by the kernel, not by us.
        expect(r.stderr).toMatch(/not the subtree namespace|is unreadable|HOST namespace/);
    });
});

describe('d5 mutant: an in-process monkey patch is substituted', () => {
    it('patching net.Socket.prototype.connect cannot satisfy the precondition', () => {
        // M-G1-02 refuted the patch as evidence. This proves the new check is
        // not satisfiable by one: the marker gate runs first and the patch has
        // nothing to say about /proc/self/ns/net.
        const dir = tmp('patched');
        writeMarker(dir, { nonce: 'abc123', sub_netns: 'net:[4026539999]', host_netns: 'net:[4026531840]' });
        const pre = path.join(dir, 'preload.mjs');
        fs.writeFileSync(pre, [
            "import net from 'node:net';",
            'const e = Object.assign(new Error("patched"), { code: "ENETUNREACH" });',
            'net.Socket.prototype.connect = function () { throw e; };',
            'net.connect = () => { throw e; };',
            ''
        ].join('\n'));
        const r = run({ F2AI_ISO_EVID: dir, F2AI_ISO_NONCE: 'abc123' },
            ['--import', `file://${pre.replace(/\\/g, '/')}`]);
        expect(r.status, 'a monkey patch must not be able to fake the boundary').toBe(FATAL);
        expect(r.stdout).not.toContain('markerVerified');
    });
});

describe('the refuted assertion is gone from the #2326 guard', () => {
    const src = fs.readFileSync(MESH_GUARD, 'utf8');

    it('the in-process monkey patch and its case are deleted', () => {
        expect(src).not.toContain('E_OUTBOUND_BLOCKED');
        expect(src).not.toContain('net.Socket.prototype.connect =');
        expect(src).not.toMatch(/globalThis as \{ fetch: unknown \}/);
        expect(src).not.toContain('outbound network is blocked in this process');
    });

    it('it requires the marker AND the empirical blocking check instead', () => {
        expect(src).toContain('requireIsolationBoundary');
        expect(src).toContain('await requireIsolationBoundary()');
        expect(src).toContain('ENETUNREACH');
        expect(src).toContain('EACCES');
        expect(src).toContain('BOUNDARY.observedNetns');
        expect(src).toContain('BOUNDARY.hostNetns');
    });

    it('the boundary check runs at import time, before any other case', () => {
        const at = src.indexOf('await requireIsolationBoundary()');
        const firstDescribe = src.indexOf('describe(');
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(firstDescribe);
    });
});
