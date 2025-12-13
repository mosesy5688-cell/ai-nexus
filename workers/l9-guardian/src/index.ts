/**
 * L9 Guardian Worker - Constitution V4.8 Enforcer
 * 
 * SYNC Phase (<5ms):
 * - Rate limit (memory-based)
 * - Blacklist check (KV read)
 * - Constitution violation detection
 * 
 * ASYNC Phase (Fire-and-Forget):
 * - Honeypot detection
 * - Pattern analysis
 * - Quarantine logging
 * 
 * Art.IX-Batch: KV writes batched, <500/day
 * Art.IX-Metrics: 1% sampling for P95 monitoring
 */

interface Env {
    KV_CACHE: KVNamespace;
    DB: D1Database;
}

// In-memory rate limit cache (resets on worker restart, but that's fine for basic protection)
const rateLimitCache = new Map<string, { count: number; resetAt: number }>();

// Pending blacklist entries (Art.IX-Batch: batch writes)
const pendingBlacklist = new Set<string>();
let lastBatchFlush = Date.now();

// Constants per Constitution V4.8
const RATE_LIMIT_PER_MINUTE = 100;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const BLACKLIST_TTL_SECONDS = 86400; // 24 hours
const BATCH_FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_FLUSH_SIZE = 50;
const P95_SAMPLE_RATE = 0.01; // 1%

// Honeypot patterns (ASYNC only - never in SYNC path)
const HONEYPOT_PATTERNS = [
    /<script/i,
    /javascript:/i,
    /onclick\s*=/i,
    /onerror\s*=/i,
    /eval\s*\(/i,
    /document\.cookie/i,
    /\.\.\/\.\.\//,
    /union\s+select/i,
    /drop\s+table/i
];

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const startTime = performance.now();
        const ip = request.headers.get('cf-connecting-ip') || 'unknown';
        const url = new URL(request.url);

        // ═══════════════════════════════════════════════════════
        // SYNC PHASE: Must complete in <5ms
        // ═══════════════════════════════════════════════════════

        // 1. Check blacklist (KV read - fast)
        const isBlacklisted = await env.KV_CACHE.get(`blacklist:${ip}`);
        if (isBlacklisted) {
            return new Response('Forbidden', {
                status: 403,
                headers: { 'X-Guardian-Blocked': 'blacklist' }
            });
        }

        // 2. Rate limit check (memory - instant)
        const now = Date.now();
        const rateKey = `${ip}:${url.pathname}`;
        const rateData = rateLimitCache.get(rateKey);

        if (rateData) {
            if (now < rateData.resetAt) {
                if (rateData.count >= RATE_LIMIT_PER_MINUTE) {
                    // Rate limited - add to pending blacklist for ASYNC processing
                    pendingBlacklist.add(ip);
                    return new Response('Too Many Requests', {
                        status: 429,
                        headers: {
                            'Retry-After': '60',
                            'X-Guardian-Blocked': 'rate-limit'
                        }
                    });
                }
                rateData.count++;
            } else {
                // Window reset
                rateData.count = 1;
                rateData.resetAt = now + RATE_LIMIT_WINDOW_MS;
            }
        } else {
            rateLimitCache.set(rateKey, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        }

        // 3. Quick UA check (no regex, just includes - fast)
        const ua = request.headers.get('user-agent') || '';
        const suspiciousUA = ua === '' || (ua.length < 10 && !ua.includes('Mozilla'));

        // Pass through to origin
        const response = await fetch(request);

        // Calculate guardian time
        const guardianTime = (performance.now() - startTime).toFixed(2);

        // Clone response to add headers
        const newHeaders = new Headers(response.headers);
        newHeaders.set('X-Guardian-Time', `${guardianTime}ms`);
        newHeaders.set('X-Guardian-Version', 'v4.8');

        const guardedResponse = new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: newHeaders
        });

        // ═══════════════════════════════════════════════════════
        // ASYNC PHASE: Fire-and-Forget (never blocks response)
        // ═══════════════════════════════════════════════════════
        ctx.waitUntil((async () => {
            try {
                // 1. Honeypot detection for POST/PUT requests
                if (request.method === 'POST' || request.method === 'PUT') {
                    const body = await request.clone().text();
                    const triggers = detectHoneypot(body);

                    if (triggers.length > 0) {
                        // Add to blacklist
                        pendingBlacklist.add(ip);

                        // Log to quarantine
                        await logQuarantine(env.DB, ip, 'honeypot', triggers.join(','));
                    }
                }

                // 2. Suspicious UA logging
                if (suspiciousUA) {
                    await logQuarantine(env.DB, ip, 'suspicious_ua', ua);
                }

                // 3. Batch flush blacklist (Art.IX-Batch)
                if (pendingBlacklist.size >= BATCH_FLUSH_SIZE ||
                    (now - lastBatchFlush > BATCH_FLUSH_INTERVAL_MS && pendingBlacklist.size > 0)) {
                    await flushBlacklist(env.KV_CACHE, pendingBlacklist);
                    lastBatchFlush = now;
                }

                // 4. P95 Metrics sampling (Art.IX-Metrics)
                if (Math.random() < P95_SAMPLE_RATE) {
                    await env.KV_CACHE.put(
                        `metrics:guardian:${Date.now()}`,
                        guardianTime,
                        { expirationTtl: 86400 }
                    );
                }

            } catch (error) {
                // Fire-and-forget: errors don't affect response
                console.error('[L9 Guardian ASYNC Error]', error);
            }
        })());

        return guardedResponse;
    }
};

// Honeypot detection (used in ASYNC only)
function detectHoneypot(body: string): string[] {
    if (!body || body.length > 100000) return []; // Skip very large bodies

    const triggers: string[] = [];
    for (const pattern of HONEYPOT_PATTERNS) {
        if (pattern.test(body)) {
            triggers.push(pattern.source);
        }
    }
    return triggers;
}

// Log to quarantine_log table
async function logQuarantine(db: D1Database, entityId: string, reason: string, details: string): Promise<void> {
    try {
        await db.prepare(`
      INSERT INTO quarantine_log (entity_id, reason, severity, created_at)
      VALUES (?, ?, ?, datetime('now'))
    `).bind(entityId, `${reason}:${details}`, 'medium').run();
    } catch (error) {
        console.error('[L9 Guardian] Quarantine log error:', error);
    }
}

// Batch flush blacklist to KV (Art.IX-Batch)
async function flushBlacklist(kv: KVNamespace, pending: Set<string>): Promise<void> {
    const entries = Array.from(pending);
    pending.clear();

    // Write in parallel (but limited to avoid overwhelming KV)
    const batchSize = 10;
    for (let i = 0; i < entries.length; i += batchSize) {
        const batch = entries.slice(i, i + batchSize);
        await Promise.all(
            batch.map(ip =>
                kv.put(`blacklist:${ip}`, 'true', { expirationTtl: BLACKLIST_TTL_SECONDS })
            )
        );
    }

    console.log(`[L9 Guardian] Flushed ${entries.length} blacklist entries`);
}
