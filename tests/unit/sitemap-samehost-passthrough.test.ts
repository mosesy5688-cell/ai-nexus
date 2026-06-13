import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// SEO serving-layer fix — sitemap shard files must be served as a SAME-HOST 200
// streaming pass-through of the static CDN `.xml.gz` object (Content-Type
// application/xml + Content-Encoding gzip), NOT a cross-host 302 to
// cdn.free2aitools.com/...xml.gz (which Google reports as unreadable). The
// upstream gzip body is streamed straight back, never buffered/decompressed,
// and upstream failures are NOT laundered into a fake 200.

import { GET, HEAD } from '../../src/pages/sitemaps/[filename].ts';

function ctx(filename: string) {
    return { params: { filename } } as any;
}

// A body stand-in that records whether anyone tried to read it.
function spyBody() {
    let consumed = false;
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array([0x1f, 0x8b, 0x08])); // gzip magic
            controller.close();
        },
    });
    // Wrap getReader/cancel to detect consumption.
    const realGetReader = stream.getReader.bind(stream);
    (stream as any).getReader = (...a: any[]) => { consumed = true; return realGetReader(...a); };
    (stream as any).cancel = vi.fn(async () => { /* cancel is allowed, not "consumption" */ });
    return { stream, wasConsumed: () => consumed };
}

