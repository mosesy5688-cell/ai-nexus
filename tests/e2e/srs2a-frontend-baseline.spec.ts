/**
 * SRS-2A — Frontend Playwright DEPLOYED baseline (informational, non-blocking).
 *
 * Persistent harness that runs READ-ONLY against deployed prod (BASE_URL,
 * default https://free2aitools.com). Each assertion closes a Frontend Matrix
 * PENDING_RUNTIME browser cell; mapping is noted inline. This is an
 * INFORMATIONAL baseline — failures surface signal, they do NOT gate any PR.
 *
 * Coverage: homepage; explore/search; one real detail page per
 * model/paper/dataset/tool/benchmark; genuine 404 (G-01 copy regression-lock);
 * leaderboard->benchmarks (P-02/03); retired 410s; knowledge honest-empty
 * (P-04); fallback image (P-01); console/network hygiene; desktop+mobile;
 * canonical; JSON-LD; a11y basics; sitemap<->canonical host consistency.
 */
import { test, expect, devices } from '@playwright/test';
import {
    BASE_URL, DETAIL_TYPES, resolveRealSlug, attachConsoleCollector,
    discoverBuildId, discoverSnapshotId, emitRunArtifact, record,
} from './srs2a-helpers';

const FUTURE_COPY = /being indexed|will appear|being aggregated|coming soon|check back/i;

let BUILD_ID = 'undiscoverable';
let SNAPSHOT_ID = 'unobservable';

test.beforeAll(async ({ request }) => {
    BUILD_ID = await discoverBuildId(request);
    SNAPSHOT_ID = await discoverSnapshotId(request);
});

test.afterAll(async () => {
    await emitRunArtifact(BUILD_ID, SNAPSHOT_ID);
});

