// functions/[[path]].js
export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // Only handle /model/* routes
    const parts = url.pathname.split('/').filter(Boolean);
    const slug = parts[parts.length - 1];

    if (!slug) {
        return new Response('Model not specified', { status: 400 });
    }

    // Convert slug back to DB id (author/model)
    const modelId = slug.replace(/--/g, '/');

    // Access D1 binding
    const db = env.DB;
    if (!db) {
        return new Response('Database not available', { status: 500 });
    }

    try {
        const model = await db.prepare('SELECT * FROM models WHERE id = ?')
            .bind(modelId)
            .first();

        if (!model) {
            // Return built‑in 404 page
            return env.ASSETS.fetch(new URL('/404', url.origin));
        }

        // Generate HTML page
        const html = generateModelPage(model);
        return new Response(html, {
            status: 200,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
    } catch (e) {
        console.error('Model page error:', e);
        return new Response(`Error: ${e.message}`, { status: 500 });
    }
}

function generateModelPage(model) {
    const fmt = (n) => (n != null ? n.toLocaleString() : 0);
    const last = model.last_updated ? new Date(model.last_updated).toLocaleDateString() : 'N/A';
    const esc = (s) =>
        (s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(model.name)} - AI Model Details</title>
  <meta name="description" content="${esc((model.description || '').substring(0, 160))}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config={darkMode:'class'}</script>
</head>
<body class="bg-gray-50 text-gray-800 font-sans antialiased">
  <header class="bg-white dark:bg-gray-900 shadow-sm sticky top-0 z-50">
    <nav class="container mx-auto px-4 py-4 flex justify-between items-center">
      <a href="/" class="text-2xl font-bold text-blue-600 dark:text-blue-400">AI Nexus</a>
      <a href="/explore" class="text-gray-600 dark:text-gray-300 hover:text-blue-600">Explore</a>
    </nav>
  </header>

  <main class="container mx-auto px-4 py-12">
    <div class="max-w-4xl mx-auto">
      <header class="mb-8">
        <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
          <div class="flex-grow">
            <h1 class="text-4xl md:text-5xl font-extrabold text-gray-900 dark:text-white mb-2 break-words">${esc(model.name)}</h1>
            <p class="text-lg text-gray-500 dark:text-gray-400">by ${esc(model.author)}</p>
          </div>
          <a href="https://huggingface.co/${esc(model.id)}" target="_blank"
            class="inline-flex items-center justify-center px-6 py-3 text-base font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 transition-transform hover:scale-105">
            View on Hugging Face
          </a>
        </div>
      </header>

      <div class="mb-8 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
          <div><p class="text-sm text-gray-500 dark:text-gray-400">Likes</p><p class="text-xl font-bold">${fmt(model.likes)}</p></div>
          <div><p class="text-sm text-gray-500 dark:text-gray-400">Downloads</p><p class="text-xl font-bold">${fmt(model.downloads)}</p></div>
          <div><p class="text-sm text-gray-500 dark:text-gray-400">Task</p><p class="text-xl font-bold capitalize">${esc(model.pipeline_tag) || 'N/A'}</p></div>
          <div><p class="text-sm text-gray-500 dark:text-gray-400">Last Updated</p><p class="text-xl font-bold">${last}</p></div>
        </div>
      </div>

      <article class="py-8 border-t border-gray-200 dark:border-gray-700">
        <h2 class="text-2xl font-bold mb-4">Model Description</h2>
        <div class="prose prose-lg dark:prose-invert max-w-none">
          <p class="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">${esc(model.description)}</p>
        </div>
      </article>
    </div>
  </main>

  <footer class="bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 mt-16">
    <div class="container mx-auto px-4 py-6 text-center text-gray-600 dark:text-gray-400">
      <p>&copy; 2025 AI Nexus. All rights reserved.</p>
    </div>
  </footer>
</body>
</html>`;
}