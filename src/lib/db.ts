/**
 * V19.0 Database & VFS Service
 * Industrial-Grade Search Plane (A-Rating)
 */

import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * HARDENED RANGE PROXY (Security Pillar)
 * Enforces 8KB Page Alignment and Bounds Checking
 * 
 * SPEC-V19-SEC: 
 * - range.start % 8192 === 0
 * - Filename Whitelisting
 * - Max Concurrent Searches (Seat Guard)
 */
export async function handleVfsProxy(request: Request, env: { R2_ASSETS: R2Bucket }) {
    // V19.2: Concurrency Guard (Seat Limiter)
    const hasSeat = await acquireSearchSeat();
    if (!hasSeat) {
        return new Response('Too Many Requests (Seat Limit)', { status: 429 });
    }

    try {
        return await processVfsProxy(request, env);
    } finally {
        releaseSearchSeat();
    }
}

/**
 * INTERNAL PROXY LOGIC (Shielded by Seat Guard)
 */
async function processVfsProxy(request: Request, env: { R2_ASSETS: R2Bucket }) {
    // V21.9: Cloudflare Worker Safety Guard
    const isDev = !!(process.env.NODE_ENV === 'development' || import.meta.env?.DEV);
    const url = new URL(request.url);
    let filename = url.pathname.split('/').pop();

    // 1. Filename Whitelisting (V19.4.5)
    if (!filename || (!filename.endsWith('.db') && !filename.endsWith('.vfs') && !filename.endsWith('.bin'))) {
        return new Response('Access Denied', {
            status: 403,
            headers: { 'x-vfs-proxy-ver': 'v19.4.5', 'Access-Control-Allow-Origin': '*' }
        });
    }

    // Translate legacy shard names
    if (filename === 'shard_0.bin') filename = 'fused-shard-000.bin';
    if (filename.startsWith('shard_')) {
        const num = filename.match(/\d+/)?.[0];
        if (num) filename = `fused-shard-${num.padStart(3, '0')}.bin`;
    }

    // V21.9: Anchor Metadata Discovery (Required for Range validation)
    let totalSize = 0;
    let etag = '';
    let isLocal = false;

    if (isDev) {
        try {
            const { resolve } = await import('path');
            const { stat } = await import('fs/promises');
            const localPath = resolve(process.cwd(), 'data', filename);
            const stats = await stat(localPath);
            totalSize = stats.size;
            etag = `local-${stats.mtimeMs}`;
            isLocal = true;
        } catch (e) {
            console.warn(`[VFS-PROXY] Local file not found: data/${filename}, falling back to R2.`);
        }
    }

    if (!isLocal) {
        const objectHead = await env.R2_ASSETS.head(`data/${filename}`);
        if (!objectHead) return new Response('Not Found', { status: 404 });
        totalSize = objectHead.size;
        etag = objectHead.httpEtag;
    }

    const commonHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type',
        'Cache-Control': 'public, max-age=3600, s-maxage=31536000', // SPEC-V19: CDN Shielding
        'x-vfs-proxy-ver': '1.2.0-stabilized',
        'x-vfs-alignment': 'flexible'
    };

    // 2. Handle HEAD Requests (Metadata Probe)
    if (request.method === 'HEAD') {
        const headers = new Headers(commonHeaders as any);
        headers.set('Content-Length', totalSize.toString());
        return new Response(null, { headers });
    }

    const rangeHeader = request.headers.get('Range');

    // 3. Handle Full Requests (Standard 200 OK)
    if (!rangeHeader) {
        const headers = new Headers(commonHeaders as any);
        headers.set('Content-Length', totalSize.toString());

        if (isLocal) {
            const { readFile } = await import('fs/promises');
            const { resolve } = await import('path');
            const buffer = await readFile(resolve(process.cwd(), 'data', filename));
            return new Response(buffer, { status: 200, headers });
        } else {
            const object = await env.R2_ASSETS.get(`data/${filename}`);
            if (!object) return new Response('Not Found', { status: 404 });
            object.writeHttpMetadata(headers as any);
            return new Response(object.body as any, { status: 200, headers });
        }
    }

    // 4. Handle Range Requests (VFS Stream)
    let start: number;
    let end: number;

    try {
        const rangeValue = rangeHeader.trim().toLowerCase();
        if (!rangeValue.startsWith('bytes=')) return new Response('Invalid Range', { status: 416 });

        const rawRanges = rangeValue.replace('bytes=', '').trim();
        const firstRange = rawRanges.split(',')[0].trim();
        const parts = firstRange.split('-');

        if (parts[0] === '') {
            // Suffix range (last N bytes)
            const suffix = parseInt(parts[1], 10);
            if (isNaN(suffix)) return new Response('Invalid Suffix', { status: 416 });

            if (isLocal) {
                const { readFile } = await import('fs/promises');
                const { resolve } = await import('path');
                const buffer = await readFile(resolve(process.cwd(), 'data', filename));
                const suffixBuffer = buffer.subarray(buffer.length - suffix);
                const headers = new Headers(commonHeaders as any);
                headers.set('Content-Length', suffix.toString());
                headers.set('Content-Range', `bytes ${totalSize - suffix}-${totalSize - 1}/${totalSize}`);
                return new Response(suffixBuffer, { status: 206, headers });
            } else {
                const object = await env.R2_ASSETS.get(`data/${filename}`, { range: { suffix } });
                if (!object) return new Response('Not Found', { status: 404 });

                const headers = new Headers(commonHeaders as any);
                object.writeHttpMetadata(headers as any);
                headers.set('Content-Length', suffix.toString());
                headers.set('Content-Range', `bytes ${totalSize - suffix}-${totalSize - 1}/${totalSize}`);
                return new Response(object.body as any, { status: 206, headers });
            }
        }

        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : (totalSize - 1);

        if (isNaN(start) || start >= totalSize) return new Response('Range Not Satisfiable', { status: 416 });
        if (end >= totalSize) end = totalSize - 1;

    } catch (e) {
        return new Response('Invalid Range Format', { status: 416 });
    }

    const responseSize = end - start + 1;

    // Alignment & Integrity Guard (SPEC-V19.2)
    // V21.9: Flexible Alignment Support. 
    // Allowing 4096 alignment ensures compatibility with BOTH legacy (4K) 
    // and production-optimized (8K) databases simultaneously.
    if (responseSize > 1024 && (start % 4096 !== 0)) {
        console.warn(`[VFS-PROXY] Invalid Offset Alignment: ${start} for ${filename}`);
        return new Response('Alignment Error', { status: 416 });
    }

    try {
        const headers = new Headers(commonHeaders as any);
        headers.set('Content-Length', responseSize.toString());
        headers.set('Content-Range', `bytes ${start}-${end}/${totalSize}`);

        if (isLocal) {
            const { open } = await import('fs/promises');
            const { resolve } = await import('path');
            const handle = await open(resolve(process.cwd(), 'data', filename), 'r');
            const buffer = Buffer.alloc(responseSize);
            const { bytesRead } = await handle.read(buffer, 0, responseSize, start);
            await handle.close();
            return new Response(buffer.subarray(0, bytesRead), { status: 206, headers });
        } else {
            const object = await env.R2_ASSETS.get(`data/${filename}`, {
                range: { offset: start, length: responseSize }
            });

            if (!object) return new Response('Not Found', { status: 404 });
            object.writeHttpMetadata(headers as any);
            return new Response(object.body as any, { status: 206, headers });
        }
    } catch (e) {
        console.warn(`[VFS-SEC] Proxy Fetch Error: ${filename} - ${e}`);
        return new Response('Internal Proxy Error', { status: 500 });
    }
}

