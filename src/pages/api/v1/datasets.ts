/**
 * V∞ Phase 4 — Parquet Datasets API
 * Serves dataset file listings and proxies downloads from R2.
 * GET /api/v1/datasets         → JSON manifest of available parquet files
 * GET /api/v1/datasets?file=X  → Redirect to CDN download URL
 */
export const prerender = false;

// Route-local Adoption Telemetry (DEFAULT-OFF, fail-open, #2218-safe). Imported
// ONLY here + mcp.ts; NEVER from middleware. Does not name the AE binding token.
import { emitRoute, extractTelemetryEnv } from '../../../lib/telemetry/route-telemetry';
import { hostFromReferer, isBotUa } from '../../../lib/telemetry/route-classify';

const CDN_BASE = 'https://cdn.free2aitools.com';

// access: 'public' is the truthful access class (all datasets are open/no-auth).
// tier: 'free' is RETAINED as a legacy compatibility field (its only legal value
// is "free"; see openapi-schema.json DatasetsResponse). It is NOT deleted here —
// silently dropping a field a consumer reads is a breaking change (deferred to v2).
const KNOWN_FILES = [
    { id: 'fni_lite_latest', name: 'FNI Lite (Latest)', path: 'datasets/fni_lite_latest.parquet', tier: 'free', access: 'public', fields: ['id', 'title', 'abstract_300', 'fni_score', 'fni_version'] },
];

// Route-local recorder. DEFAULT-OFF, fail-open, NON-BLOCKING: emits a closed
// low-cardinality event (datasets surface + coarse status) to the write adapter,
// which no-ops unless explicitly enabled & bound. NEVER alters the response/
// status/body/latency control flow; failure swallowed in emitRoute. Audience/
// referer derive from header VALUES (never stored raw); NO query/path recorded.
function recordDatasets(request: Request, locals: any, status: number): void {
    try {
        emitRoute(extractTelemetryEnv(locals), {
            surface: 'datasets.302', status, cacheClass: 'none',
            refererHost: hostFromReferer(request?.headers?.get?.('referer')),
            audience: { isBot: isBotUa(request?.headers?.get?.('user-agent')) },
        });
    } catch { /* fail-open: telemetry never touches the serve path */ }
}

export async function GET({ request, locals }: { request: Request; locals: any }) {
    const url = new URL(request.url);
    const file = url.searchParams.get('file');

    if (file) {
        const entry = KNOWN_FILES.find(f => f.id === file);
        if (!entry) {
            const response = new Response(JSON.stringify({ error: 'Unknown file' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
            recordDatasets(request, locals, response.status);
            return response;
        }
        const response = Response.redirect(`${CDN_BASE}/${entry.path}`, 302);
        recordDatasets(request, locals, response.status);
        return response;
    }

    const body = {
        version: 'fni_v2.0',
        description: 'Free2AI open datasets — FNI-scored AI entity rankings in Parquet format.',
        files: KNOWN_FILES.map(f => ({
            id: f.id,
            name: f.name,
            tier: f.tier,
            access: f.access,
            fields: f.fields,
            download_url: `${CDN_BASE}/${f.path}`,
            api_url: `/api/v1/datasets?file=${f.id}`,
        })),
    };

    const response = new Response(JSON.stringify(body, null, 2), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
            'Access-Control-Allow-Origin': '*',
        },
    });
    recordDatasets(request, locals, response.status);
    return response;
}
