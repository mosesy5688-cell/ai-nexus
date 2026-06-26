/**
 * D-142 Lane-A — Terms / Privacy reconciliation + machine-surface truth guard.
 *
 * Locks the policy pages to the TRUE product state (no accounts / no API keys /
 * no payment / no 500-calls-month tier / no fixed 90-day retention claim) and
 * locks the privacy disclosures D-142 §3 requires present (infrastructure
 * provider processing; localStorage disclosure consistent with actual code;
 * optional telemetry described as a disabled-by-default code contract with NO
 * production enabled/disabled assertion). Also re-asserts the no-auth
 * OpenAPI/MCP contract is unchanged (D-142 §5/§4 must not break it).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { createRequire } from 'module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

const TERMS = read('src/pages/terms.astro');
const PRIVACY = read('src/pages/privacy.astro');
const LLMS = read('src/data/llms-template.txt');

// Claims that must NOT appear in either policy page (no longer true).
// Note: a truthful "no account / no API key required" statement is REQUIRED by
// D-142 §2, so the forbidden patterns target the affirmative claims (an account
// system, stored/issued keys, paid tiers, billing) — never the negation.
const FORBIDDEN_POLICY = [
    /\baccount\s+suspension\b/i,
    /\bAPI keys are\b/i,
    /\bstore[sd]?\s+(?:as\s+)?(?:SHA-256\s+)?hashes?\b/i,
    /\b500\s*(?:API\s*)?calls?\s*(?:per|\/)\s*month\b/i,
    /\bpaid\s+(?:tier|subscription)/i,
    /\bsubscription\b/i,
    /\bpayment\s+processor\b/i,
    /\brefund/i,
    /\bbilling\b/i,
    /\bcredit card\b/i,
];

describe('D-142 §2/§3: terms + privacy contain no stale account/payment claims', () => {
    for (const re of FORBIDDEN_POLICY) {
        it(`terms.astro has no ${re}`, () => expect(TERMS).not.toMatch(re));
        it(`privacy.astro has no ${re}`, () => expect(PRIVACY).not.toMatch(re));
    }

    it('privacy.astro drops the fixed 90-day API-log retention claim', () => {
        expect(PRIVACY).not.toMatch(/90[\s-]*days?/i);
    });

    it('privacy.astro drops the "no third-party analytics besides Cloudflare" claim', () => {
        expect(PRIVACY).not.toMatch(/no third-party analytics/i);
    });

    it('privacy.astro makes no GTM / Do-Not-Track claim', () => {
        expect(PRIVACY).not.toMatch(/google tag manager.*do not track/i);
        expect(PRIVACY).not.toMatch(/respects do not track/i);
    });
});

describe('D-142 §2: terms state the true free / no-account access model', () => {
    it('states no account and no API key are required', () => {
        expect(TERMS).toMatch(/no account/i);
        expect(TERMS).toMatch(/no API key/i);
    });
    it('states access is currently free', () => {
        expect(TERMS).toMatch(/free/i);
    });
    it('states no SLA / availability not guaranteed', () => {
        expect(TERMS).toMatch(/SLA|service-level agreement/i);
        expect(TERMS).toMatch(/availability is not guaranteed|not guaranteed/i);
    });
    it('states the caller retains final decision responsibility', () => {
        expect(TERMS).toMatch(/final (?:responsibility|decision)|retain[s]? final/i);
    });
});

describe('D-142 §3: privacy distinguishes the true data-handling layers', () => {
    it('states optional browser analytics are removed', () => {
        expect(PRIVACY).toMatch(/no (?:optional )?(?:browser )?analytics|analytics[\s\S]*removed/i);
        expect(PRIVACY).toMatch(/no Google Tag Manager/i);
        expect(PRIVACY).toMatch(/Cloudflare Web Analytics/i);
    });

    it('discloses infrastructure-provider operational processing (not "no logs")', () => {
        expect(PRIVACY).toMatch(/infrastructure/i);
        expect(PRIVACY).toMatch(/Cloudflare/i);
        expect(PRIVACY).toMatch(/process(?:es|ing)?\s+(?:necessary\s+)?(?:request|network|security|diagnostic)/i);
    });

    it('discloses localStorage consistent with actual code keys', () => {
        // Real keys in src/: ai-nexus-favorites, section-*, _vfs_partitions, degraded_entities.
        expect(PRIVACY).toMatch(/localStorage/);
        expect(PRIVACY).toMatch(/ai-nexus-favorites/);
        expect(PRIVACY).toMatch(/_vfs_partitions/);
        expect(PRIVACY).toMatch(/degraded_entities/);
        // Not described as a server-side account DB.
        expect(PRIVACY).toMatch(/not a server-side account/i);
    });

    it('states API/MCP request params are processed, with no invented retention period', () => {
        expect(PRIVACY).toMatch(/request parameters/i);
        expect(PRIVACY).not.toMatch(/retained for \d+ days/i);
    });

    it('describes route-local telemetry as a disabled-by-default CODE CONTRACT only', () => {
        expect(PRIVACY).toMatch(/disabled unless explicitly enabled/i);
        expect(PRIVACY).toMatch(/code contract/i);
        // Must NOT assert production is definitely enabled or definitely disabled.
        expect(PRIVACY).not.toMatch(/telemetry is (?:enabled|active) in production/i);
        expect(PRIVACY).not.toMatch(/telemetry is disabled in production/i);
        // Schema prohibitions present.
        expect(PRIVACY).toMatch(/prohibits[\s\S]*(?:IP|prompt|raw quer|user-agent)/i);
    });
});

describe('D-142 §4: machine surface (llms.txt) lets an agent determine the truth', () => {
    it('asserts no account / no API key / no payment required', () => {
        expect(LLMS).toMatch(/no account, no API key, and no payment/i);
    });
    it('asserts no optional browser analytics on human pages', () => {
        expect(LLMS).toMatch(/NO optional browser analytics/i);
    });
    it('asserts infrastructure may process operational data', () => {
        expect(LLMS).toMatch(/infrastructure.*may process|operational request, network/i);
    });
    it('does NOT publicly assert production telemetry is enabled', () => {
        expect(LLMS).toMatch(/disabled unless explicitly enabled/i);
        expect(LLMS).toMatch(/is NOT\s+asserted/i);
    });
    it('asserts no sponsor/advertising influence on results', () => {
        expect(LLMS).toMatch(/No sponsor or advertising/i);
    });
});

describe('D-142 §5: no-auth OpenAPI / MCP contract is unchanged', () => {
    const openapi = require('../../src/data/openapi-schema.json');
    const mcp = require('../../public/.well-known/mcp.json');

    it('OpenAPI declares no global security requirement', () => {
        expect(openapi.security).toBeUndefined();
    });
    it('OpenAPI declares no securitySchemes (no api key / bearer)', () => {
        const schemes = openapi.components?.securitySchemes;
        expect(schemes === undefined || Object.keys(schemes).length === 0).toBe(true);
    });
    it('MCP manifest declares no auth requirement', () => {
        const blob = JSON.stringify(mcp).toLowerCase();
        expect(blob).not.toMatch(/"auth(?:entication)?"\s*:/);
        expect(blob).not.toMatch(/api[_-]?key/);
    });
});
