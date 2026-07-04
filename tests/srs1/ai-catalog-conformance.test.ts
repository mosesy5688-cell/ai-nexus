/**
 * SRS-1 — B1-MINIMAL ai-catalog provider-manifest conformance (tier-1, hermetic).
 *
 * Locks the self-hosted ARD / ai-catalog manifest served at
 * /.well-known/ai-catalog.json (src/pages/.well-known/ai-catalog.json.ts):
 *   - valid JSON; required root fields (specVersion + entries); host.displayName;
 *     each entry identifier (urn:air:) + type + EXACTLY ONE of url/data;
 *     representativeQueries 2-5 where present;
 *   - schema conformance via a SPEC-DERIVED JSON-Schema-2020-12 (ajv/dist/2020).
 *     ORACLE NOTE: the official published ai-catalog.schema.json URL returned 404
 *     at implementation time (ARD is a ~6-week draft) and the ARD conformance CLI
 *     was not run; this schema is hand-encoded from the ai-catalog.io / ARD
 *     spec required-field structure, so it is a spec-DERIVED oracle, not the
 *     official schema or a CLI result;
 *   - FORBIDDEN-CLAIM absence over the exact served bytes (no router / recommender
 *     / best-model / optimal / verdict / execute / runtime / source_trail /
 *     attestation / paid-sponsor / L3-Trusted public copy);
 *   - no runtime/execution capability declared; L2 Discoverable ONLY (no
 *     trustManifest / attestation);
 *   - vocabulary parity: identity + boundary strings match mcp.json / llms-template
 *     / mcp.ts (no drift);
 *   - emitted Content-Type is application/ai-catalog+json.
 *
 * HERMETIC: imports the pure builder + GET, reads repo SOURCE/CONFIG. No live
 * fetch, no build dependency. Deterministic across runs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { buildAiCatalog, GET } from '../../src/pages/.well-known/ai-catalog.json.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

const ORIGIN = 'https://free2aitools.com';
const manifest = buildAiCatalog(ORIGIN);
const bytes = JSON.stringify(manifest, null, 2);

const mcpJson = require('../../public/.well-known/mcp.json');
const LLMS = read('src/data/llms-template.txt');
const MCP_SRC = read('src/pages/api/mcp.ts');

// Spec-derived JSON-Schema-2020-12 (see ORACLE NOTE above).
const SCHEMA = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    required: ['specVersion', 'entries'],
    properties: {
        specVersion: { type: 'string', pattern: '^\\d+\\.\\d+$' },
        host: {
            type: 'object',
            required: ['displayName'],
            properties: {
                displayName: { type: 'string', minLength: 1 },
                identifier: { type: 'string' },
                documentationUrl: { type: 'string' },
                logoUrl: { type: 'string' },
            },
        },
        entries: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                required: ['identifier', 'type'],
                properties: {
                    identifier: { type: 'string', pattern: '^urn:air:' },
                    type: { type: 'string', minLength: 1 },
                    url: { type: 'string', minLength: 1 },
                    data: {},
                    displayName: { type: 'string' },
                    description: { type: 'string' },
                    tags: { type: 'array', items: { type: 'string' } },
                    capabilities: { type: 'array', items: { type: 'string' } },
                    representativeQueries: {
                        type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 5,
                    },
                    version: { type: 'string' },
                    updatedAt: { type: 'string' },
                },
                oneOf: [{ required: ['url'] }, { required: ['data'] }],
            },
        },
        metadata: { type: 'object' },
    },
};

describe('SRS-1 B1: ai-catalog manifest is valid JSON with required root fields', () => {
    it('serialized output round-trips as JSON', () => {
        expect(() => JSON.parse(bytes)).not.toThrow();
        expect(JSON.parse(bytes)).toEqual(manifest);
    });
    it('root has specVersion (Major.Minor) + non-empty entries array', () => {
        expect(typeof manifest.specVersion).toBe('string');
        expect(manifest.specVersion).toMatch(/^\d+\.\d+$/);
        expect(Array.isArray(manifest.entries)).toBe(true);
        expect(manifest.entries.length).toBeGreaterThan(0);
    });
    it('host carries a non-empty displayName (L2 requirement)', () => {
        expect(manifest.host.displayName).toBe('Free2AItools');
    });
});

describe('SRS-1 B1: every entry has identifier(urn:air:) + type + exactly one of url/data', () => {
    for (const e of manifest.entries) {
        it(`${e.identifier}: well-formed entry`, () => {
            expect(e.identifier).toMatch(/^urn:air:free2aitools\.com:/);
            expect(e.identifier).not.toMatch(/^urn:ai:/); // urn:air: not urn:ai:
            expect(typeof e.type).toBe('string');
            expect(e.type.length).toBeGreaterThan(0);
            const hasUrl = typeof (e as any).url === 'string';
            const hasData = 'data' in (e as any);
            expect(hasUrl !== hasData).toBe(true); // XOR
        });
    }
    it('MCP entry uses the canonical media-type application/mcp-server-card+json', () => {
        const mcp = manifest.entries.find((e) => e.identifier.endsWith(':mcp:server'));
        expect(mcp?.type).toBe('application/mcp-server-card+json');
    });
    it('representativeQueries, where present, carry 2-5 natural-language examples', () => {
        for (const e of manifest.entries) {
            const q = (e as any).representativeQueries;
            if (q === undefined) continue;
            expect(Array.isArray(q)).toBe(true);
            expect(q.length).toBeGreaterThanOrEqual(2);
            expect(q.length).toBeLessThanOrEqual(5);
        }
    });
});

describe('SRS-1 B1: schema conformance (spec-derived JSON-Schema-2020-12 via ajv)', () => {
    it('manifest validates against the spec-derived 2020-12 schema', () => {
        const Ajv2020 = require('ajv/dist/2020').default ?? require('ajv/dist/2020');
        const ajv = new Ajv2020({ allErrors: true, strict: false });
        const validate = ajv.compile(SCHEMA);
        const ok = validate(manifest);
        expect(validate.errors ?? []).toEqual([]);
        expect(ok).toBe(true);
    });
});

// FORBIDDEN public-copy claims — absolute absence over the exact served bytes.
// Each disavowal in the manifest is phrased to avoid the affirmative token, so a
// strict absence scan is correct (a claim, not a disclaimer, is what is banned).
const FORBIDDEN: RegExp[] = [
    /model\s*router/i, /recommendation\s*engine/i, /\bbest[\s-]?model\b/i, /\boptimal\b/i,
    /objective\s+verdict/i, /objective\s+truth/i, /runtime\s+execution/i, /\bexecute\b/i,
    /dynamic\s+runtime\s+discovery/i, /agent\s+capability\s+infrastructure/i, /\bdefinitive\b/i,
    /neural[\s-]?discovery/i, /actionable\s+toolchains?/i, /comprehensive\s+impact\s+index/i,
    /s&p\s*500/i, /source_trail/i, /\bsoc\s?2\b/i, /\bhipaa\b/i, /attestation/i,
    /trustmanifest/i, /\btrusted\b/i, /\bpaid\b/i, /\bsponsor/i, /\bpricing\b/i,
    /subscription/i, /\binvoice\b/i, /\bUSD\b/, /per\s+month/i,
];

describe('SRS-1 B1: forbidden-claim absence over the served bytes', () => {
    for (const re of FORBIDDEN) {
        it(`does not contain ${re}`, () => {
            expect(bytes).not.toMatch(re);
        });
    }
    it('declares NO runtime/execution capability', () => {
        for (const e of manifest.entries) {
            for (const c of (e as any).capabilities ?? []) {
                expect(c).not.toMatch(/execut|runtime|inference-run|host-model|serve-model|router/i);
            }
        }
    });
    it('is L2 Discoverable ONLY — no trustManifest / attestation / L3 claim', () => {
        expect(bytes).not.toMatch(/trustManifest/i);
        expect(bytes).not.toMatch(/\bL3\b/);
        expect((manifest.metadata as any).conformanceTier).toBe('L2 Discoverable');
    });
});

describe('SRS-1 B1: explicit negative boundary present (mirrors mcp.json / llms.txt)', () => {
    const b = (manifest.metadata as any).boundary as string;
    it('states discovery-only + no final choice + caller decides', () => {
        expect(b).toMatch(/discovery layer only/i);
        expect(b).toMatch(/makes no final tool choice/i);
        expect(b).toMatch(/the caller reviews the evidence and decides/i);
    });
    it('states live semantic/ANN ranking is not currently provided', () => {
        expect(b).toMatch(/live semantic\/ANN ranking is not currently provided/i);
    });
});

describe('SRS-1 B1: vocabulary parity vs mcp.json / llms-template / mcp.ts (no drift)', () => {
    // Normalize whitespace + case so a line-wrapped source (llms-template wraps
    // "for AI\nagents") still proves the shared phrase, not a formatting artifact.
    const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase();
    const IDENTITY = 'structured discovery, evidence, and identity layer for ai agents';
    it('shared identity phrase appears in the manifest AND mcp.json AND llms.txt', () => {
        expect(norm(bytes)).toContain(IDENTITY);
        expect(norm(JSON.stringify(mcpJson))).toContain(IDENTITY);
        expect(norm(LLMS)).toContain(IDENTITY);
    });
    it('shared "FNI (Free2AITools Nexus Index)" phrase matches mcp.ts + llms.txt', () => {
        const phrase = 'FNI (Free2AITools Nexus Index)';
        expect(bytes).toContain(phrase);
        expect(MCP_SRC).toContain(phrase);
        expect(LLMS).toContain(phrase);
    });
    it('shared "calling agent to reason over" clause matches mcp.ts SERVER_BOUNDARY', () => {
        const clause = 'calling agent to reason over';
        expect(bytes).toContain(clause);
        expect(MCP_SRC).toContain(clause);
    });
    it('shared "FNI-ranked" token matches mcp.json + llms.txt', () => {
        expect(bytes).toContain('FNI-ranked');
        expect(JSON.stringify(mcpJson)).toContain('FNI-ranked');
        expect(LLMS).toContain('FNI-ranked');
    });
});

describe('SRS-1 B1: GET emits application/ai-catalog+json', () => {
    it('response Content-Type is exactly application/ai-catalog+json', async () => {
        const res = await GET({ site: new URL(ORIGIN) } as any);
        expect(res.headers.get('content-type')).toBe('application/ai-catalog+json');
        const parsed = JSON.parse(await res.text());
        expect(parsed.specVersion).toBe(manifest.specVersion);
    });
});
