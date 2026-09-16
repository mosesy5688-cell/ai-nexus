// tests/unit/ssr-warm-workflow-wiring.test.ts
//
// STATIC text lock on the wiring of the live-SSR warm phase in
// .github/workflows/factory-upload.yml. No workflow execution, no network, no
// YAML dependency - the file is read as CRLF-normalised text.
//
// What this pins, and why each item matters:
//   - the warm phase is driven by scripts/factory/warm-ssr.js (so the URL set and
//     the classification are the unit-tested ones, not a second inline copy);
//   - the inline `SSR_WARM_URLS=(...)` bash loop is gone (one source of truth);
//   - `|| true` is still there and the runner still exits 0, so the publication
//     gate is unchanged;
//   - the health monitor job still reserves its 10-minute timeout and still
//     uploads health-report.json with `if: always()`.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const UPLOAD_WF = path.resolve(__dirname, '../../.github/workflows/factory-upload.yml');
const HEALTH_WF = path.resolve(__dirname, '../../.github/workflows/global-health-monitor.yml');
const RUNNER = path.resolve(__dirname, '../../scripts/factory/warm-ssr.js');

const upload = fs.readFileSync(UPLOAD_WF, 'utf8').replace(/\r\n/g, '\n');
const health = fs.readFileSync(HEALTH_WF, 'utf8').replace(/\r\n/g, '\n');
const runner = fs.readFileSync(RUNNER, 'utf8').replace(/\r\n/g, '\n');

/** Slice the `Purge & Warm CDN` step up to the next top-level step. */
function warmStep(): string {
  const start = upload.indexOf('- name: Purge & Warm CDN');
  expect(start).toBeGreaterThan(-1);
  const rest = upload.slice(start + 1);
  const next = rest.search(/\n {6}- (name|uses):/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('factory-upload.yml - live-SSR warm wiring', () => {
  const step = warmStep();

  it('drives the warm phase through the unit-tested runner', () => {
    expect(step).toContain('node scripts/factory/warm-ssr.js');
  });

  it('no second inline copy of the warm URL list survives in the workflow', () => {
    // A stale inline list would silently reinstate the missing / and /ranking.
    expect(upload).not.toContain('SSR_WARM_URLS=(');
    expect(upload).not.toContain('Warming SSR:');
  });

  it('the publication gate is unchanged: the warm invocation is still non-fatal', () => {
    expect(step).toMatch(/node scripts\/factory\/warm-ssr\.js \|\| true/);
  });

  it('the CDN warm loop above it is untouched', () => {
    // Contamination guard: this change must not have altered the CDN curls.
    expect(step).toContain('curl -s -o /dev/null --max-time 30 -H "User-Agent: Nexus-Warmer/1.0" "$url" || true');
    expect(step).toContain('https://cdn.free2aitools.com/data/shards_manifest.json');
  });
});

describe('warm-ssr.js - non-fatal by construction', () => {
  it('always sets exit code 0 and never calls process.exit with a failure', () => {
    expect(runner).toContain('process.exitCode = 0;');
    expect(runner).not.toMatch(/process\.exit\(1\)/);
    expect(runner).not.toMatch(/process\.exitCode\s*=\s*1/);
  });

  it('importing the module does not fire curls: main() runs only when invoked directly', () => {
    expect(runner).toContain('const invokedDirectly =');
    expect(runner).toContain('if (invokedDirectly) {');
  });

  it('states in the log that a warm result describes one request only', () => {
    expect(runner).toContain('not evidence that other isolates, regions or caches are warm');
  });

  it('writes the body to os.devNull, not a hardcoded /dev/null', () => {
    // Found by running this runner: with the literal, curl exits 23
    // (CURLE_WRITE_ERROR) on every URL off-Linux. The previous inline loop could
    // not have surfaced that, because `|| true` discarded curl's exit code.
    expect(runner).toContain("'-o', os.devNull");
    expect(runner).not.toContain("'-o', '/dev/null'");
  });

  it('keeps the per-URL cap and the User-Agent of the loop it replaces', () => {
    expect(runner).toContain("'--max-time', String(PER_URL_MAX_TIME_S)");
    expect(runner).toContain("'User-Agent: Nexus-Warmer/1.0'");
  });
});

describe('global-health-monitor.yml - report output survives a failing audit', () => {
  it('still reserves a 10-minute job timeout', () => {
    expect(health).toContain('timeout-minutes: 10');
  });

  it('still uploads health-report.json with if: always()', () => {
    expect(health).toContain('name: Upload Health Report');
    expect(health).toContain('if: always()');
    expect(health).toContain('path: health-report.json');
  });
});
