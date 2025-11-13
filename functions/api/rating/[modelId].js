// /functions/api/rating/[modelId].js

/**
 * Main request handler for Cloudflare Pages Functions.
 * This feature is deprecated. This function now only returns a 200 OK response
 * to prevent 500 errors from any clients that might still be calling it.
 * @param {EventContext} context - The context object provided by Cloudflare.
 */
export async function onRequest(context) {
  return new Response(JSON.stringify({ status: 'deprecated', message: 'This feature has been removed.' }), {
    status: 200,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // Keep CORS header for any old clients
    },
  });
}