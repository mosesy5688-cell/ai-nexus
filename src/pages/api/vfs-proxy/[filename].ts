import { handleVfsProxy } from '@/lib/db';

export const prerender = false;

/**
 * V19.0 Hardened VFS Range Proxy
 * Standardizes access to R2 SQLite shards with 8KB alignment.
 */
export async function GET({ request, locals }) {
    // V19.1: Ensure locals.runtime.env contains R2_ASSETS
    const env = locals.runtime?.env;

    if (!env || !env.R2_ASSETS) {
        console.error('[VFS-PROXY] R2_ASSETS binding missing in runtime env.');
        return new Response('Environment Error', { status: 500 });
    }

    return await handleVfsProxy(request, env);
}
