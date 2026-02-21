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
        return new Response('Access Denied', { status: 403, headers: { 'Access-Control-Allow-Origin': '*' } });
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
        // V18.10.2: Explicit Edge Caching with Revalidation Guard
        'Cache-Control': 'public, max-age=0, must-revalidate, s-maxage=60',
        'x-vfs-proxy-ver': '1.4.0-hardened',
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

        // Alignment Guard (SPEC-V19.2): Compatible with 4K legacy and 8K optimized
        if (responseSize > 1024 && (start % 4096 !== 0)) {
            console.warn(`[VFS-PROXY] Alignment Error: ${start} for ${filename}`);
            return new Response('Alignment Error', { status: 416 });
        }

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
        return new Response('Internal Proxy Error', { status: 500 });
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
    requestChunkSize: 32768, // Mitigates 429s
    cacheSize: 6 * 1024 * 1024,
    workerUrl: '/assets/sqlite/sqlite.worker.js',
    wasmUrl: '/assets/sqlite/sql-wasm.wasm'
};

const MAX_SEARCH_SEATS = 20; // V21.9: Increased from 5 to 20 to accommodate VFS parallel chunk fetching
let activeSeats = 0;
export async function acquireSearchSeat(): Promise<boolean> {
    if (activeSeats >= MAX_SEARCH_SEATS) return false;
    activeSeats++;
    return true;
}
export function releaseSearchSeat() { activeSeats = Math.max(0, activeSeats - 1); }
