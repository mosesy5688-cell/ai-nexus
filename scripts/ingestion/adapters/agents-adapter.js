/**
 * AI Agents Adapter
 * Fetches AI agent frameworks and tools from GitHub
 * @module ingestion/adapters/agents-adapter
 */
import { BaseAdapter } from './base-adapter.js';

const GITHUB_API = 'https://api.github.com';

// Curated AI agent frameworks and tools (V12 expanded)
const CURATED_AGENTS = [
    // Frameworks
    { repo: 'langchain-ai/langchain', cat: 'framework' },
    { repo: 'microsoft/autogen', cat: 'framework' },
    { repo: 'joaomdmoura/crewAI', cat: 'framework' },
    { repo: 'Significant-Gravitas/AutoGPT', cat: 'framework' },
    { repo: 'geekan/MetaGPT', cat: 'framework' },
    { repo: 'TransformerOptimus/SuperAGI', cat: 'framework' },
    { repo: 'OpenBMB/ChatDev', cat: 'framework' },
    { repo: 'openai/swarm', cat: 'framework' },
    { repo: 'phidatahq/phidata', cat: 'framework' },
    { repo: 'assafelovic/gpt-researcher', cat: 'framework' },
    // Tools & Libraries
    { repo: 'langchain-ai/langgraph', cat: 'tool' },
    { repo: 'run-llama/llama_index', cat: 'tool' },
    { repo: 'huggingface/transformers', cat: 'tool' },
    { repo: 'vllm-project/vllm', cat: 'tool' },
    { repo: 'oobabooga/text-generation-webui', cat: 'tool' },
    { repo: 'ollama/ollama', cat: 'tool' },
    { repo: 'lm-sys/FastChat', cat: 'tool' },
    // Agents
    { repo: 'yoheinakajima/babyagi', cat: 'agent' },
    { repo: 'microsoft/TaskWeaver', cat: 'agent' },
    { repo: 'AntonOsika/gpt-engineer', cat: 'agent' },
    { repo: 'stitionai/devika', cat: 'agent' },
    { repo: 'OpenDevin/OpenDevin', cat: 'agent' },
    { repo: 'princeton-nlp/SWE-agent', cat: 'agent' },
    { repo: 'Codium-ai/pr-agent', cat: 'agent' },
    { repo: 'e2b-dev/code-interpreter', cat: 'agent' },
    // MCP & RAG
    { repo: 'modelcontextprotocol/servers', cat: 'mcp' },
    { repo: 'chroma-core/chroma', cat: 'rag' },
    { repo: 'qdrant/qdrant', cat: 'rag' },
    { repo: 'weaviate/weaviate', cat: 'rag' },
];

// V12: Multiple search queries for broader coverage
const SEARCH_QUERIES = [
    'ai agent framework topic:llm stars:>1000',
    'llm inference server stars:>500',
    'autonomous agent gpt topic:ai stars:>500',
    'rag retrieval augmented generation stars:>1000',
];

export class AgentsAdapter extends BaseAdapter {
    constructor() {
        super('github');
        this.entityTypes = ['agent'];
        this.githubToken = process.env.GITHUB_TOKEN;
    }

    async fetch(options = {}) {
        const { includeCurated = true, limit = 50 } = options;
        console.log(`📥 [Agents] Fetching AI agent data...`);
        const agents = [];
        const existing = new Set();

        if (includeCurated) {
            console.log(`🔄 [Agents] Fetching ${CURATED_AGENTS.length} curated agents...`);
            for (const { repo, cat } of CURATED_AGENTS) {
                const data = await this.fetchGitHubRepo(repo);
                if (data) { data._category = cat; agents.push(data); existing.add(repo); }
                await this.delay(100);
            }
        }

        // V12: Multi-query search for broader coverage
        if (limit > 0) {
            for (const query of SEARCH_QUERIES) {
                const perQuery = Math.ceil(limit / SEARCH_QUERIES.length);
                const results = await this.searchGitHubRepos(query, perQuery);
                results.filter(r => !existing.has(r.full_name)).forEach(r => {
                    r._category = 'discovered'; agents.push(r); existing.add(r.full_name);
                });
            }
        }

        console.log(`📦 [Agents] Total: ${agents.length}`);
        return agents;
    }

    async fetchGitHubRepo(repoPath) {
        try {
            const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ai-nexus' };
            if (this.githubToken) headers['Authorization'] = `token ${this.githubToken}`;

            const res = await fetch(`${GITHUB_API}/repos/${repoPath}`, { headers });
            if (!res.ok) return null;
            const data = await res.json();

            let readme = '';
            try {
                const readmeRes = await fetch(`${GITHUB_API}/repos/${repoPath}/readme`, { headers });
                if (readmeRes.ok) {
                    const rd = await readmeRes.json();
                    readme = Buffer.from(rd.content, 'base64').toString('utf-8');
                    if (readme.length > 50000) readme = readme.substring(0, 50000) + '\n[Truncated]';
                }
            } catch (e) { /* ignore */ }

            return { ...data, readme, _fetchedAt: new Date().toISOString() };
        } catch (e) {
            console.warn(`⚠️ Error: ${repoPath}: ${e.message}`);
            return null;
        }
    }

    async searchGitHubRepos(query, limit) {
        try {
            const headers = { 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'ai-nexus' };
            if (this.githubToken) headers['Authorization'] = `token ${this.githubToken}`;
            const res = await fetch(`${GITHUB_API}/search/repositories?q=${encodeURIComponent(query)}&sort=stars&per_page=${Math.min(limit, 100)}`, { headers });
            if (!res.ok) return [];
            return (await res.json()).items || [];
        } catch (e) { return []; }
    }

    normalize(raw) {
        const [author, name] = raw.full_name.split('/');
        const modelsUsed = this.extractModels(raw.readme || '');
        return {
            id: `github-agent--${this.sanitizeName(author)}--${this.sanitizeName(name)}`,
            type: 'agent',
            source: 'github',
            source_url: raw.html_url,
            title: raw.name,
            description: raw.description || '',
            body_content: raw.readme || '',
            tags: [...(raw.topics || []), raw.language?.toLowerCase(), raw._category].filter(Boolean),
            pipeline_tag: raw._category || 'agent',
            author,
            license_spdx: raw.license?.spdx_id || null,
            meta_json: {
                category: raw._category, language: raw.language, stars: raw.stargazers_count,
                forks: raw.forks_count, topics: raw.topics || []
            },
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            popularity: raw.stargazers_count || 0,
            downloads: 0,
            likes: raw.stargazers_count || 0,
            raw_image_url: raw.owner?.avatar_url || null,
            relations: modelsUsed.map(m => ({ target_id: m, relation_type: 'USES', confidence: 0.8, source: 'readme' })),
            content_hash: null, compliance_status: null, quality_score: null
        };
    }

    extractModels(readme) {
        const models = [];
        const patterns = [
            { p: /gpt-4|gpt4/gi, id: 'openai--gpt-4' },
            { p: /gpt-3\.5|gpt3\.5/gi, id: 'openai--gpt-3.5-turbo' },
            { p: /claude-3|claude3/gi, id: 'anthropic--claude-3' },
            { p: /llama-3|llama3/gi, id: 'meta-llama--llama-3' },
            { p: /gemini/gi, id: 'google--gemini' },
            { p: /mistral/gi, id: 'mistralai--mistral' }
        ];
        patterns.forEach(({ p, id }) => { if (p.test(readme)) models.push(id); });
        return [...new Set(models)];
    }

    delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}

export default AgentsAdapter;
