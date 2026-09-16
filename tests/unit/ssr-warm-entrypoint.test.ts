// tests/unit/ssr-warm-entrypoint.test.ts
//
// ENTRY-POINT verification: spawns `node scripts/factory/warm-ssr.js` as a real
// PROCESS against a local node:http server, driving real curl.
//
// WHY THIS FILE EXISTS. Pure-function tests and static text locks do not
// substitute for it. Moving the warm loop into Node was motivated by an exit
// code being discarded, and the one real defect this work found (a literal
// `/dev/null` -> curl exit 23 on every URL) lived in exactly the I/O layer that
// classifier unit tests never touch. So this covers, as a process: argument
// passing, os.devNull, NON-ZERO EXIT-CODE CAPTURE, continue-after-failure, the
// summary buckets, and the budget constraining execution rather than starts.
//
// The file is SPAWNED, not imported, so the shebang/vitest-transform problem
// that pushed the pure helpers into ssr-warm-core.js does not apply here.
//
// No outbound network and no Factory trigger: SSR_ORIGIN (already honoured by
// the runner) points at 127.0.0.1, and NO_PROXY keeps curl off any proxy.
//
// Every run passes SSR_WARM_BUDGET_MS so the suite is bounded even when the
// origin never answers.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'child_process';
import fs from 'fs';
import http from 'http';
import path from 'path';
import os from 'os';

const RUNNER = path.resolve(__dirname, '../../scripts/factory/warm-ssr.js');

/** Path -> behaviour, keyed by the tails of SSR_WARM_PATHS. */
const ROUTES: Record<string, 'ok' | 'error' | 'reset'> = {
  '/': 'ok',
  '/ranking': 'error',
  '/api/v1/entity/meta-llama/Llama-3.1-8B-Instruct': 'reset',
  '/api/v1/entity/openai-community/gpt2': 'ok',
  '/model/meta-llama/Llama-3.1-8B-Instruct': 'ok',
  '/models': 'ok'
};

let server: http.Server;
let origin = '';
let hangAll = false;
let hits = 0;
const seenAgents: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits += 1;
    seenAgents.push(String(req.headers['user-agent'] || ''));
    if (hangAll) return;                                   // never respond
    const mode = ROUTES[req.url || ''] ?? 'ok';
    if (mode === 'reset') { req.socket.destroy(); return; }
    if (mode === 'error') { res.writeHead(500); res.end('boom'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>ok</html>');
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>(r => { server.closeAllConnections?.(); server.close(() => r()); });
});

/**
 * ASYNC spawn, deliberately. spawnSync would block this process's event loop for
 * the whole run - and the stub server lives in THIS process, so it could never
 * answer: curl would sit until its own --max-time on every URL and the server
 * would record zero requests. That is exactly what an earlier revision of this
 * file did, and the symptom (all timeouts, zero hits) reads like a blocked
 * network rather than a blocked event loop.
 */
function runRunner(budgetMs: number): Promise<{ status: number | null; signal: string | null; stdout: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [RUNNER], {
      env: {
        ...process.env,
        SSR_ORIGIN: origin,
        SSR_WARM_BUDGET_MS: String(budgetMs),
        NO_PROXY: '127.0.0.1,localhost',
        no_proxy: '127.0.0.1,localhost'
      }
    });
    let stdout = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', () => {});
    // Harness stop, well clear of the phase budget under test.
    const fuse = setTimeout(() => child.kill('SIGKILL'), budgetMs + 30_000);
    child.on('close', (status, signal) => {
      clearTimeout(fuse);
      resolve({ status, signal, stdout });
    });
  });
}

/** The per-URL record lines only; the summary and disclaimer carry no `http=`. */
const warmLines = (out: string) => out.split('\n').filter(l => l.includes('[warm]') && / http=/.test(l));
const summaryLine = (out: string) => out.split('\n').find(l => l.includes('[warm] summary:')) || '';

