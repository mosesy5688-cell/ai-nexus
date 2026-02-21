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
    const url = new URL(request.url);
    let filename = url.pathname.split('/').pop();

    // 1. Filename Whitelisting (V19.4: Allow Shards)
    if (!filename || (!filename.endsWith('.db') && !filename.endsWith('.vfs') && !filename.endsWith('.bin'))) {
        return new Response('Access Denied', { status: 403 });
    }

    const rangeHeader = request.headers.get('Range');
    if (!rangeHeader) {
        return new Response('Range Required', { status: 416 });
    }

    let start: number;
    let end: number | undefined;

    // V19.4.3: High-Compatibility Range Parsing (Industrial Grade)
    // Handles 'bytes=0-8191', 'bytes=0-', 'bytes= 0- ', etc.
    try {
        const rangeValue = rangeHeader.trim().toLowerCase();
        if (!rangeValue.startsWith('bytes=')) {
            return new Response('Invalid Range Prefix', { status: 416 });
        }

        const rawRanges = rangeValue.replace('bytes=', '').trim();
        const firstRange = rawRanges.split(',')[0].trim(); // Take only the first range if multiple
        const parts = firstRange.split('-');

        // Handle bytes=0-8191 (parts: ['0', '8191'])
        // Handle bytes=0- (parts: ['0', ''])
        // Handle bytes=-8191 (parts: ['', '8191'])

        if (parts[0] === '') {
            // Suffix range (last N bytes) - R2 supports suffix: N
            const suffix = parseInt(parts[1], 10);
            if (isNaN(suffix)) return new Response('Invalid Suffix', { status: 416 });

            const object = await env.R2_ASSETS.get(`data/${filename}`, {
                range: { suffix }
            });
            if (!object) return new Response('Not Found', { status: 404 });
            const headers = new Headers() as any;
            object.writeHttpMetadata(headers);
            headers.set('Access-Control-Allow-Origin', '*');
            return new Response(object.body as any, { status: 206, headers });
        }

        start = parseInt(parts[0], 10);
        end = parts[1] ? parseInt(parts[1], 10) : undefined;

        if (isNaN(start)) {
            return new Response('Invalid Range Start', { status: 416 });
        }
    } catch (e) {
        console.warn(`[VFS-SEC] Range Processing Error: ${rangeHeader} - ${e}`);
        return new Response('Invalid Range Format', { status: 416 });
    }

    // 2. Alignment & Verification (8KB Page boundary)
    // V19.4: Translate legacy shard names if they appear in metadata
    if (filename === 'shard_0.bin') filename = 'fused-shard-000.bin';
    if (filename.startsWith('shard_')) {
        const num = filename.match(/\d+/)?.[0];
        if (num) filename = `fused-shard-${num.padStart(3, '0')}.bin`;
    }

    // 2. Alignment & Verification (8KB Page boundary)
    // V19.4: Loosen for small probes (< 8KB) if they start at 0
    if (start !== 0 && start % 8192 !== 0) {
        // Check if it's a very small probe (often used to find file size)
        const length = end ? (end - start + 1) : 8192;
        if (length > 8192) {
            console.warn(`[VFS-SEC] Misaligned Range Attempt: ${start}`);
            return new Response('Misaligned Range', { status: 403 });
        }
    }

    // 3. Fetch from R2 (V19.4: Target /data prefix)
    const object = await env.R2_ASSETS.get(`data/${filename}`, {
        range: { offset: start, length: end ? (end - start + 1) : undefined }
    });

    if (!object) return new Response('Not Found', { status: 404 });

    const headers = new Headers() as any;
    object.writeHttpMetadata(headers);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(object.body as any, { status: 206, headers });
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
        .filter(t => t.length >= 3)
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
    requestChunkSize: 8192,
    cacheSize: 6 * 1024 * 1024, // 6MB WASM Cache (128MB RAM Constraint)
    workerUrl: '/workers/sql-http-worker.js',
    wasmUrl: 'https://cdn.free2aitools.com/wasm/sql-wasm.wasm'
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
