/**
 * Cloudflare Pages Function to handle Server-Side Rendering (SSR) for model detail pages.
 * This acts as a catch-all for any routes not handled by static files.
 */
export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. Check if the request is for a model detail page.
  if (path.startsWith('/model/')) {
    try {
      // 2. Extract the model slug from the URL.
      const slug = path.substring('/model/'.length);
      if (!slug) {
        // If slug is empty (e.g., /model/), redirect to home.
        return Response.redirect(new URL('/', url).toString(), 301);
      }

      // 3. Convert the URL-friendly slug back to the original model ID.
      // e.g., 'meta-llama--Llama-3-8B' -> 'meta-llama/Llama-3-8B'
      const modelId = slug.replace(/--/g, '/');

      // 4. Query the D1 database for the model.
      // Use context.locals for Astro integration compatibility, with fallback to env for direct Pages environment.
      const db = context.locals.runtime?.env?.DB || env.DB;

      const stmt = db.prepare('SELECT * FROM models WHERE id = ?');
      const model = await stmt.bind(modelId).first();

      // 5. If model is not found, return a 404 response.
      if (!model) {
        return new Response(`Model with ID "${modelId}" not found.`, { status: 404 });
      }

      // 6. If model is found, render the HTML page dynamically.
      const pageTitle = `${model.name} - AI Model Details | Free AI Tools`;
      const pageDescription = model.description ? model.description.substring(0, 160) : `Details for the AI model ${model.name} by ${model.author}.`;

      const html = `
                <!DOCTYPE html>
                <html lang="en">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>${escapeHtml(pageTitle)}</title>
                    <meta name="description" content="${escapeHtml(pageDescription)}">
                    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
                    <meta property="og:title" content="${escapeHtml(pageTitle)}">
                    <meta property="og:description" content="${escapeHtml(pageDescription)}">
                    <meta property="og:type" content="article">
                    <meta property="og:url" content="${url.href}">
                    <meta property="og:image" content="/og-image.jpg">
                    <meta name="twitter:card" content="summary_large_image">
                    <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
                    <meta name="twitter:description" content="${escapeHtml(pageDescription)}">
                    <meta name="twitter:image" content="/og-image.jpg">
                    <link rel="canonical" href="${url.href}" />
                    <script src="https://cdn.tailwindcss.com"></script>
                    <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-2292826803755214" crossorigin="anonymous"></script>
                </head>
                <body class="bg-gray-50 text-gray-800 font-sans">
                    <div class="container mx-auto px-4 py-8">
                        <header class="mb-8">
                            <a href="/" class="text-blue-600 hover:underline">&larr; Back to Home</a>
                            <h1 class="text-4xl font-bold mt-4">${escapeHtml(model.name)}</h1>
                            <p class="text-lg text-gray-600">by ${escapeHtml(model.author)}</p>
                        </header>
                        <main>
                            <div class="bg-white p-6 rounded-lg shadow-md">
                                <h2 class="text-2xl font-semibold mb-4">Description</h2>
                                <p class="text-gray-700 whitespace-pre-wrap">${escapeHtml(model.description || 'No description available.')}</p>
                                
                                <div class="mt-6 pt-6 border-t">
                                    <h3 class="text-xl font-semibold mb-3">Details</h3>
                                    <div class="grid grid-cols-2 gap-4 text-sm">
                                        <div><strong>Likes:</strong> ${model.likes || 0}</div>
                                        <div><strong>Downloads:</strong> ${model.downloads || 0}</div>
                                        <div><strong>Task:</strong> <span class="bg-blue-100 text-blue-800 px-2 py-1 rounded-full">${escapeHtml(model.pipeline_tag || 'N/A')}</span></div>
                                        <div><strong>Last Updated:</strong> ${new Date(model.last_updated).toLocaleDateString()}</div>
                                    </div>
                                </div>

                                ${model.tags && `
                                <div class="mt-6 pt-6 border-t">
                                    <h3 class="text-xl font-semibold mb-3">Tags</h3>
                                    <div class="flex flex-wrap gap-2">
                                        ${JSON.parse(model.tags).map(tag => `<a href="/?tag=${encodeURIComponent(tag)}" class="bg-gray-200 text-gray-800 px-3 py-1 rounded-full text-sm hover:bg-gray-300">${escapeHtml(tag)}</a>`).join('')}
                                    </div>
                                </div>
                                `}
                            </div>
                        </main>
                    </div>
                </body>
                </html>
            `;

      return new Response(html, {
        status: 200,
        headers: {
          'Content-Type': 'text/html;charset=UTF-8',
          'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
        },
      });

    } catch (error) {
      console.error(`Error rendering model page: ${error}`);
      return new Response('An internal error occurred.', { status: 500 });
    }
  }

  // 7. For any other path, let the default static asset handler take over.
  return next();
}

function escapeHtml(unsafe) {
  if (typeof unsafe !== 'string') return '';
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}