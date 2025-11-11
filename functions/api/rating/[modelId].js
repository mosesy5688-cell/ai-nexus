// /functions/api/rating/[modelId].js

const RATING_KEY_PREFIX = 'rating:';
const RATE_LIMIT_KEY_PREFIX = 'rate_limit:';
const RATE_LIMIT_SECONDS = 5; // 5 seconds between submissions

/**
 * Main request handler for Cloudflare Pages Functions.
 * @param {EventContext} context - The context object provided by Cloudflare.
 */
export async function onRequest(context) {
  const { request, env, params } = context;
  const { modelId } = params;

  if (!modelId) {
    return new Response(JSON.stringify({ error: "Model ID is required." }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  switch (request.method) {
    case 'GET':
      return handleGetRequest(env.RATINGS_KV, modelId);
    case 'POST':
      return handlePostRequest(request, env.RATINGS_KV, modelId);
    case 'OPTIONS':
      return new Response(null, { status: 204 }); // Handle CORS preflight
    default:
      return new Response('Method Not Allowed', { status: 405 });
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
      headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handles POST requests to submit a new rating and comment.
 * @param {Request} request - The incoming request object.
 * @param {KVNamespace} kv - The KV namespace.
 * @param {string} modelId - The ID of the model.
 */
async function handlePostRequest(request, kv, modelId) {
  const userIp = request.headers.get('cf-connecting-ip') || 'unknown_ip';
  const rateLimitKey = `${RATE_LIMIT_KEY_PREFIX}${userIp}`;

  const lastSubmission = await kv.get(rateLimitKey);
  if (lastSubmission) {
    return new Response(JSON.stringify({ error: `Rate limit exceeded. Please wait ${RATE_LIMIT_SECONDS} seconds.` }), { status: 429, headers: { 'Content-Type': 'application/json' } });
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON payload." }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { rating, comment } = payload;

  if (typeof rating !== 'number' || rating < 1 || rating > 5) {
    return new Response(JSON.stringify({ error: "Rating must be a number between 1 and 5." }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const sanitizedComment = (comment || '').trim().substring(0, 1000);
  const uniqueId = crypto.randomUUID();
  const newRatingKey = `${RATING_KEY_PREFIX}${modelId}:${uniqueId}`;

  const dataToStore = {
    rating,
    comment: sanitizedComment,
    timestamp: new Date().toISOString(),
  };

  await kv.put(newRatingKey, JSON.stringify(dataToStore));
  await kv.put(rateLimitKey, '1', { expirationTtl: RATE_LIMIT_SECONDS });

  return new Response(JSON.stringify({ success: true, message: "Rating submitted successfully." }), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  });
}