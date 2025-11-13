// /functions/api/rating/[modelId].js

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Main request handler for Cloudflare Pages Functions.
 * This function is deprecated and now only returns a 200 OK response
 * to prevent 500 errors from old clients.
 * @param {EventContext} context - The context object provided by Cloudflare.
 */
export async function onRequest(context) {
  // The rating feature is deprecated. Return a simple OK response
  // to any request to this endpoint to avoid causing errors.
  return new Response(JSON.stringify({ status: 'deprecated' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}