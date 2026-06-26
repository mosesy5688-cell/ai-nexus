/**
 * SRS-1 -- D-135 Lane C (Registry & Agent-Admission Metadata) guards.
 *
 * Lane C of Founder directive D-135. These are CONTRACT-PROJECTION /
 * DOCUMENTATION guards over static metadata surfaces, NOT behavior tests.
 *
 * Scope (Lane C only — does NOT touch Lane-A terms/privacy or Lane-B MCP
 * runtime):
 *  F1  official MCP Registry server.json CANDIDATE (review-only, non-served):
 *      cited schema; valid remote shape; canonical identity (domain / MCP-URL /
 *      server name) consistent across surfaces; namespace flagged UNVERIFIED;
 *      NO claim that Registry publication has occurred.
 *  F2  root LICENSE present (MIT) + OpenAPI license.url path resolves to it.
 *  F9  security-contact is a real URL (GitHub channels, no invented email);
 *      disconnect/removal text present; explicit no-account statement;
 *      truthful "no guaranteed deprecation window" statement.
 *  6.6 version-domain explanation present; surfaces do NOT falsely claim the
 *      version domains are equal.
 *  F8  HELD: NO telemetry/retention/analytics admission disclosure added now.
 *
 * HERMETIC: reads SOURCE/CONFIG only. No live fetch. Deterministic.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const abs = (rel: string) => resolve(root, rel);
const read = (rel: string) => readFileSync(abs(rel), 'utf8');

const CANDIDATE = 'docs/registry-candidate/server.json';
const ROOT_LICENSE = 'LICENSE';
const OPENAPI = 'src/data/openapi-schema.json';
const MCP_MANIFEST = 'public/.well-known/mcp.json';
const SECURITY_TXT = 'public/.well-known/security.txt';
const DEVELOPERS = 'src/pages/developers.astro';

// --- F1: official Registry candidate ------------------------------------
describe('SRS-1 D135-C F1: official MCP Registry candidate (review-only)', () => {
    const raw = read(CANDIDATE);
    const json = JSON.parse(raw);

    it('candidate file exists at a non-served docs path (not under public/)', () => {
        expect(existsSync(abs(CANDIDATE))).toBe(true);
        // It must NOT be the served well-known manifest.
        expect(CANDIDATE).not.toMatch(/^public\//);
        expect(CANDIDATE).not.toMatch(/\.well-known/);
    });

    it('cites the current official server.schema.json', () => {
        expect(json.$schema).toBe(
            'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
        );
    });

    it('has the schema-required fields name/description/version', () => {
        expect(typeof json.name).toBe('string');
        expect(json.name).toMatch(/\//); // namespaced
        expect(typeof json.description).toBe('string');
        expect(json.description.length).toBeGreaterThanOrEqual(1);
        expect(json.description.length).toBeLessThanOrEqual(100);
        // version: semver, no range / "latest".
        expect(json.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(json.version).not.toMatch(/latest|[\^~><=]/);
    });

    it('repository carries required url+source', () => {
        expect(json.repository.url).toBe('https://github.com/mosesy5688-cell/ai-nexus');
        expect(json.repository.source).toBe('github');
    });

    it('remotes carries a valid streamable-http remote to the live MCP URL', () => {
        expect(Array.isArray(json.remotes)).toBe(true);
        const r = json.remotes[0];
        expect(['streamable-http', 'sse']).toContain(r.type);
        expect(r.type).toBe('streamable-http');
        expect(r.url).toBe('https://free2aitools.com/api/mcp');
    });

    it('flags namespace/ownership as UNVERIFIED and NOT published', () => {
        const meta = json._meta['com.free2aitools/lane-c-candidate'];
        expect(meta.identity_ownership).toBe('IDENTITY_OWNERSHIP_UNVERIFIED');
        expect(meta.status).toMatch(/REVIEW_ONLY/);
        expect(JSON.stringify(meta)).toMatch(/NO Registry publication has occurred/);
    });

    it('does NOT claim a Registry publication occurred (anywhere in the file)', () => {
        expect(raw).not.toMatch(/published to the (official )?registry/i);
        expect(raw).not.toMatch(/registry publication (is )?(complete|done|succeeded)/i);
    });
});

// --- F1 canonical identity consistency ----------------------------------
describe('SRS-1 D135-C F1: canonical identity consistent across surfaces', () => {
    const candidate = JSON.parse(read(CANDIDATE));
    const mcp = JSON.parse(read(MCP_MANIFEST));

    it('MCP remote URL matches the served manifest url', () => {
        expect(candidate.remotes[0].url).toBe(mcp.url);
        expect(candidate.remotes[0].url).toBe('https://free2aitools.com/api/mcp');
    });

    it('server name + domain agree (reverse-DNS namespace on free2aitools)', () => {
        expect(candidate.name).toMatch(/free2aitools/);
        expect(candidate.remotes[0].url).toMatch(/free2aitools\.com/);
    });

    it('candidate transport matches the served manifest transport', () => {
        // manifest uses "streamable-http"; candidate remote type must agree.
        expect(candidate.remotes[0].type).toBe(mcp.transport);
    });
});

// --- F2: root LICENSE + OpenAPI license.url resolves ---------------------
describe('SRS-1 D135-C F2: root LICENSE present and license-URL resolves', () => {
    it('root LICENSE exists and is MIT with the SDK-aligned attribution', () => {
        expect(existsSync(abs(ROOT_LICENSE))).toBe(true);
        const lic = read(ROOT_LICENSE);
        expect(lic).toMatch(/MIT License/);
        expect(lic).toMatch(/Copyright \(c\) 2026 Free2AITools/);
    });

    it('root LICENSE matches the already-published SDK license attribution', () => {
        const rootLic = read(ROOT_LICENSE);
        const sdkLic = read('packages/sdk/LICENSE');
        // Same copyright holder line (project-name attribution, not a person/company).
        const line = 'Copyright (c) 2026 Free2AITools';
        expect(rootLic.includes(line)).toBe(true);
        expect(sdkLic.includes(line)).toBe(true);
    });

    it('OpenAPI license.url points at a path that resolves to the root LICENSE', () => {
        const openapi = JSON.parse(read(OPENAPI));
        expect(openapi.info.license.name).toBe('MIT');
        // URL is .../blob/main/LICENSE -> the repo-root LICENSE file we just added.
        expect(openapi.info.license.url).toMatch(/\/blob\/main\/LICENSE$/);
        // The path component after the ref is exactly "LICENSE" at repo root.
        const tail = openapi.info.license.url.split('/blob/main/')[1];
        expect(tail).toBe('LICENSE');
        expect(existsSync(abs(tail))).toBe(true);
    });
});

// --- F9: security-contact + lifecycle metadata --------------------------
describe('SRS-1 D135-C F9: security contact + lifecycle (no fabrication)', () => {
    const sec = read(SECURITY_TXT);
    const dev = read(DEVELOPERS);

    it('security.txt has a real, verifiable GitHub Contact URL (no invented email)', () => {
        expect(sec).toMatch(/^Contact:\s*https:\/\/github\.com\/mosesy5688-cell\/ai-nexus\//m);
        // No fabricated mailto contact.
        expect(sec).not.toMatch(/Contact:\s*mailto:/i);
        expect(sec).not.toMatch(/security@/i);
    });

    it('security.txt has required RFC 9116 Expires field', () => {
        expect(sec).toMatch(/^Expires:\s*\d{4}-\d{2}-\d{2}T/m);
    });

    it('developers page documents disconnect/removal of the MCP server', () => {
        expect(dev).toMatch(/Disconnecting \/ removing the MCP server/);
        expect(dev).toMatch(/remove the Free2AItools entry from your MCP client/i);
    });

    it('developers page carries an explicit NO-account / no-persistent-registration statement', () => {
        expect(dev).toMatch(/no server-side user account/i);
        expect(dev).toMatch(/no persistent client registration/i);
    });

    it('developers page truthfully states there is NO guaranteed deprecation window', () => {
        expect(dev).toMatch(/no guaranteed deprecation/i);
        // Must NOT invent a long-term availability guarantee.
        expect(dev).not.toMatch(/guaranteed (uptime|availability) (for|of)\s+\d/i);
    });
});

// --- 6.6: version-domain explanation ------------------------------------
describe('SRS-1 D135-C 6.6: version domains documented as distinct', () => {
    const dev = read(DEVELOPERS);

    it('explains the version domains are distinct / not numeric-equal', () => {
        expect(dev).toMatch(/Version domains/i);
        // HTML may wrap "not" in <strong>...</strong>; strip tags before matching.
        const devNoTags = dev.replace(/<[^>]+>/g, '');
        expect(devNoTags).toMatch(/not\s+kept in numeric equality/i);
    });

    it('lists each distinct version domain with its actual value', () => {
        expect(dev).toMatch(/0\.1\.0/); // SDK
        expect(dev).toMatch(/2\.0\.1/); // MCP server (D-135 F3 bump; independent of OpenAPI)
        expect(dev).toMatch(/2\.0\.0/); // OpenAPI document
        expect(dev).toMatch(/2\.1\.0/); // app/root package
        expect(dev).toMatch(/fni_v2\.0/); // data contract
    });

    it('actual surface versions back the documented domains (no false equality)', () => {
        const openapi = JSON.parse(read(OPENAPI));
        const mcp = JSON.parse(read(MCP_MANIFEST));
        const rootPkg = JSON.parse(read('package.json'));
        const sdkPkg = JSON.parse(read('packages/sdk/package.json'));
        // D-135 (F3): the MCP server version is an INDEPENDENT domain from the
        // OpenAPI document version — the MCP evidence-semantics bump moved MCP to
        // 2.0.1 while OpenAPI stayed 2.0.0. They are not locked to a shared value.
        expect(mcp.version).toBe('2.0.1');
        expect(openapi.info.version).toBe('2.0.0');
        expect(mcp.version).not.toBe(openapi.info.version); // no artificial equality
        expect(rootPkg.version).toBe('2.1.0');
        expect(sdkPkg.version).toBe('0.1.0');
        // The domains are genuinely NOT all equal — proves the doc is truthful.
        const distinct = new Set([
            sdkPkg.version,
            mcp.version,
            openapi.info.version,
            rootPkg.version
        ]);
        expect(distinct.size).toBeGreaterThan(1);
    });
});

// --- F8 HELD: no telemetry/retention admission disclosure added ----------
describe('SRS-1 D135-C F8 (HELD): no telemetry/retention admission added', () => {
    // Lane C must NOT add a telemetry/retention/analytics admission disclosure
    // to the new metadata surfaces — that is deferred to post-Lane-A.
    const newSurfaces: ReadonlyArray<readonly [string, string]> = [
        ['registry-candidate', read(CANDIDATE)],
        ['security.txt', read(SECURITY_TXT)]
    ];
    for (const [name, src] of newSurfaces) {
        it(`${name}: makes no telemetry/retention/analytics admission claim`, () => {
            expect(src).not.toMatch(/\btelemetry\b/i);
            expect(src).not.toMatch(/\bretention\b/i);
            expect(src).not.toMatch(/\banalytics\b/i);
            expect(src).not.toMatch(/data\s+retained\s+for/i);
        });
    }
});
