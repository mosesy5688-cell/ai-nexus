/**
 * SRS-1 -- B3 OPENNESS-A1 datasets commercial-residue honesty invariant
 * (tier-1, hermetic). Founder D-187 §H.
 *
 * Free2AITools is an all-free / open-access public service. The datasets surface
 * carried COMMERCIAL RESIDUE advertising a non-existent "paid" tier. This fix is a
 * COMPATIBILITY-SAFE honesty correction:
 *   - the OpenAPI DatasetsResponse `tier` enum is capped to ["free"] (no "paid"),
 *     marked deprecated, and points callers at `access`;
 *   - a truthful `access: "public"` field is REQUIRED on every dataset item;
 *   - the live /api/v1/datasets response emits access:"public" + (legacy) tier:"free".
 *
 * HARD REQ: the OpenAPI assertions run against the SERVED `/openapi.json`
 * PROJECTION (the openapi.json.ts route GET transform OUTPUT), NOT merely the
 * static src/data/openapi-schema.json source -- a static-only assertion cannot
 * prove what the endpoint actually emits at runtime (D-42 projection lesson). The
 * datasets-response assertions invoke the REAL exported datasets GET handler.
 *
 * ANTI-VACUITY: reverting any limb of the fix turns this suite RED --
 *   re-add "paid" to the served tier enum            -> RES-NO-PAID FAILS
 *   drop `access` from the required[] item schema     -> RES-ACCESS-REQUIRED FAILS
 *   drop the deprecated marker on tier                -> RES-TIER-DEPRECATED FAILS
 *   remove access:"public" from the datasets response -> EP-ACCESS-PUBLIC FAILS
 *   change the legacy tier value off "free"           -> EP-TIER-FREE FAILS
 *
 * HERMETIC: invokes the openapi.json.ts + datasets.ts route GETs in-process
 * (cloudflare:workers mocked in vitest.config; datasets telemetry is fail-open and
 * pulls in no live binding). No live network. Deterministic across runs.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { GET as OPENAPI_GET } from '../../src/pages/openapi.json.ts';
import { GET as DATASETS_GET } from '../../src/pages/api/v1/datasets.ts';

// --- SERVED /openapi.json projection (the runtime transform output) ----------
let SERVED_ITEM: any = null;
beforeAll(async () => {
    const res = await (OPENAPI_GET as any)({ request: new Request('https://x/openapi.json') });
    const body = JSON.parse(await res.text());
    SERVED_ITEM = body?.components?.schemas?.DatasetsResponse?.properties?.files?.items ?? null;
    expect(SERVED_ITEM, 'served DatasetsResponse item schema must be present').toBeTruthy();
});

describe('SRS-1 B3-OPENNESS RES (served /openapi.json DatasetsResponse projection)', () => {
    it('RES-NO-PAID: served tier enum is EXACTLY ["free"] and never advertises "paid"', () => {
        expect(SERVED_ITEM.properties.tier.enum).toEqual(['free']);
        expect(SERVED_ITEM.properties.tier.enum).not.toContain('paid');
    });
    it('RES-TIER-DEPRECATED: served tier is deprecated and names `access` as the replacement', () => {
        expect(SERVED_ITEM.properties.tier.deprecated).toBe(true);
        expect(SERVED_ITEM.properties.tier.description).toMatch(/access/);
        expect(SERVED_ITEM.properties.tier.description).toMatch(/deprecated/i);
    });
    it('RES-ACCESS-PRESENT: served item declares access with enum ["public"]', () => {
        expect(SERVED_ITEM.properties.access).toBeDefined();
        expect(SERVED_ITEM.properties.access.type).toBe('string');
        expect(SERVED_ITEM.properties.access.enum).toEqual(['public']);
    });
    it('RES-ACCESS-REQUIRED: access is a REQUIRED property of the served item schema', () => {
        expect(Array.isArray(SERVED_ITEM.required)).toBe(true);
        expect(SERVED_ITEM.required).toContain('access');
    });
    it('RES-NO-PAID-RESURRECTION: no paid/premium/subscription wording in the served item schema', () => {
        const blob = JSON.stringify(SERVED_ITEM).toLowerCase();
        for (const w of ['paid', 'premium', 'subscription', 'enterprise', 'billing', 'upgrade']) {
            expect(blob, `served datasets item schema must not advertise "${w}"`).not.toContain(w);
        }
    });
});

// --- LIVE /api/v1/datasets response (the real exported handler) --------------
describe('SRS-1 B3-OPENNESS EP (live /api/v1/datasets response)', () => {
    let files: any[] = [];
    beforeAll(async () => {
        const res = await (DATASETS_GET as any)({ request: new Request('https://x/api/v1/datasets'), locals: {} });
        const body = JSON.parse(await res.text());
        files = body?.files ?? [];
        expect(files.length, 'datasets response must list at least one file').toBeGreaterThan(0);
    });
    it('EP-ACCESS-PUBLIC: every listed dataset emits access === "public"', () => {
        for (const f of files) expect(f.access, `${f.id} access`).toBe('public');
    });
    it('EP-TIER-FREE: legacy tier is RETAINED and its only value is "free" (compat-safe; not deleted)', () => {
        for (const f of files) {
            expect(f.tier, `${f.id} tier must be retained`).toBe('free');
        }
    });
});
