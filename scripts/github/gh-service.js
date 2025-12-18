/**
 * GitHub Enrichment Service
 */
import {
    extractOwnerRepo,
    enrichModelWithGitHub,
    checkRateLimit
} from '../../src/lib/adapters/github-enricher.js';
import { metrics, sleep } from './gh-config.js';

/**
 * Validate GitHub data
 */
function validateGitHubData(data) {
    if (!data) return false;

    // Fix negative values
    if (data.github_stars < 0) data.github_stars = 0;
    if (data.github_forks < 0) data.github_forks = 0;
    if (data.github_contributors < 0) data.github_contributors = 0;

    // Fix invalid dates
    if (!data.github_last_commit || data.github_last_commit === 'Invalid Date') {
        data.github_last_commit = null;
    }

    return true;
}

/**
 * Enrich single model with fallback strategies
 */
export async function enrichWithFallback(model) {
    try {
        const ownerRepo = extractOwnerRepo(model.source_url);
        if (!ownerRepo) {
            return { skip: true, reason: 'invalid_url' };
        }

        const githubData = await enrichModelWithGitHub(model);

        if (!githubData) {
            return { skip: true, reason: 'no_data' };
        }

        // Validate data
        if (!validateGitHubData(githubData)) {
            return { skip: true, reason: 'invalid_data' };
        }

        metrics.apiCallsUsed++;
        return githubData;

    } catch (error) {
        if (error.status === 404) {
            return { skip: true, reason: 'repo_not_found' };
        } else if (error.status === 403) {
            // Rate limit exceeded
            console.warn('⚠️  Rate limit hit, waiting 60s...');
            await sleep(60000);
            return await enrichWithFallback(model); // Retry once
        } else {
            metrics.errors.push({
                modelId: model.id,
                error: error.message
            });
            return { skip: true, reason: 'error', error: error.message };
        }
    }
}

export { checkRateLimit };
