/** V19.2 Database & VFS Service: Industrial-Grade Search Plane (Under 250 Lines) */
import type { R2Bucket } from '@cloudflare/workers-types';
import { initShardDecrypt, decryptShardRange } from './shard-decrypt';

/** HARDENED RANGE PROXY: Seat Limit & Alignment Guard */
export async function handleVfsProxy(request: Request, env: { R2_ASSETS: R2Bucket }) {
    // V21.11: Search Smoothing - Wait for seat instead of 429 rejection
    await acquireSearchSeat();
    try {
        return await processVfsProxy(request, env);
    } finally {
        releaseSearchSeat();
    }
}

async function processVfsProxy(request: Request, env: { R2_ASSETS: R2Bucket }) {
    const isDev = !!(process.env.NODE_ENV === 'development' || import.meta.env?.DEV);
    const url = new URL(request.url);
    let filename = url.pathname.split('/').pop();

    const allowedExtensions = ['.db', '.vfs', '.bin', '.db-journal', '.db-shm', '.db-wal'];
    if (!filename || !allowedExtensions.some(ext => (filename as string).endsWith(ext))) {
        return new Response('Access Denied', {
            status: 403,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Cross-Origin-Resource-Policy': 'cross-origin'
            }
        });
    }

    if (filename === 'shard_0.bin') filename = 'fused-shard-000.bin';
    if (filename.startsWith('shard_')) {
        const num = filename.match(/\d+/)?.[0];
        if (num) filename = `fused-shard-${num.padStart(3, '0')}.bin`;
    }

    let totalSize = 0, etag = '', isLocal = false;
    const isSimulatingRemote = !!(process.env.SIMULATE_PRODUCTION || (import.meta as any).env?.SIMULATE_PRODUCTION);
    const baseUrl = 'https://cdn.free2aitools.com';

    if (isDev && !isSimulatingRemote) {
        try {
            const { resolve } = await import('path'), { stat } = await import('fs/promises');
            const stats = await stat(resolve(process.cwd(), 'data', filename));
            totalSize = stats.size; etag = `local-${stats.mtimeMs}`; isLocal = true;
        } catch (e) {
            console.warn(`[VFS-PROXY] Local file not found: data/${filename}`);
        }
    }

    if (!isLocal) {
        if (isSimulatingRemote) {
            const cdnUrl = `${baseUrl}/data/${filename}`;
            console.log(`[VFS-PROXY] CDN HEAD: ${cdnUrl}`);
            try {
                const res = await fetch(cdnUrl, { method: 'HEAD' });
                if (!res.ok) return new Response('Not Found', { status: 404 });
                totalSize = parseInt(res.headers.get('content-length') || '0', 10);
                etag = res.headers.get('etag') || 'remote-untracked';
            } catch (err: any) {
                return new Response(`CDN Error: ${err.message}`, { status: 502 });
            }
        } else if (env?.R2_ASSETS) {
            const objectHead = await env.R2_ASSETS.head(`data/${filename}`);
            if (!objectHead) return new Response('Not Found', { status: 404 });
            totalSize = objectHead.size; etag = objectHead.httpEtag;
        } else {
            return new Response('R2 Binding Missing', { status: 500 });
        }
    }

    const commonHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, ETag',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes',
        // V24.1: Edge Cache Hardening - Prevent 429 via aggressive CDN caching
        'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
        'Cloudflare-CDN-Cache-Control': 'max-age=31536000, immutable',
        'CDN-Cache-Control': 'max-age=31536000',
        'x-vfs-proxy-ver': '1.5.1-hardened',
        'ETag': etag
    };

    if (request.method === 'HEAD') {
        const headers = new Headers(commonHeaders as any);
        headers.set('Content-Length', totalSize.toString());
        return new Response(null, { headers });
    }

    const rangeHeader = request.headers.get('Range');
    if (!rangeHeader) {
        const headers = new Headers(commonHeaders as any);
        headers.set('Content-Length', totalSize.toString());
        if (isLocal) {
            const { readFile } = await import('fs/promises'), { resolve } = await import('path');
            return new Response(await readFile(resolve(process.cwd(), 'data', filename)), { status: 200, headers });
        } else if (isSimulatingRemote) {
            const cdnUrl = `${baseUrl}/data/${filename}${url.search}`;
            const res = await fetch(cdnUrl);
            const proxyRes = new Response(res.body, res);
            Object.entries(commonHeaders).forEach(([k, v]) => proxyRes.headers.set(k, v));
            return proxyRes;
        } else if (env?.R2_ASSETS) {
            const object = await env.R2_ASSETS.get(`data/${filename}`);
            if (!object) return new Response('Not Found', { status: 404 });
            const headersWithMeta = new Headers(commonHeaders as any);
            object.writeHttpMetadata(headersWithMeta as any);
            return new Response(object.body as any, { status: 200, headers: headersWithMeta });
        } else {
            return new Response('R2 Binding Missing', { status: 500 });
        }
    }

    try {
        const rangeValue = rangeHeader.trim().toLowerCase();
        if (!rangeValue.startsWith('bytes=')) return new Response('Invalid Range', { status: 416 });
        const parts = rangeValue.replace('bytes=', '').split(',')[0].split('-');

        const headers = new Headers(commonHeaders as any);

        if (isSimulatingRemote) {
            // V23.10: Proxy Range requests to CDN instead of redirect
            // Response.redirect() has immutable headers, causing middleware crashes
            const remoteUrl = `${baseUrl}/data/${filename}`;
            console.log(`[VFS-Proxy] Proxying Range: ${filename} -> ${remoteUrl}`);
            const res = await fetch(remoteUrl, { headers: { Range: rangeHeader } });
            const proxyHeaders = new Headers(commonHeaders as any);
            const cr = res.headers.get('Content-Range');
            if (cr) proxyHeaders.set('Content-Range', cr);
            proxyHeaders.set('Content-Length', res.headers.get('Content-Length') || '0');
            return new Response(res.body, { status: res.status, headers: proxyHeaders });
        }

        const start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : (totalSize - 1);
        if (isNaN(start) || start >= totalSize) return new Response('Range Not Satisfiable', { status: 416 });
        if (end >= totalSize) end = totalSize - 1;
        const responseSize = end - start + 1;

        headers.set('Content-Length', responseSize.toString());
        headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);

        if (isLocal) {
            const { open } = await import('fs/promises'), { resolve } = await import('path');
            const handle = await open(resolve(process.cwd(), 'data', filename), 'r');
            const buffer = Buffer.alloc(responseSize);
            const { bytesRead } = await handle.read(buffer, 0, responseSize, start);
            await handle.close();
            const body = await maybeDecryptBin(filename as string, buffer.subarray(0, bytesRead), start, env);
            return new Response(body, { status: 206, headers });
        } else if (env?.R2_ASSETS) {
            const object = await env.R2_ASSETS.get(`data/${filename}`, { range: { offset: start, length: responseSize } });
            if (!object) return new Response('Not Found', { status: 404 });
            object.writeHttpMetadata(headers as any);
            const raw = await new Response(object.body as any).arrayBuffer();
            const body = await maybeDecryptBin(filename as string, raw, start, env);
            return new Response(body, { status: 206, headers });
        }
        return new Response('R2 Binding Missing', { status: 500 });
    } catch (e) {
        return new Response('Internal Proxy Error', {
            status: 500,
            headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' }
        });
    }
}

