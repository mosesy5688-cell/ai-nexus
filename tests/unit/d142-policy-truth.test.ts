/**
 * D-142 Lane-A — Terms / Privacy reconciliation + machine-surface truth guard.
 * Locks policy pages to the TRUE product state (no accounts / API keys / payment /
 * 500-calls-month tier / 90-day retention) and the D-142 §3 privacy disclosures,
 * and re-asserts the no-auth OpenAPI/MCP contract (§5/§4).
 *
 * D-175 §E hardening: the paid-claim regression scan now covers the FULL tracked
 * public-contract surface (pages, public components, README, machine-text, policy
 * pages, sitemap/static-route generators), FAILS CLOSED if any required family
 * resolves zero files or a forbidden token appears, asserts /refund is a 410-Gone
 * stub (not a paid page), and carries anti-vacuity proof that every forbidden
 * family matches a synthetic affirmative claim.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve, relative } from 'path';
import { createRequire } from 'module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => readFileSync(resolve(root, rel), 'utf8');
const require = createRequire(import.meta.url);

// Recursively collect *.astro under a dir (relative to root). node_modules/dist/
// .astro/*.min.* are excluded; binaries are not .astro.
const listAstro = (relDir: string): string[] => {
    const out: string[] = [];
    const walk = (abs: string) => {
        for (const ent of readdirSync(abs, { withFileTypes: true })) {
            if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name === '.astro') continue;
            const child = resolve(abs, ent.name);
            if (ent.isDirectory()) walk(child);
            else if (ent.isFile() && ent.name.endsWith('.astro') && !/\.min\./.test(ent.name)) {
                out.push(relative(root, child).replace(/\\/g, '/'));
            }
        }
    };
    walk(resolve(root, relDir));
    return out.sort();
};

const TERMS = read('src/pages/terms.astro');
const PRIVACY = read('src/pages/privacy.astro');
const LLMS = read('src/data/llms-template.txt');

// FORBIDDEN PAID-CLAIM FAMILIES (affirmative-only). Each entry catches an
// AFFIRMATIVE current paid claim. Truthful negations ("no billing", "never paid
// placement", "no account / no payment required") are REQUIRED elsewhere and must
// NOT trip these, so patterns that could match a negated phrase carry the NEG
// affirmative-only lookbehind. Each family is proven non-vacuous against a
// synthetic affirmative string below (anti-vacuity / 2e).
const NEG = '(?<!no )(?<!no, )(?<!not )(?<!never )(?<!without )(?<!don\'t )(?<!doesn\'t )(?<!no\\s)';
const FORBIDDEN_POLICY: Array<{ family: string; re: RegExp }> = [
    { family: 'active paid subscription', re: new RegExp(`${NEG}\\b(?:active\\s+)?paid\\s+subscription\\b`, 'i') },
    { family: 'paid tier', re: new RegExp(`${NEG}\\bpaid\\s+(?:tier|plan)\\b`, 'i') },
    { family: 'subscription word (affirmative)', re: new RegExp(`${NEG}\\bsubscription\\b`, 'i') },
    { family: 'billing (affirmative)', re: new RegExp(`${NEG}\\bbilling\\b`, 'i') },
    { family: 'refund word (affirmative)', re: new RegExp(`${NEG}\\brefund`, 'i') },
    { family: 'credit card (affirmative)', re: new RegExp(`${NEG}\\bcredit card\\b`, 'i') },
    { family: 'payment processor (affirmative)', re: new RegExp(`${NEG}\\bpayment\\s+processor\\b`, 'i') },
    { family: 'account suspension', re: /\baccount\s+suspension\b/i },
    { family: 'API keys are issued/stored', re: /\bAPI keys are\b/i },
    { family: 'keys stored as hashes', re: /\bstore[sd]?\s+(?:as\s+)?(?:SHA-256\s+)?hashes?\b/i },
    { family: '500 API calls/month boundary', re: /\b500\s*(?:API\s*)?calls?\s*(?:per|\/)\s*month\b/i },
    { family: '14-day money-back guarantee', re: new RegExp(`${NEG}\\b(?:14[\\s-]*day\\s+)?money[\\s-]*back\\b`, 'i') },
    { family: 'current billing period', re: new RegExp(`${NEG}\\b(?:current\\s+)?billing\\s+(?:period|cycle)\\b`, 'i') },
    { family: 'account email required for refund', re: /\b(?:account\s+)?e-?mail\b[\s\S]{0,40}\brefund\b/i },
    { family: 'Merchant of Record', re: new RegExp(`${NEG}\\bmerchant\\s+of\\s+record\\b`, 'i') },
];

// CLOSED, EXPLICIT public-contract surface. Each REQUIRED FAMILY must resolve
// >=1 file; a forbidden token in any scanned file fails the suite (fail-closed).
const REQUIRED_NAMED = {
    DOC: ['README.md'],
    MACHINE_TEXT: ['src/data/llms-template.txt', 'public/.well-known/mcp.json', 'src/data/openapi-schema.json'],
    POLICY: ['src/pages/terms.astro', 'src/pages/privacy.astro'],
    SITEMAP: ['src/pages/sitemap-static.xml.ts', 'scripts/factory/lib/sitemap-generator.js', 'scripts/sidecar/l5_sitemap_gen.py'],
};
const FAMILIES: Record<string, string[]> = {
    PAGES: listAstro('src/pages'),
    COMPONENTS: listAstro('src/components'),
    DOC: REQUIRED_NAMED.DOC,
    MACHINE_TEXT: REQUIRED_NAMED.MACHINE_TEXT,
    POLICY: REQUIRED_NAMED.POLICY,
    SITEMAP: REQUIRED_NAMED.SITEMAP,
};

const matchForbidden = (text: string): string | null => {
    for (const { family, re } of FORBIDDEN_POLICY) if (re.test(text)) return family;
    return null;
};

describe('D-175 §E: FULL public-contract surface carries no affirmative paid claim (fail-closed)', () => {
    it('the overall scan resolved at least one tracked file', () => {
        const total = Object.values(FAMILIES).reduce((n, l) => n + l.length, 0);
        expect(total).toBeGreaterThan(0);
    });

    for (const [fam, files] of Object.entries(FAMILIES)) {
        it(`family ${fam} resolved >=1 file (fail closed)`, () => expect(files.length).toBeGreaterThanOrEqual(1));
        for (const rel of files) {
            it(`${fam}: ${rel} exists`, () => expect(existsSync(resolve(root, rel))).toBe(true));
            it(`${fam}: ${rel} has no affirmative paid claim`, () => {
                const hit = matchForbidden(read(rel));
                expect(hit, `forbidden family "${hit}" matched in ${rel}`).toBeNull();
            });
        }
    }

    it('POLICY pages terms + privacy are present in PAGES by name', () => {
        expect(FAMILIES.PAGES).toContain('src/pages/terms.astro');
        expect(FAMILIES.PAGES).toContain('src/pages/privacy.astro');
    });
});

describe('D-175 §E: /refund is a 410 Gone stub (not a paid page) and unadvertised', () => {
    const REFUND = 'src/pages/refund.astro';
    it('exists as a 410 stub', () => expect(existsSync(resolve(root, REFUND))).toBe(true));
    it('sets Astro.response.status = 410', () => expect(read(REFUND)).toMatch(/Astro\.response\.status\s*=\s*410/));
    it('is noindex', () => expect(read(REFUND)).toMatch(/noindex/));
    it('contains none of the forbidden paid tokens', () => expect(matchForbidden(read(REFUND))).toBeNull());
    it('Footer.astro has no /refund link', () => expect(read('src/components/Footer.astro')).not.toMatch(/\/refund\b/));
});

describe('D-175 §E anti-vacuity: every forbidden family matches a synthetic affirmative claim', () => {
    // If a family fails to match its probe the matcher is dead and this goes RED.
    const PROBES: Record<string, string> = {
        'active paid subscription': 'Your active paid subscription renews monthly.',
        'paid tier': 'Upgrade to the paid tier for more access.',
        'subscription word (affirmative)': 'Manage your subscription in settings.',
        'billing (affirmative)': 'Update your billing details here.',
        'refund word (affirmative)': 'Request a refund within 14 days.',
        'credit card (affirmative)': 'We charge your credit card monthly.',
        'payment processor (affirmative)': 'Handled by our payment processor.',
        'account suspension': 'Non-payment leads to account suspension.',
        'API keys are issued/stored': 'API keys are issued on signup.',
        'keys stored as hashes': 'Keys are stored as SHA-256 hashes.',
        '500 API calls/month boundary': 'Free plan allows 500 API calls per month.',
        '14-day money-back guarantee': 'Backed by a 14-day money-back guarantee.',
        'current billing period': 'Charges apply for the current billing period.',
        'account email required for refund': 'Provide your account email to get a refund.',
        'Merchant of Record': 'Paddle is our Merchant of Record.',
    };
    // Match each family's OWN regex against its own probe (not first-match), so a
    // specific probe an earlier generic pattern would also catch still proves its
    // own pattern is live.
    for (const { family, re } of FORBIDDEN_POLICY) {
        it(`family "${family}" matches its affirmative probe`, () => {
            expect(PROBES[family], `no probe for ${family}`).toBeTruthy();
            expect(re.test(PROBES[family]), `pattern for "${family}" missed probe`).toBe(true);
        });
    }
    it('truthful negations are NOT flagged as paid claims (verbatim from real surface)', () => {
        expect(matchForbidden('never paid placement and no billing')).toBeNull();
        expect(matchForbidden('Read-only, no billing.')).toBeNull();
        expect(matchForbidden('no account, no API key, and no payment')).toBeNull();
        expect(matchForbidden('There are no paid plans and no payments')).toBeNull();
    });
});

describe('D-142 §2/§3: privacy drops other stale claims (paid-token scan lives in the surface scan above)', () => {
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
    it('states access is currently free', () => expect(TERMS).toMatch(/free/i));
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
        expect(PRIVACY).toMatch(/localStorage/);
        expect(PRIVACY).toMatch(/ai-nexus-favorites/);
        expect(PRIVACY).toMatch(/_vfs_partitions/);
        expect(PRIVACY).toMatch(/degraded_entities/);
        expect(PRIVACY).toMatch(/not a server-side account/i);
    });
    it('states API/MCP request params are processed, with no invented retention period', () => {
        expect(PRIVACY).toMatch(/request parameters/i);
        expect(PRIVACY).not.toMatch(/retained for \d+ days/i);
    });
    it('describes route-local telemetry as a disabled-by-default CODE CONTRACT only', () => {
        expect(PRIVACY).toMatch(/disabled unless explicitly enabled/i);
        expect(PRIVACY).toMatch(/code contract/i);
        expect(PRIVACY).not.toMatch(/telemetry is (?:enabled|active) in production/i);
        expect(PRIVACY).not.toMatch(/telemetry is disabled in production/i);
        expect(PRIVACY).toMatch(/prohibits[\s\S]*(?:IP|prompt|raw quer|user-agent)/i);
    });
});

describe('D-142 §4: machine surface (llms.txt) lets an agent determine the truth', () => {
    it('asserts no account / no API key / no payment required', () => expect(LLMS).toMatch(/no account, no API key, and no payment/i));
    it('asserts no optional browser analytics on human pages', () => expect(LLMS).toMatch(/NO optional browser analytics/i));
    it('asserts infrastructure may process operational data', () => expect(LLMS).toMatch(/infrastructure.*may process|operational request, network/i));
    it('does NOT publicly assert production telemetry is enabled', () => {
        expect(LLMS).toMatch(/disabled unless explicitly enabled/i);
        expect(LLMS).toMatch(/is NOT\s+asserted/i);
    });
    it('asserts no sponsor/advertising influence on results', () => expect(LLMS).toMatch(/No sponsor or advertising/i));
});

describe('D-142 §5: no-auth OpenAPI / MCP contract is unchanged', () => {
    const openapi = require('../../src/data/openapi-schema.json');
    const mcp = require('../../public/.well-known/mcp.json');
    it('OpenAPI declares no global security requirement', () => expect(openapi.security).toBeUndefined());
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
