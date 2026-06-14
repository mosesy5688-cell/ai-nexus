/**
 * SRS-2A — Frontend Playwright DEPLOYED baseline (informational, non-blocking).
 * Read-only against deployed prod (BASE_URL, default https://free2aitools.com).
 * Each assertion closes a Frontend Matrix PENDING_RUNTIME browser cell.
 *
 * CALIBRATED (Founder-exact): browser events run through a SEVERE classifier
 * (./srs2a-classifier) instead of a blanket toHaveLength(0) — a test fails only
 * on a SEVERE product signal; transient 429/503 and noncritical/aborted events
 * become PRESERVED + counted WARNINGs (never erased). The genuine-404 and
 * detail-status cells map 429/503 -> INCONCLUSIVE_TRANSIENT (never PASS).
 * Request shaping: serial ordering, descriptive UA, bounded (<=2) transient
 * retry honoring Retry-After. Contract assertions (redirect / canonical /
 * JSON-LD / honesty-copy) stay STRICT.
 */
import { test, expect, devices } from '@playwright/test';
import {
    BASE_URL, DETAIL_TYPES, TEST_UA, resolveRealSlug, withTransientRetry,
    discoverBuildId, discoverSnapshotId, emitRunArtifact, record,
} from './srs2a-helpers';
import { attachClassifiedCollector, severeSummary, type EventSink } from './srs2a-classifier';

const FUTURE_COPY = /being indexed|will appear|being aggregated|coming soon|check back/i;
const isTransient = (s: number) => s === 429 || s === 503;

let BUILD_ID = 'undiscoverable';
let SNAPSHOT_ID = 'unobservable';

// REQUEST SHAPING: serial ordering (CI already pins workers=1); descriptive UA
// on every browser request; NO privileged/allowlist request.
test.describe.configure({ mode: 'serial' });
test.use({ userAgent: TEST_UA });

test.beforeAll(async ({ request }) => {
    BUILD_ID = await discoverBuildId(request);
    SNAPSHOT_ID = await discoverSnapshotId(request);
});

test.afterAll(async () => {
    await emitRunArtifact(BUILD_ID, SNAPSHOT_ID);
});

/** Record the cell (PASS unless SEVERE) then fail on any SEVERE event. */
function recordSevere(assertion: string, expected: string, sink: EventSink, extra: Record<string, unknown> = {}): void {
    record({ assertion, expected, actual: `severe=${sink.severe.length}`, state: sink.severe.length ? 'PRODUCT_FAILURE' : 'PASS', keyFields: extra, events: sink.events });
    expect(sink.severe, `${assertion} SEVERE events: ${severeSummary(sink)}`).toHaveLength(0);
}

type Resp = { status(): number; headers(): Record<string, string> } | null | undefined;
/** Record an INCONCLUSIVE_TRANSIENT cell (429/503): never PASS, cell UNCLOSED. */
function inconclusive(assertion: string, expected: string, resp: Resp, extra: Record<string, unknown> = {}, sink?: EventSink): void {
    const h = resp?.headers() ?? {};
    record({ assertion, expected, actual: `${resp?.status()} transient`, state: 'INCONCLUSIVE_TRANSIENT', keyFields: { retryAfter: h['retry-after'], cacheControl: h['cache-control'], status: resp?.status(), ...extra }, events: sink?.events });
}