/**
 * SEARCH PLANE HARDENING (Constitutional Defense)
 */
export function buildHardenedQuery(userQuery: string): string {
    if (!userQuery || userQuery.length < 3) return '';

    // 1. Tokenization & Sanitization
    // Limit to 5 keywords, remove special chars, AND-only logic
    const tokens = userQuery
        .replace(/[^\w\s\u00A0-\uD7FF\uF900-\uFDCF\uFDF0-\uFFEF]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2)
        .slice(0, 5);

    if (tokens.length === 0) return '';

    // 2. FTS5 AND-logic formatting
    // query: name:"token1" AND name:"token2"
    return tokens.map(t => `"${t}"*`).join(' AND ');
}

/**
 * BROWSER VFS CONFIGURATION
 */
export const VFS_CONFIG = {
    requestChunkSize: 32768, // V21.9: Increased from 4K/8K to 32K to mitigate 429 rate-limiting
    cacheSize: 6 * 1024 * 1024, // 6MB WASM Cache (128MB RAM Constraint)
    workerUrl: '/assets/sqlite/sqlite.worker.js',
    wasmUrl: '/assets/sqlite/sql-wasm.wasm'
};

/**
 * CONCURRENCY GUARD (Seat Limiter)
 * Shared between search components to prevent R2 Quota Exhaustion
 */
const MAX_SEARCH_SEATS = 5;
let activeSeats = 0;

export async function acquireSearchSeat(): Promise<boolean> {
    if (activeSeats >= MAX_SEARCH_SEATS) return false;
    activeSeats++;
    return true;
}

export function releaseSearchSeat() {
    activeSeats = Math.max(0, activeSeats - 1);
}