/** V5.8 §1.1: Conditionally decrypt .bin shard range reads (AES-256-CTR) */
async function maybeDecryptBin(
    filename: string, data: ArrayBuffer | Uint8Array, offset: number, env: any
): Promise<ArrayBuffer | Uint8Array> {
    if (!filename.endsWith('.bin') || !(env as any)?.AES_CRYPTO_KEY) return data;
    await initShardDecrypt((env as any).AES_CRYPTO_KEY);
    return decryptShardRange(filename, data instanceof Uint8Array ? data.buffer : data, offset);
}

/** SEARCH PLANE HARDENING: Sanitizes and optimizes FTS5 queries */
export function buildHardenedQuery(userQuery: string): string {
    if (!userQuery || userQuery.length < 3) return '';
    const tokens = userQuery.replace(/[^\w\s\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]/g, ' ')
        .split(/\s+/).filter(t => t.length >= 2).slice(0, 5);
    return tokens.length === 0 ? '' : tokens.map(t => `"${t}"*`).join(' AND ');
}

// V22.10: VFS_CONFIG removed — browser no longer loads WASM SQLite.
// Search now runs server-side via /api/search.ts (wa-sqlite + R2 Range VFS on SSR).
// The VFS Proxy above is retained for fused-shard detail hydration only.

const MAX_SEARCH_SEATS = 512; // V21.10: 512 concurrent range requests permitted
let activeSeats = 0;
const seatQueue: (() => void)[] = [];

/** 
 * V21.11: Search Smoothing - Asynchronous Seat Acquisition
 * Instead of 429 rejection, excessive requests are queued to wait for available slots.
 * This prevents the massive request storms in Incognito/Empty-Cache from crashing the VFS.
 */
export async function acquireSearchSeat(): Promise<void> {
    if (activeSeats < MAX_SEARCH_SEATS) {
        activeSeats++;
        return;
    }

    return new Promise((resolve) => {
        // Enforce 15s timeout to prevent zombie connections
        const timeout = setTimeout(() => {
            const index = seatQueue.indexOf(resolve);
            if (index > -1) seatQueue.splice(index, 1);
            resolve(); // Force-start to prevent permanent hanging
        }, 15000);

        seatQueue.push(() => {
            clearTimeout(timeout);
            resolve();
        });
    });
}

export function releaseSearchSeat() {
    activeSeats = Math.max(0, activeSeats - 1);
    const next = seatQueue.shift();
    if (next) {
        activeSeats++;
        next();
    }
}
