// /functions/api/rating/[modelId].js

const RATING_KEY_PREFIX = 'rating:';
const RATE_LIMIT_KEY_PREFIX = 'rate_limit:';
const RATE_LIMIT_SECONDS = 60; // Allow one submission per minute per IP
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Main request handler for Cloudflare Pages Functions.
 * @param {EventContext} context - The context object provided by Cloudflare.
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  // The modelId is URL-encoded by the client, so we must decode it here.
  const modelId = decodeURIComponent(params.modelId);

  try {
    if (!modelId) {
      return Response.json({ error: "Model ID is required." }, { status: 400, headers: CORS_HEADERS });
    }

    switch (request.method) {
      case 'GET':
        return handleGetRequest(env.RATINGS_KV, modelId);
      case 'POST':
        return handlePostRequest(context, modelId);
      case 'OPTIONS':
        return new Response(null, { status: 204, headers: CORS_HEADERS }); // Explicit CORS for preflight
      default:
        const headers = { ...CORS_HEADERS, 'Allow': 'GET, POST, OPTIONS' };
        return Response.json({ error: 'Method Not Allowed' }, { status: 405, headers });
    }
  } catch (e) {
    console.error("Function execution error:", e);
    return new Response(JSON.stringify({ error: "Internal Server Error", details: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
}

/**
 * Handles GET requests to fetch ratings and comments for a specific model.
 * @param {KVNamespace} kv - The KV namespace.
 * @param {string} modelId - The ID of the model.
 */
async function handleGetRequest(kv, modelId) {
  const list = await kv.list({ prefix: `${RATING_KEY_PREFIX}${modelId}:` });

  // CRITICAL FIX: If `list` is null or `list.keys` is empty, no ratings exist. Return a valid empty response immediately.
  // This prevents TypeErrors if `list` is unexpectedly null or doesn't have a `keys` property.
  if (!list || list.keys.length === 0) {
    return Response.json({ average_rating: 0, total_ratings: 0, comments: [] }, { status: 200, headers: CORS_HEADERS });
  }

  const ratingPromises = list.keys.map(key => kv.get(key.name, 'json'));
  // CRITICAL FIX: Use Promise.allSettled to prevent a single corrupted KV entry from failing the entire request.
  const results = await Promise.allSettled(ratingPromises);
  
  // Filter out rejected promises and extract the values from fulfilled ones.
  const ratingsData = results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value);

  let totalRatingSum = 0;
  const comments = [];

  for (const data of ratingsData) {
    try {
      if (data && typeof data.rating === 'number' && data.rating >= 1 && data.rating <= 5) {
        totalRatingSum += data.rating;
        comments.push({
          rating: data.rating,
          comment: data.comment,
          timestamp: data.timestamp,
        });
      }
    } catch (e) {
      // Log if a specific entry is corrupted, but don't fail the whole request.
      console.error(`Skipping corrupted rating entry: ${e.message}`);
    }
  }

  const total_ratings = comments.length;
  const average_rating = total_ratings > 0 ? parseFloat((totalRatingSum / total_ratings).toFixed(2)) : 0;

  comments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  
  return Response.json({ average_rating, total_ratings, comments }, { status: 200, headers: CORS_HEADERS });
}

/**
 * Handles POST requests to submit a new rating and comment.
 * @param {EventContext} context - The context object from Cloudflare.
 * @param {string} modelId - The ID of the model.
 */
async function handlePostRequest(context, modelId) {
  const { request, env } = context;
  const kv = env.RATINGS_KV;

  const userIp = request.headers.get('cf-connecting-ip') || 'unknown_ip';
  const rateLimitKey = `${RATE_LIMIT_KEY_PREFIX}${userIp}`;

  const lastSubmission = await kv.get(rateLimitKey);
  if (lastSubmission) {
    return Response.json({ error: `Rate limit exceeded. Please wait a moment before submitting again.` }, { status: 429, headers: CORS_HEADERS });
  }

  let payload;
  try {
    // Crucial Check: Ensure the content type is correct before trying to parse JSON.
    if (request.headers.get('Content-Type') !== 'application/json') {
      return Response.json({ error: "Invalid request: Content-Type must be application/json." }, { status: 415, headers: CORS_HEADERS });
    }
    payload = await request.json();
  } catch (e) {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400, headers: CORS_HEADERS });
  }

  const { rating, comment } = payload;

  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return Response.json({ error: "Rating must be a number between 1 and 5." }, { status: 400, headers: CORS_HEADERS });
  }

  const sanitizedComment = (comment || '').trim().substring(0, 1000);
  const uniqueId = crypto.randomUUID();
  const newRatingKey = `${RATING_KEY_PREFIX}${modelId}:${uniqueId}`;
  const timestamp = new Date().toISOString();

  const newRatingData = {
    rating,
    comment: sanitizedComment,
    timestamp, // Always generate timestamp on the server
  };

  await kv.put(newRatingKey, JSON.stringify(newRatingData));

  // Set rate limit TTL
  await kv.put(rateLimitKey, '1', { expirationTtl: RATE_LIMIT_SECONDS });

  // Return the newly created rating data along with a success message.
  // This allows the client to optimistically update the UI without a full re-fetch.
  return Response.json({ success: true, message: "Rating submitted successfully.", newRating: newRatingData }, { status: 201, headers: CORS_HEADERS });
}