// src/pages/api/comments/index.js
// V14.2 Zero-Cost Constitution: D1 REMOVED
// Comments feature DISABLED until alternative storage solution is implemented

export const prerender = false;

/**
 * V14.2: Comments API Disabled
 * 
 * D1 database has been permanently removed per Zero-Cost Constitution Art 2.1.
 * Comments require a write-capable database which conflicts with static-first architecture.
 * 
 * Future options:
 * - External comment service (Disqus, Giscus)
 * - KV-based lightweight comments (limited writes)
 * - User-submitted GitHub issues
 */

export async function GET({ request }) {
    return new Response(JSON.stringify({
        comments: [],
        message: 'Comments feature temporarily disabled for infrastructure optimization'
    }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}

export async function POST({ request }) {
    return new Response(JSON.stringify({
        error: 'Comments feature temporarily disabled',
        message: 'We are optimizing our infrastructure. Comments will return soon.',
        suggestion: 'Please use GitHub Issues to provide feedback'
    }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
    });
}
