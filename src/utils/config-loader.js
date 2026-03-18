import pako from 'pako';
import { R2_CACHE_URL } from '../config/constants.js';

/**
 * V19.4 Unified Config Loader
 * Strategy:
 * 1. SSR: Fetch from R2_ASSETS binding (if available) or R2_CACHE_URL.
 * 2. Client: Use window.__SITE_META__ if inlined by Layout.
 */

export async function getGlobalStats(key, locals = null) {
    // 1. Browser Check (Priority: Inlined Meta)
    if (typeof window !== 'undefined' && window.__SITE_META__?.[key]) {
        return window.__SITE_META__[key];
    }

    // 2. SSR Check (Priority: R2 Binding)
    const r2 = locals?.runtime?.env?.R2_ASSETS;

    // V19.4: Multi-format candidates for resilience
    const candidates = [
        `cache/${key}.json.gz`,
        `cache/${key}.json`
    ];

    if (r2) {
        for (const path of candidates) {
            try {
                const object = await r2.get(path);
                if (object) {
                    const buffer = await object.arrayBuffer();
                    if (path.endsWith('.gz')) {
                        const decompressed = pako.ungzip(new Uint8Array(buffer), { to: 'string' });
                        return JSON.parse(decompressed);
                    }
                    return JSON.parse(new TextDecoder().decode(buffer));
                }
            } catch (e) {
                console.warn(`[ConfigLoader] R2 Binding Fetch failed for ${path}:`, e.message || e);
            }
        }
    }

    // 3. Last Resort: HTTP Fetch (Legacy/Fallback)
    for (const path of candidates) {
        try {
            const url = `${R2_CACHE_URL}/${path}`;
            const res = await fetch(url);
            if (res.ok) {
                const buffer = await res.arrayBuffer();
                if (path.endsWith('.gz')) {
                    const decompressed = pako.ungzip(new Uint8Array(buffer), { to: 'string' });
                    return JSON.parse(decompressed);
                }
                return JSON.parse(new TextDecoder().decode(buffer));
            }
        } catch (e) {
            console.error(`[ConfigLoader] HTTP Fallback failed for ${key} (${path}):`, e.message || e);
        }
    }

    return null;
}

