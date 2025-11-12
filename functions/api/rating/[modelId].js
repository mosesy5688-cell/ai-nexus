// /functions/api/rating/[modelId].js

const RATING_KEY_PREFIX = 'rating:';
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const RATE_LIMIT_KEY_PREFIX = 'rate_limit:';
const RATE_LIMIT_SECONDS = 5; // 5 seconds between submissions

/**
 * Main request handler for Cloudflare Pages Functions.
 * @param {EventContext} context - The context object provided by Cloudflare.
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  // The modelId is URL-encoded by the client, so we must decode it here.
  const modelId = decodeURIComponent(params.modelId);

  console.log(`[API Function] Invoked for path: ${request.url}, method: ${request.method}, modelId: ${modelId}`);
  try {
    if (!modelId) {
      return new Response(JSON.stringify({ error: "Model ID is required." }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    switch (request.method) {
      case 'GET':
        // GET now calls handler which ensures CORS headers are present
        return handleGetRequest(env.RATINGS_KV, modelId);
      case 'POST':
        // POST now calls handler which ensures CORS headers are present
        return handlePostRequest(context, modelId);
      case 'OPTIONS':
        return new Response(null, { status: 204, headers: CORS_HEADERS }); // Explicit CORS for preflight
      default:
        return new Response('Method Not Allowed', { status: 405, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
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

  if (list.keys.length === 0) {
    return new Response(JSON.stringify({ average_rating: 0, total_ratings: 0, comments: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  const ratingPromises = list.keys.map(key => kv.get(key.name, 'json'));
  const ratingsData = await Promise.all(ratingPromises);

  let totalRatingSum = 0;
  const comments = [];

  for (const data of ratingsData) {
    if (data && typeof data.rating === 'number' && data.rating >= 1 && data.rating <= 5) {
      totalRatingSum += data.rating;
      comments.push({
        rating: data.rating,
        comment: data.comment,
        timestamp: data.timestamp,
      });
    }
  }

  const total_ratings = comments.length;
  const average_rating = total_ratings > 0 ? parseFloat((totalRatingSum / total_ratings).toFixed(2)) : 0;

  comments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  return new Response(JSON.stringify({ average_rating, total_ratings, comments }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

/**
 * Handles POST requests to submit a new rating and comment.
 * @param {EventContext} context - The context object from Cloudflare.
 * @param {string} modelId - The ID of the model.
 */
async function handlePostRequest(context, modelId) {
  const { request, env } = context;
  const kv = env.RATINGS_KV;
  console.log(`Handling POST for modelId: ${modelId}`);

  const userIp = request.headers.get('cf-connecting-ip') || 'unknown_ip';
  const rateLimitKey = `${RATE_LIMIT_KEY_PREFIX}${userIp}`;

  const lastSubmission = await kv.get(rateLimitKey);
  if (lastSubmission) {
    console.log(`Rate limit hit for IP: ${userIp}`);
    return new Response(JSON.stringify({ error: `Rate limit exceeded. Please wait ${RATE_LIMIT_SECONDS} seconds.` }), { status: 429, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  let payload;
  try {
    // Crucial Check: Ensure the content type is correct before trying to parse JSON.
    if (request.headers.get('Content-Type') !== 'application/json') {
      console.error('Invalid Content-Type header.');
      return new Response(JSON.stringify({ error: "Invalid request: Content-Type must be application/json." }), { status: 415, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }
    console.log('Attempting to parse JSON body...');
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON payload." }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const { rating, comment } = payload;

  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    console.error(`Invalid rating value: ${rating}`);
    return new Response(JSON.stringify({ error: "Rating must be a number between 1 and 5." }), { status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  const sanitizedComment = (comment || '').trim().substring(0, 1000);
  const uniqueId = crypto.randomUUID();
  const newRatingKey = `${RATING_KEY_PREFIX}${modelId}:${uniqueId}`;

  const dataToStore = {
    rating,
    comment: sanitizedComment,
    timestamp: new Date().toISOString(), // Always generate timestamp on the server
  };

  console.log('Writing data to KV:', newRatingKey);
  await kv.put(newRatingKey, JSON.stringify(dataToStore));
  await kv.put(rateLimitKey, '1', { expirationTtl: RATE_LIMIT_SECONDS });
  console.log('Successfully submitted rating.');

  return new Response(JSON.stringify({ success: true, message: "Rating submitted successfully." }), {
    status: 201,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}