describe('warm-ssr.js as a process, against a reachable origin', () => {
  it('captures status and exit code per URL, keeps going past failures, exits 0', async () => {
    hits = 0;
    const r = await runRunner(30_000);
    const lines = warmLines(r.stdout);

    // Preflight, so a stub server that never answered fails with a readable
    // cause rather than as a confusing bucket mismatch. This suite is NOT
    // allowed to pass vacuously when the origin was never reached.
    expect(hits, `the runner never reached the local stub origin (${origin}) - ` +
      'check that this process is not blocking its own event loop').toBeGreaterThan(0);

    // Non-fatal contract, observed at the process level, not by text match.
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();

    // Continue-after-failure: all six ran, in order, despite #2 and #3 failing.
    expect(lines).toHaveLength(6);
    expect(lines[1]).toContain('/ranking');
    expect(lines[5]).toContain('/models');

    // Argument passing: curl parsed the argv and sent our -H header.
    expect(seenAgents.some(a => a.includes('Nexus-Warmer/1.0'))).toBe(true);

    // os.devNull is a writable sink for curl here. If it were not, curl would
    // exit 23 (CURLE_WRITE_ERROR) on EVERY URL - what a literal '/dev/null' did.
    expect(lines.filter(l => l.includes('exit=23'))).toHaveLength(0);

    // A served 500 is an http-failure with a CLEAN curl exit.
    expect(lines[1]).toMatch(/http-failure\s+http=500\s+exit=0/);

    // NON-ZERO EXIT-CODE CAPTURE: a reset connection surfaces curl's own exit
    // code, which the previous `|| true` loop discarded entirely.
    expect(lines[2]).toContain('transfer-failure');
    const exit = /exit=(\d+)/.exec(lines[2]);
    expect(exit).not.toBeNull();
    expect(Number(exit![1])).toBeGreaterThan(0);

    expect(summaryLine(r.stdout)).toContain('total=6 succeeded=4 http-failure=1 transfer-failure=1');
  }, 90_000);
});

describe('warm-ssr.js as a process, against a stalled origin', () => {
  it('records a timeout and then STOPS STARTING work: the budget bounds execution', async () => {
    hangAll = true;
    try {
      // 9s budget -> the first URL gets curlCapForRemaining(9000) = 6000ms of
      // curl time; afterwards less than MIN_URL_SLOT_MS remains, so the rest are
      // skipped rather than started. This is the whole point of the F1 fix: the
      // budget constraining EXECUTION, observed on the real entry point.
      const r = await runRunner(9_000);
      const lines = warmLines(r.stdout);
      expect(r.status).toBe(0);
      expect(r.signal).toBeNull();
      expect(lines).toHaveLength(6);
      expect(lines[0]).toMatch(/timeout\s+http=---\s+exit=28/);   // curl's own cap
      expect(lines[1]).toContain('skipped');
      expect(summaryLine(r.stdout)).toMatch(/timeout=1 skipped=5/);
    } finally {
      hangAll = false;
    }
  }, 90_000);
});

describe('the subprocess bound rests on SIGKILL, not on the SIGTERM default', () => {
  // Node documents, for execFileSync/spawnSync: "When a timeout has been
  // encountered and killSignal is sent, the method won't return until the
  // process has completely exited... If the child process intercepts and
  // handles the SIGTERM signal and does not exit, the parent process will still
  // wait until the child process has exited." killSignal defaults to 'SIGTERM'.
  // So a `timeout:` alone bounds nothing. These execute that claim rather than
  // restating it. The child installs a SIGTERM handler that does NOT exit, plus
  // a 6s self-fuse so a failing assertion can never hang the suite.
  const IGNORES_SIGTERM =
    "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),6000);setInterval(()=>{},1000)";

  function waitFor(killSignal: 'SIGTERM' | 'SIGKILL') {
    const startedAt = Date.now();
    try {
      execFileSync(process.execPath, ['-e', IGNORES_SIGTERM], { timeout: 700, killSignal, stdio: 'ignore' });
    } catch { /* expected: ETIMEDOUT */ }
    return Date.now() - startedAt;
  }

  it('SIGKILL bounds the wait - this is what the runner relies on', () => {
    expect(waitFor('SIGKILL')).toBeLessThan(3_000);
  }, 30_000);

  it.skipIf(os.platform() === 'win32')(
    'SIGTERM does NOT bound the wait on POSIX, so the default would have been unsound',
    () => {
      // Returns only when the child's own 6s fuse fires, not at the 700ms timeout.
      expect(waitFor('SIGTERM')).toBeGreaterThan(3_000);
    }, 30_000);

  it('the runner passes SIGKILL rather than accepting the default', () => {
    const src = fs.readFileSync(RUNNER, 'utf8');
    expect(src).toContain("const KILL_SIGNAL = 'SIGKILL';");
    expect(src).toContain('killSignal: KILL_SIGNAL');
  });
});
