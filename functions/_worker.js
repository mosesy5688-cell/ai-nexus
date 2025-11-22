// Advanced Mode Worker for Cloudflare Pages
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Handle /model/* routes
        if (url.pathname.startsWith('/model/')) {
            const pathParts = url.pathname.split('/').filter(p => p);
            const slug = pathParts[pathParts.length - 1];

            if (!slug || slug === 'model') {
                return new Response('Model not specified', { status: 400 });
            }

            // Convert slug to model ID
            const modelId = slug.replace(/--/g, '/');

            // Fetch model data
            const db = env.DB;
            if (!db) {
                return new Response('Database not available', { status: 500 });
            }

            try {
                const model = await db.prepare("SELECT * FROM models WHERE id = ?").bind(modelId).first();

                if (!model) {
                    // Return 404 page
                    return env.ASSETS.fetch(new URL('/404', url.origin));
                }

                // Return HTML page
                const html = generateModelPage(model);

                return new Response(html, {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/html; charset=utf-8',
                    },
                });
            } catch (e) {
                console.error('Model page error:', e);
                return new Response(`Error: ${e.message}`, { status: 500 });
            }
        }

        // For all other routes, use the static assets
        return env.ASSETS.fetch(request);
    }
};

function generateModelPage(model) {
    const formatNumber = (num) => num != null ? num.toLocaleString() : 0;
    const lastUpdated = model.last_updated ? new Date(model.last_updated).toLocaleDateString() : 'N/A';
    const escapeHtml = (str) => (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
    const description = escapeHtml(model.description);
    const descriptionPreview = description.substring(0, 160);

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(model.name)} - AI Model Details</title>
    <meta name="description" content="${escapeHtml(descriptionPreview)}">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <script src="https://cdn.tailwindcss.com"></script>
    <script>
        tailwind.config = {
            darkMode: 'class',
        }
    </script>
</head>
<body class="bg-gray-50 text-gray-800 font-sans antialiased">
    <header class="bg-white dark:bg-gray-900 shadow-sm sticky top-0 z-50">
        <nav class="container mx-auto px-4 py-4">
            <div class="flex items-center justify-between">
                <a href="/" class="text-2xl font-bold text-blue-600 dark:text-blue-400">AI Nexus</a>
                <div class="flex items-center gap-4">
                    <a href="/explore" class="text-gray-600 dark:text-gray-300 hover:text-blue-600">Explore</a>
                    <a href="/" class="text-gray-600 dark:text-gray-300 hover:text-blue-600">Home</a>
                </div>
            </div>
        </nav>
    </header>
    
    <main class="container mx-auto px-4 py-12">
        <div class="max-w-4xl mx-auto">
            <header class="mb-8">
                <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                    <div class="flex-grow">
                        <h1 class="text-4xl md:text-5xl font-extrabold text-gray-900 dark:text-white mb-2 break-words">${escapeHtml(model.name)}</h1>
                        <p class="text-lg text-gray-500 dark:text-gray-400">by ${escapeHtml(model.author)}</p>
                    </div>
                    <a href="https://huggingface.co/${escapeHtml(model.id)}" target="_blank" rel="noopener noreferrer" class="flex-shrink-0 inline-flex items-center justify-center px-6 py-3 text-base font-medium text-white bg-blue-600 border border-transparent rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-transform hover:scale-105">
                        View on Hugging Face
                    </a>
                </div>
            </header>

            <div class="mb-8 p-4 bg-gray-100 dark:bg-gray-800 rounded-lg">
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
                    <div>
                        <p class="text-sm text-gray-500 dark:text-gray-400">Likes</p>
                        <p class="text-xl font-bold">${formatNumber(model.likes)}</p>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500 dark:text-gray-400">Downloads</p>
                        <p class="text-xl font-bold">${formatNumber(model.downloads)}</p>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500 dark:text-gray-400">Task</p>
                        <p class="text-xl font-bold capitalize">${escapeHtml(model.pipeline_tag) || 'N/A'}</p>
                    </div>
                    <div>
                        <p class="text-sm text-gray-500 dark:text-gray-400">Last Updated</p>
                        <p class="text-xl font-bold">${lastUpdated}</p>
                    </div>
                </div>
            </div>

            <article class="py-8 border-t border-gray-200 dark:border-gray-700">
                <h2 class="text-2xl font-bold mb-4">Model Description</h2>
                <div class="prose prose-lg dark:prose-invert max-w-none">
                    <p class="text-gray-700 dark:text-gray-300 whitespace-pre-wrap">${description || 'No description available.'}</p>
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
