/**
 * V∞ Phase 4 — Parquet Datasets API
 * Serves dataset file listings and proxies downloads from R2.
 * GET /api/v1/datasets         → JSON manifest of available parquet files
 * GET /api/v1/datasets?file=X  → Redirect to CDN download URL
 */
export const prerender = false;

import { env } from 'cloudflare:workers';
import { emit, isEnabled } from '../../../lib/telemetry/ae-adapter';
import { buildDatasetsEvent } from '../../../lib/telemetry/request-classifier';

const CDN_BASE = 'https://cdn.free2aitools.com';

// P2 Adoption Telemetry (TA2) -- DATASETS IMPL (D-53 O-2). ONLY the real
// known-file 302 branch emits (surface=datasets.302, status_class 3xx, once);
// the manifest 200 + unknown-file 404 branches emit ZERO. Isolated swallow; the
// redirect Response is returned unchanged; the binding token is never named.
function recordDatasets302(request: Request): void {
    try {
        if (!isEnabled(env)) return;
        const headers = request.headers;
        let refererHost: string | null = null;
        const ref = headers.get('referer');
        if (ref) { try { refererHost = new URL(ref).hostname; } catch { refererHost = null; } }
        let ownHost: string | null = null;
        try { ownHost = new URL(request.url).hostname; } catch { ownHost = null; }
        const event = buildDatasetsEvent({
            isRealKnownFile302: true,
            uaString: headers.get('user-agent'),
            refererHost,
            ownHost,
            now: new Date(),
        });
        if (event) emit(env, event);
    } catch {
        // Telemetry must never affect the redirect response.
    }
}

const KNOWN_FILES = [
    { id: 'fni_lite_latest', name: 'FNI Lite (Latest)', path: 'datasets/fni_lite_latest.parquet', tier: 'free', fields: ['id', 'title', 'abstract_300', 'fni_score', 'fni_version'] },
];

export async function GET({ request, locals }: { request: Request; locals: any }) {
    const url = new URL(request.url);
    const file = url.searchParams.get('file');

    if (file) {
        const entry = KNOWN_FILES.find(f => f.id === file);
        if (!entry) {
            return new Response(JSON.stringify({ error: 'Unknown file' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
        }
        const redirect = Response.redirect(`${CDN_BASE}/${entry.path}`, 302);
        recordDatasets302(request);   // O-2: count ONLY the real known-file 302
        return redirect;
    }

    const body = {
        version: 'fni_v2.0',
        description: 'Free2AI open datasets — FNI-scored AI entity rankings in Parquet format.',
        files: KNOWN_FILES.map(f => ({
            id: f.id,
            name: f.name,
            tier: f.tier,
            fields: f.fields,
            download_url: `${CDN_BASE}/${f.path}`,
            api_url: `/api/v1/datasets?file=${f.id}`,
        })),
    };

    return new Response(JSON.stringify(body, null, 2), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=3600, s-maxage=86400',
            'Access-Control-Allow-Origin': '*',
        },
    });
}
