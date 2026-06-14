/**
 * SRS-1 — MCP tool-set parity invariant (tier-1, hermetic).
 *
 * INVARIANT (Founder, locked): the MCP surface advertises EXACTLY the five tools
 * search / rank / explain / select_model / compare — no more, no fewer — and the
 * two places that declare that set agree:
 *   1. the live JSON-RPC handler   src/pages/api/mcp.ts        (TOOLS array, served on tools/list)
 *   2. the static discovery doc     public/.well-known/mcp.json (tools[])
 * A drift (a sixth tool added to one but not the other, or a renamed tool, or a
 * silently dropped tool) breaks the contract an Agent relies on for capability
 * discovery. This is a SET-PARITY check between the two sources.
 *
 * HERMETIC: reads mcp.ts SOURCE (TOOLS is a private const, never executed) and
 * parses the static JSON. No module execution, no `cloudflare:workers` import, no
 * live fetch. Deterministic — identical on every run.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

// The canonical 5-tool set (prefixed names as published to Agents).
const EXPECTED_TOOLS = [
    'free2aitools_search',
    'free2aitools_rank',
    'free2aitools_explain',
    'free2aitools_select_model',
    'free2aitools_compare',
].sort();

// Extract `name: 'free2aitools_*'` literals from the mcp.ts TOOLS array source.
// We scope to the TOOLS array slice so an unrelated `name:` elsewhere can't leak in.
function mcpHandlerToolNames(): string[] {
    const src = read('src/pages/api/mcp.ts');
    const start = src.indexOf('const TOOLS = [');
    expect(start, 'mcp.ts must declare a TOOLS array').toBeGreaterThan(-1);
    // The TOOLS array is followed by `function jsonrpc(` — bound the slice there.
    const end = src.indexOf('function jsonrpc', start);
    expect(end, 'TOOLS array must be terminated before the helpers').toBeGreaterThan(start);
    const slice = src.slice(start, end);
    const names = [...slice.matchAll(/name:\s*'(free2aitools_[a-z_]+)'/g)].map((m) => m[1]);
    return names;
}

describe('SRS-1: MCP tool set is exactly the 5 canonical tools', () => {
    it('mcp.ts TOOLS array declares exactly the 5-tool set (no dup, no drift)', () => {
        const names = mcpHandlerToolNames();
        // No duplicates, exact set match.
        expect([...new Set(names)].length).toBe(names.length);
        expect(names.slice().sort()).toEqual(EXPECTED_TOOLS);
    });

    it('mcp.ts header comment also names the 5 tools (doc ⇄ array consistency)', () => {
        const src = read('src/pages/api/mcp.ts');
        // mcp.ts:4 — "5 tools: search, rank, explain, select_model, compare."
        expect(src).toMatch(/5 tools:\s*search,\s*rank,\s*explain,\s*select_model,\s*compare/);
    });
});

describe('SRS-1: static .well-known/mcp.json lists the SAME 5-tool set', () => {
    const mcpJson = require('../../public/.well-known/mcp.json');

    it('mcp.json declares exactly the 5 canonical tools (set parity with handler)', () => {
        expect(Array.isArray(mcpJson.tools)).toBe(true);
        const names = mcpJson.tools.map((t: any) => t.name);
        expect([...new Set(names)].length).toBe(names.length);
        expect(names.slice().sort()).toEqual(EXPECTED_TOOLS);
    });

    it('handler TOOLS and static mcp.json are byte-for-byte the same NAME SET', () => {
        const handlerSet = mcpHandlerToolNames().slice().sort();
        const docSet = mcpJson.tools.map((t: any) => t.name).slice().sort();
        expect(handlerSet).toEqual(docSet);
    });

    it('mcp.json points the transport URL at the live MCP route', () => {
        expect(mcpJson.url).toBe('https://free2aitools.com/api/mcp');
    });
});
