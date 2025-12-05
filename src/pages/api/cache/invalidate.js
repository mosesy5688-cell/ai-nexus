/**
 * Cache Invalidation API
 * POST /api/cache/invalidate
 * 
 * Manually invalidate cache by pattern
 * Requires admin authentication
 */

import { invalidateCache } from '../../../lib/cache-service.js';

export const prerender = false;

export async function POST({ request, locals }) {
    try {
        // Security: Check admin token
        const authHeader = request.headers.get('Authorization');
        const expectedToken = locals.runtime?.env?.ADMIN_TOKEN || 'dev-token-change-in-production';

        if (!authHeader || authHeader !== `Bearer ${expectedToken}`) {
            return new Response(JSON.stringify({
                error: 'Unauthorized',
                message: 'Valid admin token required'
            }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const body = await request.json();
        const { pattern } = body;

        if (!pattern) {
            return new Response(JSON.stringify({
                error: 'Pattern required',
                message: 'Provide a cache key pattern to invalidate'
            }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const kv = locals.runtime?.env?.KV_CACHE;

        if (!kv) {
            return new Response(JSON.stringify({
                error: 'KV not available',
                message: 'Cache service not configured'
            }), {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Invalidate cache
        await invalidateCache(kv, pattern);

        return new Response(JSON.stringify({
            success: true,
            invalidated: pattern,
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        console.error('Cache invalidation error:', error);

        return new Response(JSON.stringify({
            error: 'Invalidation failed',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