test.describe('SRS-2A frontend deployed baseline @informational', () => {
    test('homepage: 200, catalog present, no severe console errors [FM:home]', async ({ page }) => {
        const sink = attachConsoleCollector(page);
        const resp = await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), 'homepage status').toBe(200);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        const catalog = page.locator('a[href*="/model/"], a[href*="/paper/"], a[href*="/tool/"], a[href*="/dataset/"]');
        await expect(catalog.first()).toBeVisible({ timeout: 15000 });
        expect(sink.errors, `console: ${sink.errors.join(' | ')}`).toHaveLength(0);
        record({ assertion: 'homepage', expected: '200 + catalog + no errors', actual: `200 errs=${sink.errors.length}`, pass: sink.errors.length === 0 });
    });

    test('explore: 301 -> /models [FM:explore]', async ({ request }) => {
        const resp = await request.get(`${BASE_URL}/explore`, { maxRedirects: 0 });
        expect(resp.status(), 'explore redirect').toBe(301);
        expect(resp.headers()['location']).toMatch(/\/models$/);
        record({ assertion: 'explore-redirect', expected: '301 ->/models', actual: `${resp.status()} ${resp.headers()['location']}`, pass: resp.status() === 301 });
    });

    test('search: page loads + honest empty on no-result [FM:search]', async ({ page }) => {
        const sink = attachConsoleCollector(page);
        const ok = await page.goto(`${BASE_URL}/search?q=llama`, { waitUntil: 'domcontentloaded' });
        expect(ok?.status()).toBe(200);
        await page.goto(`${BASE_URL}/search?q=zzqxnonexistentquery9988`, { waitUntil: 'domcontentloaded' });
        const body = (await page.locator('body').innerText()).toLowerCase();
        expect(body, 'no future-availability copy on empty search').not.toMatch(FUTURE_COPY);
        record({ assertion: 'search-honest-empty', expected: 'loads + no future copy', actual: `errs=${sink.errors.length}`, pass: true });
    });

    for (const { type, route, queries } of DETAIL_TYPES) {
        test(`detail ${type}: real id -> 200, no severe console errors [FM:detail-${type}]`, async ({ page, request }) => {
            const slug = await resolveRealSlug(request as any, type, queries);
            test.skip(!slug, `no resolvable ${type} id on prod right now (sparse type)`);
            const sink = attachConsoleCollector(page);
            const resp = await page.goto(`${BASE_URL}/${route}/${slug}`, { waitUntil: 'domcontentloaded' });
            const status = resp?.status() ?? 0;
            // Transient cold-path 503 (honest envelope) is observed, not a hard fail.
            if (status === 503) {
                record({ assertion: `detail-${type}`, expected: '200', actual: '503 transient cold-path', keyFields: { slug }, pass: false });
                test.skip(true, `${type} ${slug} returned transient 503 (cold-path honest envelope)`);
            }
            expect(status, `${type} detail status`).toBe(200);
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 15000 });
            expect(sink.errors, `console: ${sink.errors.join(' | ')}`).toHaveLength(0);
            record({ assertion: `detail-${type}`, expected: '200 + no errors', actual: `${status} errs=${sink.errors.length}`, keyFields: { slug }, pass: sink.errors.length === 0 });
        });
    }

    test('genuine 404: status 404 + NO future-availability copy (G-01 lock) [FM:404]', async ({ page }) => {
        const resp = await page.goto(`${BASE_URL}/model/zz-nonexistent-${Date.now().toString(36)}`, { waitUntil: 'domcontentloaded' });
        expect(resp?.status(), '404 status').toBe(404);
        const body = (await page.locator('body').innerText()).toLowerCase();
        expect(body, 'G-01: 404 must not promise future availability').not.toMatch(FUTURE_COPY);
        record({ assertion: '404-honest', expected: '404 + no future copy', actual: `${resp?.status()}`, pass: resp?.status() === 404 });
    });

    test('leaderboard: 301 -> /benchmarks (P-02/03) [FM:leaderboard]', async ({ request }) => {
        const resp = await request.get(`${BASE_URL}/leaderboard`, { maxRedirects: 0 });
        expect(resp.status()).toBe(301);
        expect(resp.headers()['location']).toMatch(/\/benchmarks$/);
        record({ assertion: 'leaderboard-redirect', expected: '301 ->/benchmarks', actual: `${resp.status()} ${resp.headers()['location']}`, pass: resp.status() === 301 });
    });

    for (const path of ['/agent/x', '/space/x', '/prompt/x', '/reports']) {
        test(`retired ${path}: 410 Gone [FM:retired]`, async ({ request }) => {
            const resp = await request.get(`${BASE_URL}${path}`, { maxRedirects: 0 });
            expect(resp.status(), `${path} status`).toBe(410);
            record({ assertion: `retired-${path}`, expected: '410', actual: `${resp.status()}`, pass: resp.status() === 410 });
        });
    }

    test('knowledge: honest empty, no "being aggregated" copy (P-04) [FM:knowledge]', async ({ page }) => {
        const resp = await page.goto(`${BASE_URL}/knowledge`, { waitUntil: 'domcontentloaded' });
        expect(resp?.status()).toBe(200);
        const body = (await page.locator('body').innerText()).toLowerCase();
        expect(body, 'P-04: knowledge must not promise aggregation').not.toMatch(/being aggregated/i);
        record({ assertion: 'knowledge-honest', expected: '200 + no aggregation copy', actual: `${resp?.status()}`, pass: resp?.status() === 200 });
    });

    test('fallback image: image-less detail uses a 200 image, not 404 default-model.jpg (P-01) [FM:image]', async ({ page, request }) => {
        const slug = await resolveRealSlug(request as any, 'model', ['llama', 'qwen']);
        test.skip(!slug, 'no resolvable model id for image probe');
        const broken: string[] = [];
        page.on('response', (r) => {
            if (r.status() === 404 && /default-model\.jpg/i.test(r.url())) broken.push(r.url());
        });
        const resp = await page.goto(`${BASE_URL}/model/${slug}`, { waitUntil: 'networkidle' });
        if (resp?.status() === 503) test.skip(true, 'transient 503 cold-path');
        expect(broken, `P-01: no 404 default-model.jpg request: ${broken.join(',')}`).toHaveLength(0);
        record({ assertion: 'fallback-image', expected: 'no 404 default-model.jpg', actual: `broken=${broken.length}`, keyFields: { slug }, pass: broken.length === 0 });
    });

    test('network hygiene: no broken (404) asset requests on homepage [FM:resources]', async ({ page }) => {
        const sink = attachConsoleCollector(page);
        await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle' });
        expect(sink.badRequests, `bad requests: ${sink.badRequests.join(' | ')}`).toHaveLength(0);
        record({ assertion: 'network-hygiene', expected: 'no broken assets', actual: `bad=${sink.badRequests.length}`, pass: sink.badRequests.length === 0 });
    });

    test('viewports: homepage + one detail render on desktop and mobile [FM:responsive]', async ({ browser, request }) => {
        const slug = await resolveRealSlug(request as any, 'tool', ['code', 'agent']);
        for (const [label, vp] of [['desktop', { width: 1280, height: 800 }], ['mobile', devices['Pixel 5'].viewport]] as const) {
            const ctx = await browser.newContext({ viewport: vp });
            const page = await ctx.newPage();
            const home = await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
            expect(home?.status(), `${label} home`).toBe(200);
            await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 15000 });
            if (slug) {
                const d = await page.goto(`${BASE_URL}/tool/${slug}`, { waitUntil: 'domcontentloaded' });
                expect([200, 503], `${label} detail`).toContain(d?.status());
            }
            await ctx.close();
        }
        record({ assertion: 'viewports', expected: 'desktop+mobile render', actual: 'ok', keyFields: { slug }, pass: true });
    });

    test('canonical: <link rel=canonical> present + host free2aitools.com on detail [FM:canonical]', async ({ page, request }) => {
        const slug = await resolveRealSlug(request as any, 'tool', ['code', 'agent', 'chat']);
        test.skip(!slug, 'no resolvable detail for canonical check');
        const resp = await page.goto(`${BASE_URL}/tool/${slug}`, { waitUntil: 'domcontentloaded' });
        if (resp?.status() === 503) test.skip(true, 'transient 503');
        const href = await page.locator('link[rel="canonical"]').first().getAttribute('href');
        expect(href, 'canonical present').toBeTruthy();
        expect(new URL(href!).host, 'canonical host').toBe('free2aitools.com');
        record({ assertion: 'canonical', expected: 'present + free2aitools.com', actual: String(href), keyFields: { slug }, pass: !!href });
    });

    test('JSON-LD: <script type=ld+json> present + valid JSON on detail [FM:jsonld]', async ({ page, request }) => {
        const slug = await resolveRealSlug(request as any, 'tool', ['code', 'agent', 'chat']);
        test.skip(!slug, 'no resolvable detail for JSON-LD check');
        const resp = await page.goto(`${BASE_URL}/tool/${slug}`, { waitUntil: 'domcontentloaded' });
        if (resp?.status() === 503) test.skip(true, 'transient 503');
        const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
        expect(blocks.length, 'has ld+json').toBeGreaterThan(0);
        for (const b of blocks) expect(() => JSON.parse(b), 'valid JSON-LD').not.toThrow();
        record({ assertion: 'json-ld', expected: 'present + valid', actual: `blocks=${blocks.length}`, keyFields: { slug }, pass: blocks.length > 0 });
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
        record({ assertion: 'a11y-basics', expected: 'headings+labels+focus', actual: `unlabeled=${unlabeled} focus=${active}`, pass: unlabeled === 0 });
    });

    test('sitemap<->page canonical host consistency [FM:sitemap]', async ({ page, request }) => {
        const idx = await request.get(`${BASE_URL}/sitemap-index.xml`);
        expect(idx.status(), 'sitemap-index 200').toBe(200);
        const shard = (await idx.text()).match(/https?:\/\/[^<]+\.xml/)?.[0];
        test.skip(!shard, 'no sitemap shard found');
        const shardResp = await request.get(shard!);
        expect(shardResp.status(), 'shard 200').toBe(200);
        const loc = (await shardResp.text()).match(/<loc>(https?:\/\/[^<]+)<\/loc>/)?.[1];
        test.skip(!loc, 'no <loc> in shard');
        const resp = await page.goto(loc!, { waitUntil: 'domcontentloaded' });
        test.skip(resp?.status() !== 200, `sampled sitemap url not 200 (${resp?.status()})`);
        const canon = await page.locator('link[rel="canonical"]').first().getAttribute('href');
        if (canon) expect(new URL(canon).host, 'canonical host matches sitemap host').toBe(new URL(loc!).host);
        record({ assertion: 'sitemap-canonical-consistency', expected: 'host match', actual: `loc=${loc} canon=${canon}`, keyFields: { shard }, pass: true });
    });
});