function upstream(opts: {
    status?: number;
    ok?: boolean;
    body?: ReadableStream | null;
    headers?: Record<string, string>;
    text?: string;
}): Response {
    const headers = new Headers(opts.headers ?? {});
    const status = opts.status ?? 200;
    return {
        status,
        ok: opts.ok ?? (status >= 200 && status < 300),
        body: opts.body ?? null,
        headers,
        text: vi.fn(async () => opts.text ?? ''),
    } as unknown as Response;
}

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('GET /sitemaps/[filename] — same-host gzip-XML pass-through', () => {
    it('1. shard GET no longer returns a 302 redirect', async () => {
        const { stream } = spyBody();
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ body: stream })));
        const res = await GET(ctx('sitemap-3.xml'));
        expect(res.status).not.toBe(302);
        expect(res.headers.get('Location')).toBeNull();
    });

    it('2. upstream 200 -> same-host 200 (no Location header)', async () => {
        const { stream } = spyBody();
        const fetchMock = vi.fn(async () => upstream({ body: stream }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await GET(ctx('sitemap-0.xml'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Location')).toBeNull();
        // It fetched the `.xml.gz` variant of the shard same-origin upstream.
        expect(fetchMock).toHaveBeenCalledWith('https://cdn.free2aitools.com/sitemaps/sitemap-0.xml.gz');
    });

    it('3. response advertises application/xml + Content-Encoding gzip', async () => {
        const { stream } = spyBody();
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ body: stream })));
        const res = await GET(ctx('sitemap-1.xml'));
        expect(res.headers.get('Content-Type')).toMatch(/application\/xml/);
        expect(res.headers.get('Content-Encoding')).toBe('gzip');
    });

    it('3b. accepts an already-.xml.gz shard name and serves it the same way', async () => {
        const { stream } = spyBody();
        const fetchMock = vi.fn(async () => upstream({ body: stream }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await GET(ctx('sitemap-7.xml.gz'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Encoding')).toBe('gzip');
        expect(fetchMock).toHaveBeenCalledWith('https://cdn.free2aitools.com/sitemaps/sitemap-7.xml.gz');
    });

    it('4. body is streamed (passed through, not consumed/transformed)', async () => {
        const { stream, wasConsumed } = spyBody();
        const up = upstream({ body: stream });
        vi.stubGlobal('fetch', vi.fn(async () => up));
        const res = await GET(ctx('sitemap-2.xml'));
        // Same body reference forwarded; route never read/buffered it.
        expect(res.body).toBe(stream);
        expect(wasConsumed()).toBe(false);
        expect((up.text as any)).not.toHaveBeenCalled();
    });

    it('4b. copies ETag / Last-Modified when safely present (allow-list only)', async () => {
        const { stream } = spyBody();
        vi.stubGlobal('fetch', vi.fn(async () => upstream({
            body: stream,
            headers: {
                ETag: '"abc123"',
                'Last-Modified': 'Wed, 10 Jun 2026 00:00:00 GMT',
                // A non-allow-listed upstream header must NOT leak through.
                'Content-Type': 'application/gzip',
            },
        })));
        const res = await GET(ctx('sitemap-4.xml'));
        expect(res.headers.get('ETag')).toBe('"abc123"');
        expect(res.headers.get('Last-Modified')).toBe('Wed, 10 Jun 2026 00:00:00 GMT');
        // The bad upstream Content-Type was overridden, not forwarded.
        expect(res.headers.get('Content-Type')).toMatch(/application\/xml/);
    });

    it('5a. upstream 404 is NOT laundered into 200 -> 502', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 404, ok: false, body: null })));
        const res = await GET(ctx('sitemap-9.xml'));
        expect(res.status).toBe(502);
        expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    });

    it('5b. upstream 500 -> 502', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 500, ok: false, body: null })));
        const res = await GET(ctx('sitemap-9.xml'));
        expect(res.status).toBe(502);
    });

    it('5c. upstream 503 (origin unavailable) -> 503', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 503, ok: false, body: null })));
        const res = await GET(ctx('sitemap-9.xml'));
        expect(res.status).toBe(503);
    });

    it('5d. fetch throws (timeout / origin unreachable) -> 503', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ETIMEDOUT'); }));
        const res = await GET(ctx('sitemap-9.xml'));
        expect(res.status).toBe(503);
        expect(res.headers.get('Content-Type')).toMatch(/text\/plain/);
    });

    it('6. sitemap-index route behavior unchanged (inline application/xml, 200)', async () => {
        const xml = '<?xml version="1.0"?><sitemapindex></sitemapindex>';
        const fetchMock = vi.fn(async () => upstream({ text: xml, headers: {} }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await GET(ctx('sitemap-index.xml'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/xml');
        // No gzip encoding on the inline index — it is uncompressed XML.
        expect(res.headers.get('Content-Encoding')).toBeNull();
        expect(await res.text()).toBe(xml);
        expect(fetchMock).toHaveBeenCalledWith('https://cdn.free2aitools.com/sitemaps/sitemap-index.xml');
    });

    it('6b. missing sitemap-index upstream -> 404 (unchanged)', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 404, ok: false })));
        const res = await GET(ctx('sitemap-index.xml'));
        expect(res.status).toBe(404);
    });

    it('7. a non-sitemap-shard filename is NOT proxied (still 404)', async () => {
        const fetchMock = vi.fn(async () => upstream({ body: spyBody().stream }));
        vi.stubGlobal('fetch', fetchMock);
        const res = await GET(ctx('robots.txt'));
        expect(res.status).toBe(404);
        // Never reached out to the CDN for an unrecognized name.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('7b. a missing filename param -> 404', async () => {
        const res = await GET(ctx(undefined as any));
        expect(res.status).toBe(404);
    });
});

describe('HEAD /sitemaps/[filename] — same status/headers as GET, no body', () => {
    it('8a. HEAD on a shard -> 200, gzip-XML headers, empty body', async () => {
        const { stream } = spyBody();
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ body: stream })));
        const res = await HEAD(ctx('sitemap-5.xml'));
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toMatch(/application\/xml/);
        expect(res.headers.get('Content-Encoding')).toBe('gzip');
        expect(res.headers.get('Location')).toBeNull();
        expect(await res.text()).toBe('');
    });

    it('8b. HEAD propagates upstream failure status with no body', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => upstream({ status: 500, ok: false, body: null })));
        const res = await HEAD(ctx('sitemap-5.xml'));
        expect(res.status).toBe(502);
        expect(await res.text()).toBe('');
    });
});
