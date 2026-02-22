/** V19.2 Database & VFS Service: Industrial-Grade Search Plane (Under 250 Lines) */
import type { R2Bucket } from '@cloudflare/workers-types';

/** HARDENED RANGE PROXY: Seat Limit & Alignment Guard */
export async function handleVfsProxy(request: Request, env: { R2_ASSETS: R2Bucket }) {
    const hasSeat = await acquireSearchSeat();
    if (!hasSeat) return new Response('Too Many Requests (Seat Limit)', { status: 429 });
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

    if (!filename || (!filename.endsWith('.db') && !filename.endsWith('.vfs') && !filename.endsWith('.bin'))) {
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
    if (isDev) {
        try {
            const { resolve } = await import('path'), { stat } = await import('fs/promises');
            const stats = await stat(resolve(process.cwd(), 'data', filename));
            totalSize = stats.size; etag = `local-${stats.mtimeMs}`; isLocal = true;
        } catch (e) {
            console.warn(`[VFS-PROXY] Local file not found: data/${filename}`);
        }
    }

    if (!isLocal) {
        const objectHead = await env.R2_ASSETS.head(`data/${filename}`);
        if (!objectHead) return new Response('Not Found', { status: 404 });
        totalSize = objectHead.size; etag = objectHead.httpEtag;
    }

    const commonHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Access-Control-Expose-Headers': 'Accept-Ranges, Content-Range, Content-Length, ETag',
        'Cross-Origin-Resource-Policy': 'cross-origin',
        'Accept-Ranges': 'bytes',
        // V21.9: Edge Caching with URL-based Version Busting (Prevents 429s)
        'Cache-Control': 'public, max-age=3600, s-maxage=31536000',
        'x-vfs-proxy-ver': '1.4.8-alignment-perfect',
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
        } else {
            const object = await env.R2_ASSETS.get(`data/${filename}`);
            if (!object) return new Response('Not Found', { status: 404 });
            object.writeHttpMetadata(headers as any);
            return new Response(object.body as any, { status: 200, headers });
        }
    }

    try {
        const rangeValue = rangeHeader.trim().toLowerCase();
        if (!rangeValue.startsWith('bytes=')) return new Response('Invalid Range', { status: 416 });
        const parts = rangeValue.replace('bytes=', '').split(',')[0].split('-');

        if (parts[0] === '') { // Suffix range
            const suffix = parseInt(parts[1], 10);
            if (isNaN(suffix)) return new Response('Invalid Suffix', { status: 416 });
            const headers = new Headers(commonHeaders as any);
            headers.set('Content-Length', suffix.toString());
            headers.set('Content-Range', `bytes ${totalSize - suffix}-${totalSize - 1}/${totalSize}`);
            if (isLocal) {
                const { readFile } = await import('fs/promises'), { resolve } = await import('path');
                const buf = (await readFile(resolve(process.cwd(), 'data', filename))).subarray(totalSize - suffix);
                return new Response(buf, { status: 206, headers });
            } else {
                const object = await env.R2_ASSETS.get(`data/${filename}`, { range: { suffix } });
                if (!object) return new Response('Not Found', { status: 404 });
                object.writeHttpMetadata(headers as any);
                return new Response(object.body as any, { status: 206, headers });
            }
        }

        const start = parseInt(parts[0], 10);
        let end = parts[1] ? parseInt(parts[1], 10) : (totalSize - 1);
        if (isNaN(start) || start >= totalSize) return new Response('Range Not Satisfiable', { status: 416 });
        if (end >= totalSize) end = totalSize - 1;
        const responseSize = end - start + 1;

        // Alignment Guard (RELAXED): Removed to allow library pre-fetching (0.8.x compatibility)
        // Note: sql.js-httpvfs requests arbitrary ranges during index discovery

        const headers = new Headers(commonHeaders as any);
        headers.set('Content-Length', responseSize.toString());
        headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);

        if (isLocal) {
            const { open } = await import('fs/promises'), { resolve } = await import('path');
            const handle = await open(resolve(process.cwd(), 'data', filename), 'r');
            const buffer = Buffer.alloc(responseSize);
            const { bytesRead } = await handle.read(buffer, 0, responseSize, start);
            await handle.close();
            return new Response(buffer.subarray(0, bytesRead), { status: 206, headers });
        } else {
            const object = await env.R2_ASSETS.get(`data/${filename}`, { range: { offset: start, length: responseSize } });
            if (!object) return new Response('Not Found', { status: 404 });
            object.writeHttpMetadata(headers as any);
            return new Response(object.body as any, { status: 206, headers });
        }
    } catch (e) {
        return new Response('Internal Proxy Error', {
            status: 500,
            headers: { 'Cross-Origin-Resource-Policy': 'cross-origin' }
        });
    }
}

/** SEARCH PLANE HARDENING: Sanitizes and optimizes FTS5 queries */
export function buildHardenedQuery(userQuery: string): string {
    if (!userQuery || userQuery.length < 3) return '';
    const tokens = userQuery.replace(/[^\w\s\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]/g, ' ')
        .split(/\s+/).filter(t => t.length >= 2).slice(0, 5);
    return tokens.length === 0 ? '' : tokens.map(t => `"${t}"*`).join(' AND ');
}

export const VFS_CONFIG = {
    requestChunkSize: 4096, // V21.10: Matched to 4K to eliminate "Chunk size does not match page size" warnings
    cacheSize: 8 * 1024 * 1024,
    // Add version query to force cache bypass on stale security headers
    workerUrl: '/assets/sqlite/sqlite.worker.js?v=21.10.3',
    wasmUrl: '/assets/sqlite/sql-wasm.wasm?v=21.10.3'
};

const MAX_SEARCH_SEATS = 512; // V21.10: Increased to 512 for high-concurrency safety
let activeSeats = 0;
export async function acquireSearchSeat(): Promise<boolean> {
    if (activeSeats >= MAX_SEARCH_SEATS) return false;
    activeSeats++;
    return true;
}
export function releaseSearchSeat() { activeSeats = Math.max(0, activeSeats - 1); }
