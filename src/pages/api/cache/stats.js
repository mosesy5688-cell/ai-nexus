/**
 * Cache Statistics API
 * GET /api/cache/stats
 * 
 * Returns cache usage statistics
 */

import { getCacheStats } from '../../../lib/cache-service.js';

export const prerender = false;

export async function GET({ locals }) {
    try {
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

        const stats = await getCacheStats(kv);

        return new Response(JSON.stringify({
            success: true,
            stats,
            timestamp: new Date().toISOString()
        }), {
            status: 200,
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache' // Don't cache stats endpoint
            }
        });

    } catch (error) {
        console.error('Cache stats error:', error);

        return new Response(JSON.stringify({
            error: 'Failed to get stats',
            message: error.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
