/**
 * SRS-1 — served-type contract invariant (tier-1, hermetic). [D-121 / G-1]
 *
 * INVARIANT: no public surface advertises a CANCELLED / MERGED entity type as a
 * served, navigable, or filterable type. The retired type ids are:
 *   - `agent`  — cancelled  (/agents 301s to /tools)
 *   - `space`  — merged into model (/spaces 301s to /models)
 *   - `prompt` — cancelled  (/prompts 301s to /tools)
 * (`report` was retired earlier — V27.36 — and is also asserted absent.)
 *
 * The single served-type source of truth is the homepage Header nav + the
 * OpenAPI/MCP `type` filter enum. This guard pins three machine/presentation
 * surfaces to that served set so a regression cannot re-surface a dead type:
 *   (a) src/components/mesh/MeshVisualizer.astro typeConfig keys (homepage nav grid)
 *   (b) src/data/openapi-schema.json search `type` param enum
 *   (c) src/data/llms-template.txt `?type=` filter list ("Canonical types")
 *
 * IMPORTANT: these surfaces legitimately use the WORD "agent" in the identity
 * phrase ("structured … layer for AI agents"). This guard therefore matches the
 * cancelled ENTITY-TYPE IDS in type-vocabulary positions only (config keys /
 * enum arrays / the `?type=` canonical list) — never the free-prose word.
 *
 * HERMETIC: reads repo SOURCE + parses static JSON. No live fetch. Deterministic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);
const schema = require('../../src/data/openapi-schema.json');

// Single shared source of truth for the cancelled/merged (non-served) type ids.
const CANCELLED_TYPES = ['agent', 'space', 'prompt', 'report'] as const;
// The currently-served entity types (mirrors Header.astro nav + OpenAPI enum).
const SERVED_NAV_TYPES = ['model', 'tool', 'dataset', 'paper', 'knowledge'] as const;

describe('SRS-1 G-1 (a): MeshVisualizer homepage nav grid lists only served types', () => {
    const src = read('src/components/mesh/MeshVisualizer.astro');
    // Extract the typeConfig object literal and pull its top-level keys.
    const block = (src.match(/const typeConfig = \{([\s\S]*?)\n\};/) || [, ''])[1];

    it('typeConfig block is present and non-empty', () => {
        expect(block.length).toBeGreaterThan(0);
    });

    const keys = [...block.matchAll(/^\s*([a-z]+):\s*\{/gm)].map((m) => m[1]);

    it('typeConfig keys EXACTLY equal the served nav set (no missing, no extra)', () => {
        expect(keys.slice().sort()).toEqual([...SERVED_NAV_TYPES].slice().sort());
    });

    for (const t of CANCELLED_TYPES) {
        it(`typeConfig does NOT declare cancelled type \`${t}\``, () => {
            expect(keys).not.toContain(t);
            // Also assert no /<type>s nav href to a 301 redirect route.
            expect(block).not.toMatch(new RegExp(`href:\\s*'/${t}s?'`));
        });
    }
});

describe('SRS-1 G-1 (b): OpenAPI search `type` enum lists only served types', () => {
    const searchPath = schema.paths['/api/v1/search'].get;
    const typeParam = searchPath.parameters.find((p: any) => p.name === 'type');
    const values: string[] = typeParam.schema.enum;

    it('type enum is present', () => {
        expect(Array.isArray(values)).toBe(true);
        expect(values.length).toBeGreaterThan(0);
    });

    for (const t of CANCELLED_TYPES) {
        it(`type enum does NOT include cancelled type \`${t}\``, () => {
            expect(values).not.toContain(t);
        });
    }
});

describe('SRS-1 G-1 (c): llms-template `?type=` canonical list lists only served types', () => {
    const llms = read('src/data/llms-template.txt');
    // Isolate the "## Entity types" canonical list block (between the heading and
    // the next top-level "## " heading) so the identity-phrase "AI agents" prose
    // elsewhere in the file is NOT scanned.
    const block = (llms.match(/## Entity types[\s\S]*?(?=\n## )/) || [''])[0];

    it('Entity types block is present', () => {
        expect(block.length).toBeGreaterThan(0);
    });

    for (const t of CANCELLED_TYPES) {
        it(`canonical type list does NOT advertise \`${t}\` as a filter value`, () => {
            // Match a back-ticked type token, e.g. "`agent`" / "`space`" / "`prompt`".
            expect(block).not.toMatch(new RegExp('`' + t + '`'));
        });
    }

    it('canonical list still advertises the served filterable types', () => {
        for (const t of ['model', 'paper', 'tool', 'dataset']) {
            expect(block).toMatch(new RegExp('`' + t + '`'));
        }
    });
});
