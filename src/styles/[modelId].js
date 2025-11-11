// /functions/api/rating/[modelId].js

/**
 * Handles GET requests to fetch ratings and comments for a specific model.
 */
async function handleGetRequest(context) {
  const { modelId } = context.params;
  const kv = context.env.RATINGS_KV;

  // List all keys for the given modelId
  const list = await kv.list({ prefix: `rating:${modelId}:` });

  if (list.keys.length === 0) {
    return new Response(JSON.stringify({ average_rating: 0, total_ratings: 0, comments: [] }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let totalRating = 0;
  const comments = [];

  for (const key of list.keys) {
    const data = await kv.get(key.name, { type: 'json' });
    if (data) {
      totalRating += data.rating;
      comments.push(data);
    }
  }

  const total_ratings = comments.length;
  const average_rating = total_ratings > 0 ? (totalRating / total_ratings).toFixed(1) : 0;

  // Sort comments by timestamp, newest first
  comments.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const responseBody = {
    average_rating: parseFloat(average_rating),
    total_ratings,
    comments,
  };

  return new Response(JSON.stringify(responseBody), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handles POST requests to submit a new rating and comment.
 */
async function handlePostRequest(context) {
  const { request, params, env } = context;
  const { modelId } = params;
  const kv = env.RATINGS_KV;

  const userIp = request.headers.get('cf-connecting-ip');
  if (!userIp) {
    return new Response('Could not identify user IP.', { status: 400 });
  }

  // Rate Limiting Check
  const rateLimitKey = `rate_limit:${userIp}`;
  const lastSubmission = await kv.get(rateLimitKey);
  if (lastSubmission) {
    return new Response('Rate limit exceeded. Please wait before submitting again.', { status: 429 });
  }

  try {
    const { rating, comment } = await request.json();

    if (typeof rating !== 'number' || rating < 1 || rating > 5) {
      return new Response('Invalid rating. Must be a number between 1 and 5.', { status: 400 });
    }

    // Generate a unique ID (timestamp + random string)
    const uniqueId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const key = `rating:${modelId}:${uniqueId}`;

    const dataToStore = {
      rating,
      comment: (comment || '').substring(0, 500), // Truncate comment to 500 chars
      timestamp: new Date().toISOString(),
      userIp: 'hidden', // We don't store the full IP for privacy, just use it for rate limiting
    };

    await kv.put(key, JSON.stringify(dataToStore));
    // Set the rate limit flag with a 5-second expiration
    await kv.put(rateLimitKey, 'submitted', { expirationTtl: 5 });

    return new Response(JSON.stringify({ success: true, message: 'Rating submitted.' }), { status: 201 });
  } catch (error) {
    return new Response('Invalid JSON body.', { status: 400 });
  }
}

export function onRequest(context) {
  if (context.request.method === 'GET') {
    return handleGetRequest(context);
  } else if (context.request.method === 'POST') {
    return handlePostRequest(context);
  }

  return new Response('Method not allowed.', { status: 405 });
}