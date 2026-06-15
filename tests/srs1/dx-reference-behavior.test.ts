/**
 * SRS-1 / P3-DX-1 — Developer-journey reference-example behavioral tier
 * (tier-1, hermetic). Companion to `dx-reference-examples.test.ts` (static tier).
 *
 * R5 JS syntax+behavior | R6 Python syntax+behavior.
 *
 * HERMETIC: runs the EXACT JS/Python snippets shipped in developers.astro against
 * a local in-process mock HTTP server (no live network, no production dependency).
 * Mock runs use async execFile so the in-process server keeps serving; the python
 * run bypasses any sandbox HTTP(S)_PROXY for the loopback target (harness-only
 * env — the snippet is executed verbatim). Deterministic across runs.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:http';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { jsSnippet, pySnippet } from './dx-snippet-extract';

const execFileAsync = promisify(execFile);

// --- scriptable in-process mock server --------------------------------------
type Plan = Array<{ status: number; headers?: Record<string, string>; body?: unknown }>;
let server: Server;
let baseUrl = '';
const plans: Record<string, Plan> = { search: [], entity: [], compare: [] };
function nextFor(path: string) {
  const key = path.includes('/search') ? 'search' : path.includes('/entity') ? 'entity' : 'compare';
  const plan = plans[key];
  return plan.length > 1 ? plan.shift()! : plan[0];
}
beforeAll(async () => {
  server = createServer((req, res) => {
    const r = nextFor(req.url || '');
    const headers = { 'content-type': 'application/json', ...(r?.headers || {}) };
    res.writeHead(r?.status ?? 200, headers);
    res.end(r?.body === undefined ? '{}' : JSON.stringify(r.body));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const addr = server.address();
  baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(() => server?.close());

function twoResultSearch() {
  return { status: 200, body: { version: 'fni_v2.0', results: [
    { id: 'fixture-id-1', name: 'A', type: 'model', fni_score: 80 },
    { id: 'fixture-id-2', name: 'B', type: 'model', fni_score: 70 },
  ] } };
}
const entityOk = { status: 200, body: { entity: { id: 'fixture-id-1', fni: { factors: { semantic: null, authority: 90 } } } } };
const compareOk = { status: 200, body: { entities: [] } };

// --- R5: JS syntax + behavior -----------------------------------------------
describe('R5: shipped JS snippet syntax + behavior against a mock server', () => {
  it('parses as valid JS (Function constructor does not throw)', () => {
    const body = jsSnippet.replace(/export async function/, 'async function');
    expect(() => new Function(body)).not.toThrow();
  });

  async function loadPick(base: string) {
    const dir = mkdtempSync(join(tmpdir(), 'f2ai-js-'));
    const file = join(dir, 'snippet.mjs');
    process.env.F2AI_BASE = base; // configurable base, snippet run unmodified
    writeFileSync(file, jsSnippet, 'utf8');
    try {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      return { pick: mod.pickCandidates as (q?: string) => Promise<any>, dir };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }

  it('success: derives ids from results, fetches entity + compare', async () => {
    plans.search = [twoResultSearch()];
    plans.entity = [entityOk];
    plans.compare = [compareOk];
    const { pick, dir } = await loadPick(baseUrl);
    const out = await pick('code');
    expect(out.ids).toEqual(['fixture-id-1', 'fixture-id-2']);
    expect(out.factors).toEqual({ semantic: null, authority: 90 }); // null preserved
    rmSync(dir, { recursive: true, force: true });
  });

  it('zero/one result: throws (no silent empty-path)', async () => {
    plans.search = [{ status: 200, body: { results: [{ id: 'only-one' }] } }];
    const { pick, dir } = await loadPick(baseUrl);
    await expect(pick('x')).rejects.toThrow(/need >= 2 results/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('400 is non-retryable (throws immediately)', async () => {
    plans.search = [{ status: 400 }];
    const { pick, dir } = await loadPick(baseUrl);
    await expect(pick('x')).rejects.toThrow(/non-retryable 400/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('404 is non-retryable (throws immediately)', async () => {
    plans.search = [{ status: 404 }];
    const { pick, dir } = await loadPick(baseUrl);
    await expect(pick('x')).rejects.toThrow(/non-retryable 404/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('429 then success: retries honoring Retry-After, then proceeds', async () => {
    plans.search = [{ status: 429, headers: { 'retry-after': '0' } }, twoResultSearch()];
    plans.entity = [entityOk];
    plans.compare = [compareOk];
    const { pick, dir } = await loadPick(baseUrl);
    const out = await pick('x');
    expect(out.ids.length).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('503 exhausts retries (max 2) then throws', async () => {
    plans.search = [{ status: 503, headers: { 'retry-after': '0' } }];
    const { pick, dir } = await loadPick(baseUrl);
    await expect(pick('x')).rejects.toThrow(/failed 503/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('500 is not retried (throws on first response)', async () => {
    plans.search = [{ status: 500 }];
    const { pick, dir } = await loadPick(baseUrl);
    await expect(pick('x')).rejects.toThrow(/failed 500/);
    rmSync(dir, { recursive: true, force: true });
  });
});

// --- R6: Python syntax + behavior -------------------------------------------
function haveRequests(): boolean {
  try {
    execFileSync('python', ['-c', 'import requests'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
describe('R6: shipped Python snippet syntax + behavior', () => {
  it('compiles (py_compile) and carries required status/retry/null-safe constructs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'f2ai-py-'));
    const file = join(dir, 'snippet.py');
    writeFileSync(file, pySnippet, 'utf8');
    let compiled = false;
    try {
      execFileSync('python', ['-c', `import py_compile; py_compile.compile(${JSON.stringify(file)}, doraise=True)`], { stdio: 'pipe' });
      compiled = true;
    } catch {
      compiled = false;
    }
    rmSync(dir, { recursive: true, force: true });
    expect(compiled, 'python snippet must compile').toBe(true);
    expect(pySnippet).toMatch(/python -m pip install requests/);
    expect(pySnippet).toMatch(/status_code in \(400, 404\)/);
    expect(pySnippet).toMatch(/status_code in \(429, 503\) and attempt < 2/);
    expect(pySnippet).toMatch(/raise_for_status\(\)/);
    expect(pySnippet).toMatch(/results = search\.get\("results"\) or \[\]/);
    expect(pySnippet).toMatch(/len\(results\) < 2/);
  });

  it.runIf(haveRequests())('executes against the mock server (success + null preserved)', async () => {
    plans.search = [twoResultSearch()];
    plans.entity = [entityOk];
    plans.compare = [compareOk];
    const dir = mkdtempSync(join(tmpdir(), 'f2ai-pyrun-'));
    const file = join(dir, 'run.py');
    const driver = `${pySnippet}\nout = pick_candidates("code")\nassert out["ids"] == ["fixture-id-1","fixture-id-2"], out\nassert out["factors"] == {"semantic": None, "authority": 90}, out\nprint("OK")\n`;
    writeFileSync(file, driver, 'utf8');
    let ok = false;
    try {
      // Bypass any sandbox HTTP(S)_PROXY for the loopback mock (harness-only env).
      const env = { ...process.env, F2AI_BASE: baseUrl, NO_PROXY: '127.0.0.1,localhost' };
      delete (env as any).HTTP_PROXY; delete (env as any).HTTPS_PROXY;
      delete (env as any).http_proxy; delete (env as any).https_proxy;
      const { stdout } = await execFileAsync('python', [file], { env });
      ok = stdout.includes('OK');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(ok).toBe(true);
  });
});
