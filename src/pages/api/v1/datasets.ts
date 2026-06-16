/**
 * V∞ Phase 4 — Parquet Datasets API
 * Serves dataset file listings and proxies downloads from R2.
 * GET /api/v1/datasets         → JSON manifest of available parquet files
 * GET /api/v1/datasets?file=X  → Redirect to CDN download URL
 */
export const prerender = false;

const CDN_BASE = 'https://cdn.free2aitools.com';

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
        return Response.redirect(`${CDN_BASE}/${entry.path}`, 302);
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
