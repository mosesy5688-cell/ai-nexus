import axios from 'axios';

export async function collect() {
    console.log("[GitHub] Starting collection...");

    const token = process.env.GITHUB_TOKEN;
    const headers = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'AI-Nexus-Collector'
    };

    if (token) {
        console.log("[GitHub] Using GITHUB_TOKEN for authentication");
        headers['Authorization'] = `token ${token}`;
    } else {
        console.warn("[GitHub] No GITHUB_TOKEN found. Rate limits will be lower.");
    }

    // Search query: broad AI topic
    const query = 'topic:machine-learning-model';
    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=50`;

    try {
        const response = await axios.get(url, { headers });
        const repos = response.data.items || [];

        console.log(`[GitHub] Found ${repos.length} repositories`);

        const models = repos.map(repo => {
            return {
                id: `github/${repo.full_name}`,
                name: repo.name,
                author: repo.owner.login,
                description: repo.description || "No description provided",
                likes: repo.stargazers_count,
                downloads: 0, // Not available via API
                tags: ['github', ...(repo.topics || [])],
                pipeline_tag: 'other', // Default
                source: 'github',
                source_url: repo.html_url
            };
        });

        console.log(`[GitHub] Collected ${models.length} models.`);
        return models;

    } catch (e) {
        console.error('[GitHub] Error collecting data:', e.message);
        if (e.response) {
            console.error('[GitHub] Response status:', e.response.status);
            console.error('[GitHub] Response data:', e.response.data);
        }
        return [];
    }
}
