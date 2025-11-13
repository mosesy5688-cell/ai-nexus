// /functions/api/rating/[modelId].js

// Since the user rating feature is being deprecated, this function is simplified
// to prevent 500 errors on the frontend while the component is being removed.
// It now always returns a safe, empty response.

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Main request handler for Cloudflare Pages Functions.
 * This function now only handles GET requests by returning a default empty state.
 * POST requests are no longer handled.
 * @param {EventContext} context - The context object provided by Cloudflare.
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  
  if (request.method === 'GET') {
    // Always return a default empty structure to avoid frontend errors.
    return Response.json({ average_rating: 0, total_ratings: 0, comments: [] }, { status: 200, headers: CORS_HEADERS });
  }

  // For any other method, return Method Not Allowed.
  const headers = { ...CORS_HEADERS, 'Allow': 'GET, OPTIONS' };
  return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers });
}