test.describe('SRS-2A frontend deployed baseline @informational', () => {
    test('homepage: 200, catalog present, no SEVERE browser errors [FM:home]', async ({ page }) => {
        const sink = attachClassifiedCollector(page, BASE_URL);
        const resp = await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), 'homepage status').toBe(200);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        const catalog = page.locator('a[href*="/model/"], a[href*="/paper/"], a[href*="/tool/"], a[href*="/dataset/"]');
        await expect(catalog.first()).toBeVisible({ timeout: 15000 });
        recordSevere('homepage', '200 + catalog + no SEVERE', sink);
    });

    test('explore: 301 -> /models [FM:explore]', async ({ request }) => {
        const { resp, retries } = await withTransientRetry(() => request.get(`${BASE_URL}/explore`, { maxRedirects: 0, headers: { 'user-agent': TEST_UA } }), isTransient);
        expect(resp.status(), 'explore redirect').toBe(301);
        expect(resp.headers()['location']).toMatch(/\/models$/);
        record({ assertion: 'explore-redirect', expected: '301 ->/models', actual: `${resp.status()} ${resp.headers()['location']}`, state: resp.status() === 301 ? 'PASS' : 'PRODUCT_FAILURE', retries });
    });

    test('search: page loads + honest empty on no-result [FM:search]', async ({ page }) => {
        const sink = attachClassifiedCollector(page, BASE_URL);
        const ok = await page.goto(`${BASE_URL}/search?q=llama`, { waitUntil: 'domcontentloaded' });
        expect(ok?.status()).toBe(200);
        await page.goto(`${BASE_URL}/search?q=zzqxnonexistentquery9988`, { waitUntil: 'domcontentloaded' });
        const body = (await page.locator('body').innerText()).toLowerCase();
        expect(body, 'no future-availability copy on empty search').not.toMatch(FUTURE_COPY);
        record({ assertion: 'search-honest-empty', expected: 'loads + no future copy', actual: `severe=${sink.severe.length}`, state: 'PASS', events: sink.events });
    });

    for (const { type, route, queries } of DETAIL_TYPES) {
        test(`detail ${type}: real id -> 200, no SEVERE browser errors [FM:detail-${type}]`, async ({ page, request }) => {
            const slug = await resolveRealSlug(request as any, type, queries);
            test.skip(!slug, `no resolvable ${type} id on prod right now (sparse type)`);
            const sink = attachClassifiedCollector(page, BASE_URL);
            const resp = await page.goto(`${BASE_URL}/${route}/${slug}`, { waitUntil: 'domcontentloaded' });
            const status = resp?.status() ?? 0;
            // 200 PASS; 429/503 INCONCLUSIVE_TRANSIENT (never PASS); other -> fail.
            if (isTransient(status)) {
                const snip = (await page.locator('body').innerText().catch(() => '')).slice(0, 200);
                inconclusive(`detail-${type}`, '200', resp, { slug, bodySnippet: snip }, sink);
                test.skip(true, `${type} ${slug} returned transient ${status} (INCONCLUSIVE_TRANSIENT, cell stays UNCLOSED)`);
            }
            expect(status, `${type} detail status`).toBe(200);
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 15000 });
            recordSevere(`detail-${type}`, '200 + no SEVERE', sink, { slug });
        });
    }

    test('genuine 404: 404 + NO future-availability copy (G-01 lock); 429/503 INCONCLUSIVE [FM:404]', async ({ page }) => {
        const resp = await page.goto(`${BASE_URL}/model/zz-nonexistent-${Date.now().toString(36)}`, { waitUntil: 'domcontentloaded' });
        const status = resp?.status() ?? 0;
        // G-01: 404 -> PASS/FAIL; 429/503 -> INCONCLUSIVE_TRANSIENT (never PASS),
        // cell stays UNCLOSED until a real 404 is observed.
        if (isTransient(status)) {
            const snip = (await page.locator('body').innerText().catch(() => '')).slice(0, 200);
            inconclusive('404-honest', '404 + no future copy', resp, { bodySnippet: snip });
            test.skip(true, `genuine-404 cell got transient ${status} (INCONCLUSIVE_TRANSIENT, G-01 NOT closed)`);
        }
        expect(status, '404 status').toBe(404);
        const body = (await page.locator('body').innerText()).toLowerCase();
        expect(body, 'G-01: 404 must not promise future availability').not.toMatch(FUTURE_COPY);
        record({ assertion: '404-honest', expected: '404 + no future copy', actual: `${status}`, state: status === 404 ? 'PASS' : 'PRODUCT_FAILURE' });
    });

    test('leaderboard: 301 -> /benchmarks (P-02/03) [FM:leaderboard]', async ({ request }) => {
        const { resp, retries } = await withTransientRetry(() => request.get(`${BASE_URL}/leaderboard`, { maxRedirects: 0, headers: { 'user-agent': TEST_UA } }), isTransient);
        expect(resp.status()).toBe(301);
        expect(resp.headers()['location']).toMatch(/\/benchmarks$/);
        record({ assertion: 'leaderboard-redirect', expected: '301 ->/benchmarks', actual: `${resp.status()} ${resp.headers()['location']}`, state: resp.status() === 301 ? 'PASS' : 'PRODUCT_FAILURE', retries });
    });

    for (const path of ['/agent/x', '/space/x', '/prompt/x', '/reports']) {
        test(`retired ${path}: 410 Gone [FM:retired]`, async ({ request }) => {
            const { resp, retries } = await withTransientRetry(() => request.get(`${BASE_URL}${path}`, { maxRedirects: 0, headers: { 'user-agent': TEST_UA } }), isTransient);
            // 410 is the deterministic contract. 429/503 -> INCONCLUSIVE_TRANSIENT.
            if (isTransient(resp.status())) {
                inconclusive(`retired-${path}`, '410', resp);
                test.skip(true, `${path} got transient ${resp.status()} (INCONCLUSIVE_TRANSIENT)`);
            }
            expect(resp.status(), `${path} status`).toBe(410);
            record({ assertion: `retired-${path}`, expected: '410', actual: `${resp.status()}`, state: resp.status() === 410 ? 'PASS' : 'PRODUCT_FAILURE', retries });
        });
    }

    test('knowledge: honest empty, no "being aggregated" copy (P-04) [FM:knowledge]', async ({ page }) => {
        const resp = await page.goto(`${BASE_URL}/knowledge`, { waitUntil: 'domcontentloaded' });
        const status = resp?.status() ?? 0;
        if (isTransient(status)) {
            inconclusive('knowledge-honest', '200 + no aggregation copy', resp);
            test.skip(true, `knowledge got transient ${status} (INCONCLUSIVE_TRANSIENT)`);
        }
        expect(status).toBe(200);
        const body = (await page.locator('body').innerText()).toLowerCase();
        expect(body, 'P-04: knowledge must not promise aggregation').not.toMatch(/being aggregated/i);
        record({ assertion: 'knowledge-honest', expected: '200 + no aggregation copy', actual: `${status}`, state: status === 200 ? 'PASS' : 'PRODUCT_FAILURE' });
    });

    test('fallback image: image-less detail uses a 200 image, not 404 default-model.jpg (P-01) [FM:image]', async ({ page, request }) => {
        const slug = await resolveRealSlug(request as any, 'model', ['llama', 'qwen']);
        test.skip(!slug, 'no resolvable model id for image probe');
        const broken: string[] = [];
        page.on('response', (r) => {
            if (r.status() === 404 && /default-model\.jpg/i.test(r.url())) broken.push(r.url());
        });
        const resp = await page.goto(`${BASE_URL}/model/${slug}`, { waitUntil: 'networkidle' });
        if (isTransient(resp?.status() ?? 0)) {
            inconclusive('fallback-image', 'no 404 default-model.jpg', resp, { slug });
            test.skip(true, `transient ${resp?.status()} cold-path (INCONCLUSIVE_TRANSIENT)`);
        }
        expect(broken, `P-01: no 404 default-model.jpg request: ${broken.join(',')}`).toHaveLength(0);
        record({ assertion: 'fallback-image', expected: 'no 404 default-model.jpg', actual: `broken=${broken.length}`, state: broken.length ? 'PRODUCT_FAILURE' : 'PASS', keyFields: { slug } });
    });

    test('network hygiene: no SEVERE asset failures on homepage [FM:resources]', async ({ page }) => {
        const sink = attachClassifiedCollector(page, BASE_URL);
        await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
        recordSevere('network-hygiene', 'no SEVERE asset failures', sink);
    });

    test('viewports: homepage + one detail render on desktop and mobile [FM:responsive]', async ({ browser, request }) => {
        const slug = await resolveRealSlug(request as any, 'tool', ['code', 'agent']);
        for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['mobile', devices['Pixel 5'].viewport]] as const) {
            const ctx = await browser.newContext({ viewport: vp, userAgent: TEST_UA });
            const page = await ctx.newPage();
            const home = await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
            expect(home?.status(), `${label} home`).toBe(200);
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 15000 });
            if (slug) {
                const d = await page.goto(`${BASE_URL}/tool/${slug}`, { waitUntil: 'domcontentloaded' });
                expect([200, 429, 503], `${label} detail`).toContain(d?.status());
            }
            await ctx.close();
        }
        record({ assertion: 'viewports', expected: 'desktop+mobile render', actual: 'ok', state: 'PASS', keyFields: { slug } });
    });

    // canonical + JSON-LD share one detail page load (avoids a duplicate request
    // for the same sample, per request-shaping). Both stay STRICT contracts.
    test('canonical + JSON-LD present/valid on detail [FM:canonical][FM:jsonld]', async ({ page, request }) => {
        const slug = await resolveRealSlug(request as any, 'tool', ['code', 'agent', 'chat']);
        test.skip(!slug, 'no resolvable detail for canonical/JSON-LD check');
        const resp = await page.goto(`${BASE_URL}/tool/${slug}`, { waitUntil: 'domcontentloaded' });
        if (isTransient(resp?.status() ?? 0)) {
            inconclusive('canonical+jsonld', 'present + valid', resp, { slug });
            test.skip(true, `transient ${resp?.status()} (INCONCLUSIVE_TRANSIENT)`);
        }
        const href = await page.locator('link[rel="canonical"]').first().getAttribute('href');
        expect(href, 'canonical present').toBeTruthy();
        expect(new URL(href!).host, 'canonical host').toBe('free2aitools.com');
        record({ assertion: 'canonical', expected: 'present + free2aitools.com', actual: String(href), state: href ? 'PASS' : 'PRODUCT_FAILURE', keyFields: { slug } });
        const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
        expect(blocks.length, 'has ld+json').toBeGreaterThan(0);
        for (const b of blocks) expect(() => JSON.parse(b), 'valid JSON-LD').not.toThrow();
        record({ assertion: 'json-ld', expected: 'present + valid', actual: `blocks=${blocks.length}`, state: blocks.length ? 'PASS' : 'PRODUCT_FAILURE', keyFields: { slug } });
    });

    test('a11y basics: headings, link text/aria, keyboard focus (lightweight) [FM:a11y]', async ({ page }) => {
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        expect(await page.getByRole('heading').count(), 'has headings').toBeGreaterThan(0);
        const links = page.locator('a[href]');
        const n = Math.min(await links.count(), 25);
        let unlabeled = 0;
        for (let i = 0; i < n; i++) {
            const l = links.nth(i);
            const txt = ((await l.innerText()).trim() || (await l.getAttribute('aria-label')) || (await l.getAttribute('title')) || '').trim();
            if (!txt) unlabeled++;
        }
        expect(unlabeled, 'all sampled links labeled').toBe(0);
        await page.keyboard.press('Tab');
        const active = await page.evaluate(() => document.activeElement?.tagName ?? '');
        expect(active, 'keyboard focus moved').not.toBe('BODY');
        record({ assertion: 'a11y-basics', expected: 'headings+labels+focus', actual: `unlabeled=${unlabeled} focus=${active}`, state: unlabeled === 0 ? 'PASS' : 'PRODUCT_FAILURE' });
    });

    test('sitemap<->page canonical host consistency [FM:sitemap]', async ({ page, request }) => {
        const idx = await request.get(`${BASE_URL}/sitemap-index.xml`, { headers: { 'user-agent': TEST_UA } });
        expect(idx.status(), 'sitemap-index 200').toBe(200);
        const shard = (await idx.text()).match(/https?:\/\/[^<]+\.xml/)?.[0];
        test.skip(!shard, 'no sitemap shard found');
        const shardResp = await request.get(shard!, { headers: { 'user-agent': TEST_UA } });
        expect(shardResp.status(), 'shard 200').toBe(200);
        const loc = (await shardResp.text()).match(/<loc>(https?:\/\/[^<]+)<\/loc>/)?.[1];
        test.skip(!loc, 'no <loc> in shard');
        const resp = await page.goto(loc!, { waitUntil: 'domcontentloaded' });
        if (isTransient(resp?.status() ?? 0)) {
            inconclusive('sitemap-canonical-consistency', 'host match', resp, { loc });
            test.skip(true, `sampled sitemap url transient ${resp?.status()} (INCONCLUSIVE_TRANSIENT)`);
        }
        test.skip(resp?.status() !== 200, `sampled sitemap url not 200 (${resp?.status()})`);
        const canon = await page.locator('link[rel="canonical"]').first().getAttribute('href');
        if (canon) expect(new URL(canon).host, 'canonical host matches sitemap host').toBe(new URL(loc!).host);
        record({ assertion: 'sitemap-canonical-consistency', expected: 'host match', actual: `loc=${loc} canon=${canon}`, state: 'PASS', keyFields: { shard } });
    });
});
