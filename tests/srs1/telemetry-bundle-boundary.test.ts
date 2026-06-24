/**
 * SRS-1 TEL-BUNDLE-BOUNDARY -- P2 Adoption Telemetry route-local re-attempt
 * (Founder D-2026-0624-103). The #2218 PREVENTION gate.
 *
 * #2218 root cause: a middleware STATIC-import path pulled a module into the
 * Worker startup chain and produced a production SSR empty-body-500. This suite
 * statically walks the middleware import graph (the eager Worker-startup chain)
 * and asserts NO telemetry module is reachable from it -- so telemetry can never
 * be in the middleware eager-load path again.
 *
 * Gates: 9 middleware has NO telemetry import edge; 10 bundle/startup path
 * excludes telemetry; 16 NON-VACUITY -- the walk FAILS if a forbidden
 * middleware->telemetry import is injected (mutation proof, repo stays clean).
 *
 * Hermetic: pure source-graph walk over repo files (no bundler, no network).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const TELEMETRY_DIR = path.join(ROOT, 'src/lib/telemetry');

// Resolve a static-import specifier (relative or @/ alias) from a source file to
// an on-disk module path; returns null for bare/external specifiers (astro:*,
// node:*, npm packages) which are NOT part of our source graph walk.
function resolveSpecifier(fromFile: string, spec: string): string | null {
  let base: string | null = null;
  if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith('@/')) base = path.resolve(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('src/')) base = path.resolve(ROOT, spec);
  else return null; // external / virtual module -> not in our walk
  const cands = [base, base + '.ts', base + '.js', base + '.tsx',
    path.join(base, 'index.ts'), path.join(base, 'index.js')];
  for (const c of cands) { if (fs.existsSync(c) && fs.statSync(c).isFile()) return c; }
  // .js specifier that maps to a .ts source (Astro TS-with-.js-ext convention)
  if (spec.endsWith('.js')) { const ts = base.replace(/\.js$/, '.ts'); if (fs.existsSync(ts)) return ts; }
  return null;
}

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
function staticImportsOf(file: string): string[] {
  const src = fs.readFileSync(file, 'utf-8');
  const specs: string[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) { const s = m[1] || m[2]; if (s) specs.push(s); }
  return specs;
}

/** Transitively walk the static-import graph from an entry file. */
function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const spec of staticImportsOf(f)) {
      const r = resolveSpecifier(f, spec);
      if (r && !seen.has(r)) stack.push(r);
    }
  }
  return seen;
}

const isTelemetryModule = (f: string) => path.resolve(f).startsWith(TELEMETRY_DIR + path.sep);

describe('TEL-BUNDLE-BOUNDARY: middleware startup chain excludes telemetry', () => {
  const MIDDLEWARE = path.join(ROOT, 'src/middleware.ts');

  it('GATE 9: middleware.ts has NO direct telemetry import edge', () => {
    expect(fs.existsSync(MIDDLEWARE)).toBe(true);            // anti-vacuity: entry exists
    const direct = staticImportsOf(MIDDLEWARE)
      .map((s) => resolveSpecifier(MIDDLEWARE, s))
      .filter((r): r is string => !!r);
    expect(direct.some(isTelemetryModule)).toBe(false);
  });

  it('GATE 10: NO telemetry module is reachable from the middleware startup chain', () => {
    const reachable = reachableFrom(MIDDLEWARE);
    expect(reachable.size).toBeGreaterThan(0);              // anti-vacuity: it walked
    const telemetryReachable = [...reachable].filter(isTelemetryModule);
    expect(telemetryReachable, `telemetry leaked into middleware chain: ${telemetryReachable.join(', ')}`).toEqual([]);
  });

  it('GATE 16: NON-VACUITY mutation -- injecting a middleware->telemetry import MAKES the '
    + 'walk FAIL; removing it restores PASS (repo stays clean)', () => {
    const original = fs.readFileSync(MIDDLEWARE, 'utf-8');
    // Baseline: clean.
    expect([...reachableFrom(MIDDLEWARE)].some(isTelemetryModule)).toBe(false);
    try {
      // Inject the exact #2218-class edge: a static import from middleware into
      // a telemetry module. The walk MUST now flag telemetry as reachable.
      const injected = `import { emit } from './lib/telemetry/ae-adapter';\nvoid emit;\n` + original;
      fs.writeFileSync(MIDDLEWARE, injected, 'utf-8');
      const reachable = reachableFrom(MIDDLEWARE);
      expect([...reachable].some(isTelemetryModule)).toBe(true);   // mutation DETECTED
    } finally {
      fs.writeFileSync(MIDDLEWARE, original, 'utf-8');             // revert -> clean
    }
    // Removed: clean again.
    expect([...reachableFrom(MIDDLEWARE)].some(isTelemetryModule)).toBe(false);
  });

  it('GATE 16b: the walker actually resolves a known good edge (resolver non-vacuity)', () => {
    // ae-adapter imports ./schema -> the walker MUST resolve that real edge, else
    // the negative results above would be vacuously true.
    const adapter = path.join(TELEMETRY_DIR, 'ae-adapter.ts');
    const reachable = reachableFrom(adapter);
    expect([...reachable].some((f) => f.endsWith(path.join('telemetry', 'schema.ts')))).toBe(true);
    expect([...reachable].some((f) => f.endsWith(path.join('telemetry', 'vocab.ts')))).toBe(true);
  });
});
