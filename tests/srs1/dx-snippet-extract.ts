/**
 * SRS-1 / P3-DX-1 — shared snippet extractor (hermetic helper, not a test file).
 *
 * Extracts the EXACT curl / JS / Python reference snippets shipped in
 * developers.astro so the regression tests assert on the real artifact rather
 * than a test-only rewrite (R4). Reads SOURCE only; no network, deterministic.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const SITE = 'https://free2aitools.com';
export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');

export const DEV = read('src/pages/developers.astro');
export const README = read('README.md');
export const LLMS = read('src/data/llms-template.txt');
export const MCP = read('public/.well-known/mcp.json');

// Capture the JS template-literal body for `const <name> = `...`;` then resolve
// the Astro interpolation ${SITE} and un-escape \` / \${ so the result is the
// literal text the page renders/ships.
export function extractSnippet(name: string): string {
  const m = DEV.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;'));
  if (!m) throw new Error(`developers.astro must define ${name}`);
  return m[1]
    .replace(/\$\{SITE\}/g, SITE) // the only real interpolation in the snippets
    .replace(/\\`/g, '`')
    .replace(/\\\$\{/g, '${');
}

export const curlSnippet = extractSnippet('curlSnippet');
export const jsSnippet = extractSnippet('jsSnippet');
export const pySnippet = extractSnippet('pySnippet');
