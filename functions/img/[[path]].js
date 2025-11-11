// /functions/img/[[path]].js

// Define a whitelist of allowed domains to prevent open-proxy abuse
const ALLOWED_DOMAINS = [
  'huggingface.co',
  'civitai.com',
  // Add other trusted image source domains here
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  const imageUrl = url.searchParams.get('url');
  if (!imageUrl) {
    return new Response('Error: Missing "url" query parameter.', { status: 400 });
  }

  try {
    const originUrl = new URL(imageUrl);
    // Security: Check if the requested domain is in our whitelist
    if (!ALLOWED_DOMAINS.some(domain => originUrl.hostname.endsWith(domain))) {
      return new Response('Error: Requested domain is not allowed.', { status: 403 });
    }

    // Dynamically get transformation options from query params, with sensible defaults
    const width = url.searchParams.get('width') || 800;
    const quality = url.searchParams.get('quality') || 80;
    const format = url.searchParams.get('format') || 'auto'; // 'auto' will serve WebP/AVIF when possible

    // Core: Use cf property to enable Cloudflare's edge optimization
    const imageRequest = new Request(imageUrl, {
      headers: request.headers,
      cf: {
        // Enable Cloudflare Image Resizing/Optimization
        image: {
          width: parseInt(width, 10),
          quality: parseInt(quality, 10),
          format,
        },
        // Set edge caching policy (TTL: Time To Live)
        cacheTtl: 60 * 60 * 24 * 7, // Cache for one week
        cacheEverything: true,
      },
    });

    // Forward the request to the original image URL for optimization at the edge
    const response = await fetch(imageRequest);

    // Return the optimized image
    return response;

  } catch (error) {
    console.error("Image proxy failed:", error.message);
    return new Response('Error processing image.', { status: 500 });
  }
}