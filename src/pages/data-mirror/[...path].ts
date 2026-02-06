/**
 * V16.5 CORS Bypass Proxy for Local Development
 * Proxies requests from localhost to cdn.free2aitools.com
 */
export async function GET({ params }) {
    const { path } = params;
    const targetUrl = `https://cdn.free2aitools.com/cache/${path}`;

    console.log(`[Proxy] GET ${targetUrl}`);

    try {
        const response = await fetch(targetUrl);

        if (!response.ok) {
            return new Response(`CDN Error: ${response.status}`, { status: response.status });
        }

        const data = await response.json();

        return new Response(JSON.stringify(data), {
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            }
        });
    } catch (error) {
        return new Response(`Proxy Error: ${error.message}`, { status: 500 });
    }
}
