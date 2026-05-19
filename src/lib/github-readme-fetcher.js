/**
 * Standalone GitHub README fetcher with REST primary + GraphQL fallback.
 *
 * V27.23 root-cause fix for harvest 502s. The previous design inlined
 * `readme: object(expression: "HEAD:README.md") { ... on Blob { text } }`
 * inside the search() query, fetching 50 nodes × 2 README blobs (README.md
 * and readme.md). When GitHub's GraphQL backend was degraded, the combined
 * query exceeded the documented 10s hard cap and returned 502.
 *
 * Splitting README into per-repo REST calls keeps the search query small
 * (well under 3s) while still capturing README content. Each README fetch
 * has its own retry budget and can degrade independently — a single repo
 * failing to return its README no longer drops all 24 siblings in the page.
 *
 * Failure modes:
 *  - status='ok'        — content populated (text or empty string)
 *  - status='not-found' — repo has no README (404 from REST)
 *  - status='fail'      — both REST and GQL exhausted retries
 */

import { githubFetch } from './github-fetch-retry.js';
import { checkCache, updateCache } from './github-readme-cache.js';

const GH_API_BASE = 'https://api.github.com';

function buildHeaders(token, accept) {
    const headers = {
        'Accept': accept,
        'User-Agent': 'Free2AITools-Ingestion/3.2'
    };
    if (token) headers['Authorization'] = `token ${token}`;
    return headers;
}

async function fetchReadmeRest(owner, name, token, logPrefix) {
    const url = `${GH_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/readme`;
    const result = await githubFetch(url, {
        method: 'GET',
        headers: buildHeaders(token, 'application/vnd.github.raw'),
        maxRetries: 4,
        baseBackoffMs: 5_000,
        capBackoffMs: 60_000,
        timeoutMs: 10_000,
        logPrefix
    });

    if (result.ok) {
        try {
            const text = await result.response.text();
            return { content: text, source: 'rest', status: 'ok' };
        } catch {
            return { content: null, source: null, status: 'fail' };
        }
    }
    if (result.status === 404) {
        return { content: null, source: null, status: 'not-found' };
    }
    return { content: null, source: null, status: 'fail' };
}

async function fetchReadmeGql(owner, name, token, logPrefix) {
    const url = `${GH_API_BASE}/graphql`;
    const query = `
        query($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
                upper: object(expression: "HEAD:README.md") { ... on Blob { text } }
                lower: object(expression: "HEAD:readme.md") { ... on Blob { text } }
            }
        }
    `;
    const headers = {
        ...buildHeaders(token, 'application/json'),
        'Content-Type': 'application/json'
    };
    const result = await githubFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables: { owner, name } }),
        maxRetries: 3,
        baseBackoffMs: 5_000,
        capBackoffMs: 60_000,
        timeoutMs: 10_000,
        logPrefix
    });

    if (!result.ok) {
        return { content: null, source: null, status: 'fail' };
    }
    try {
        const data = await result.response.json();
        const repo = data.data?.repository;
        if (!repo) return { content: null, source: null, status: 'not-found' };
        const text = repo.upper?.text || repo.lower?.text;
        if (text) return { content: text, source: 'gql', status: 'ok' };
        return { content: null, source: null, status: 'not-found' };
    } catch {
        return { content: null, source: null, status: 'fail' };
    }
}

/**
 * Fetch one README: REST primary, GraphQL fallback on REST fail.
 */
export async function fetchReadme({ owner, name, token, logPrefix = '      ' }) {
    if (!owner || !name) return { content: null, source: null, status: 'fail' };
    const rest = await fetchReadmeRest(owner, name, token, logPrefix);
    if (rest.status === 'ok' || rest.status === 'not-found') return rest;
    return await fetchReadmeGql(owner, name, token, logPrefix);
}

/**
 * Bounded-concurrency batch README fetch with optional pushedAt-keyed cache.
 * Mutates each repo: sets repo.readme = string (empty string if missing/failed).
 * Returns stats: { ok, notFound, failed, cached }.
 *
 * When `cache` is supplied (Map from loadReadmeCache), repos whose pushedAt
 * matches the cached entry skip GitHub entirely. Successful fetches and
 * confirmed not-found results update the cache so the next run sees the hit.
 * Failed fetches are NOT cached — they should retry next run.
 */
export async function fetchReadmesBatch(repos, { token, concurrency = 5, cache = null } = {}) {
    const stats = { ok: 0, notFound: 0, failed: 0, cached: 0 };
    const queue = repos.slice();

    async function worker() {
        while (true) {
            const repo = queue.shift();
            if (!repo) break;
            const owner = repo.owner?.login;
            const name = repo.name;
            const repoId = repo.id;
            const pushedAt = repo.pushed_at;

            const cached = checkCache(cache, repoId, pushedAt);
            if (cached !== null) {
                repo.readme = cached;
                stats.cached++;
                continue;
            }

            const result = await fetchReadme({ owner, name, token });
            if (result.status === 'ok') {
                repo.readme = result.content || '';
                stats.ok++;
                updateCache(cache, repoId, pushedAt, repo.readme);
            } else if (result.status === 'not-found') {
                repo.readme = '';
                stats.notFound++;
                updateCache(cache, repoId, pushedAt, '');
            } else {
                repo.readme = '';
                stats.failed++;
            }
        }
    }

    const workerCount = Math.max(1, Math.min(concurrency, repos.length));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return stats;
}
