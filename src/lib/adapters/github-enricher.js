/**
 * GitHub Data Enrichment Adapter
 * 
 * Fetches repository statistics from GitHub API for models with GitHub source URLs.
 * Implements rate limiting, exponential backoff, and error handling.
 * 
 * @module adapters/github-enricher
 */

import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Configuration
const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

// Headers for GitHub API
const getHeaders = () => ({
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'AI-Nexus-Enricher',
    ...(GITHUB_TOKEN && { 'Authorization': `token ${GITHUB_TOKEN}` })
});

/**
 * Extract owner and repo from GitHub URL
 * @param {string} url - GitHub repository URL
 * @returns {{owner: string, repo: string} | null}
 */
export function extractOwnerRepo(url) {
    if (!url || typeof url !== 'string') return null;

    // Match patterns:
    // https://github.com/owner/repo
    // https://github.com/owner/repo.git
    // github.com/owner/repo
    const match = url.match(/github\.com\/([^\/]+)\/([^\/\s]+?)(?:\.git)?(?:\/|$)/i);

    if (!match) return null;

    return {
        owner: match[1],
        repo: match[2]
    };
}

/**
 * Sleep function for backoff delays
 * @param {number} ms - Milliseconds to sleep
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch GitHub repository data with retry logic
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<Object|null>} Repository data or null on failure
 */
export async function fetchGitHubRepoData(owner, repo) {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}`;
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const response = await axios.get(url, {
                headers: getHeaders(),
                timeout: 10000 // 10 second timeout
            });

            return response.data;

        } catch (error) {
            lastError = error;

            // Handle rate limiting
            if (error.response?.status === 403 && error.response?.headers['x-ratelimit-remaining'] === '0') {
                const resetTime = parseInt(error.response.headers['x-ratelimit-reset']) * 1000;
                const waitTime = Math.max(resetTime - Date.now(), 0) + 1000; // Add 1 second buffer
                console.warn(`⏳ GitHub rate limit exceeded. Waiting ${Math.round(waitTime / 1000)}s...`);
                await sleep(waitTime);
                continue;
            }

            // Handle 404 (repository not found or deleted)
            if (error.response?.status === 404) {
                console.warn(`⚠️  Repository not found: ${owner}/${repo}`);
                return null;
            }

            // Exponential backoff for other errors
            if (attempt < MAX_RETRIES - 1) {
                const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
                console.warn(`⚠️  Request failed (attempt ${attempt + 1}/${MAX_RETRIES}). Retrying in ${backoff}ms...`);
                await sleep(backoff);
            }
        }
    }

    console.error(`❌ Failed to fetch ${owner}/${repo} after ${MAX_RETRIES} attempts:`, lastError?.message);
    return null;
}

/**
 * Fetch contributor count for a repository
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @returns {Promise<number>} Number of contributors
 */
export async function fetchContributorCount(owner, repo) {
    try {
        const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contributors`;
        const response = await axios.get(url, {
            headers: getHeaders(),
            params: { per_page: 1, anon: 'true' }, // Just get the count from headers
            timeout: 10000
        });

        // GitHub includes total count in Link header for pagination
        const linkHeader = response.headers['link'];
        if (linkHeader) {
            const match = linkHeader.match(/page=(\d+)>; rel="last"/);
            if (match) {
                return parseInt(match[1]);
            }
        }

        // Fallback: return array length
        return response.data.length;

    } catch (error) {
        console.warn(`⚠️  Could not fetch contributor count for ${owner}/${repo}`);
        return 0;
    }
}

/**
 * Transform GitHub API response to our schema
 * @param {Object} repoData - GitHub API response data
 * @returns {Object} Transformed data matching our DB schema
 */
export function transformGitHubData(repoData) {
    if (!repoData) return null;

    return {
        github_stars: repoData.stargazers_count || 0,
        github_forks: repoData.forks_count || 0,
        github_last_commit: repoData.pushed_at || null,
        // Note: contributor count requires separate API call
    };
}

/**
 * Enrich a single model with GitHub data
 * @param {Object} model - Model object with source_url
 * @returns {Promise<Object|null>} Enriched GitHub data or null
 */
export async function enrichModelWithGitHub(model) {
    if (!model.source_url) {
        return null;
    }

    const ownerRepo = extractOwnerRepo(model.source_url);
    if (!ownerRepo) {
        return null;
    }

    const { owner, repo } = ownerRepo;
    console.log(`📊 Enriching ${model.id} with GitHub data for ${owner}/${repo}...`);

    // Fetch main repo data
    const repoData = await fetchGitHubRepoData(owner, repo);
    if (!repoData) {
        return null;
    }

    // Transform to our schema
    const githubData = transformGitHubData(repoData);

    // Optionally fetch contributor count (expensive, enable if needed)
    // githubData.github_contributors = await fetchContributorCount(owner, repo);

    return githubData;
}

/**
 * Check GitHub API rate limit status
 * @returns {Promise<Object>} Rate limit information
 */
export async function checkRateLimit() {
    try {
        const response = await axios.get(`${GITHUB_API_BASE}/rate_limit`, {
            headers: getHeaders()
        });

        return {
            limit: response.data.rate.limit,
            remaining: response.data.rate.remaining,
            reset: new Date(response.data.rate.reset * 1000)
        };
    } catch (error) {
        console.error('Failed to check rate limit:', error.message);
        return null;
    }
}
