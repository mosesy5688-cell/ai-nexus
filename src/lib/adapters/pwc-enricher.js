/**
 * Papers With Code API Adapter
 * Handles fetching benchmarks and SOTA data from paperswithcode.com
 */
import { fetch } from 'undici';

export class PwcEnricher {
    constructor(config = {}) {
        this.baseUrl = config.baseUrl || 'https://paperswithcode.com/api/v1';
        this.retryDelay = config.retryDelay || 2000;
        this.maxRetries = config.maxRetries || 3;
    }

    /**
     * Search for a paper/model on PWC
     * @param {string} query
     * @returns {Promise<Object|null>}
     */
    async searchPaper(query) {
        if (!query) return null;

        try {
            const url = `${this.baseUrl}/papers/?q=${encodeURIComponent(query)}`;
            const data = await this._fetchWithRetry(url);

            if (data.count > 0 && data.results.length > 0) {
                // Return the first match
                return data.results[0];
            }
            return null;
        } catch (error) {
            console.error(`Error searching PWC for "${query}":`, error.message);
            return null;
        }
    }

    /**
     * Get repository data linked to a paper
     * @param {string} paperId 
     * @returns {Promise<Object>}
     */
    async getRepository(paperId) {
        try {
            // PWC links papers to repositories. We want to find the repository that matches our model.
            // For simplicity in this v1, we'll try to get the "official" repository if available
            // or just use the paper's primary repository.

            // Endpoint: /papers/{id}/repositories/
            const url = `${this.baseUrl}/papers/${paperId}/repositories/`;
            const data = await this._fetchWithRetry(url);

            if (data.count > 0) {
                // Return official matching repo or first result
                return data.results.find(r => r.is_official) || data.results[0];
            }
            return null;
        } catch (error) {
            console.error(`Error fetching PWC repository for paper ${paperId}:`, error.message);
            return null;
        }
    }

    /**
     * Get evaluation tables (benchmarks) for a paper
     * @param {string} paperId
     * @returns {Promise<Array>}
     */
    async getEvaluations(paperId) {
        try {
            // Endpoint: /papers/{id}/evaluations/
            // This returns the evaluation tables (benchmarks) linked to this paper
            const url = `${this.baseUrl}/papers/${paperId}/evaluations/`;
            const data = await this._fetchWithRetry(url);

            if (data.count > 0) {
                return data.results;
            }
            return [];
        } catch (error) {
            console.error(`Error fetching PWC evaluations for paper ${paperId}:`, error.message);
            return [];
        }
    }

    /**
     * Internal fetch helper with retry logic
     */
    async _fetchWithRetry(url, attempt = 1) {
        try {
            const response = await fetch(url);

            if (!response.ok) {
                if (response.status === 429 && attempt <= this.maxRetries) {
                    console.warn(`Rate limit hit provided by PWC. Retrying in ${this.retryDelay}ms...`);
                    await new Promise(r => setTimeout(r, this.retryDelay * attempt));
                    return this._fetchWithRetry(url, attempt + 1);
                }
                throw new Error(`PWC API returned ${response.status}: ${response.statusText}`);
            }

            return await response.json();
        } catch (error) {
            if (attempt <= this.maxRetries) {
                await new Promise(r => setTimeout(r, this.retryDelay));
                return this._fetchWithRetry(url, attempt + 1);
            }
            throw error;
        }
    }

    /**
     * Enriches model data using PWC API
     * @param {Object} model - The model object from our DB
     * @returns {Promise<Object|null>} - Enrichment data or null if not found
     */
    async enrich(model) {
        // Strategy:
        // 1. If model has arxiv_id, use that to find paper on PWC
        // 2. If no arxiv_id, search by model name (less reliable)

        let paper = null;

        // Try searching by ArXiv ID first (most accurate)
        if (model.arxiv_id) {
            try {
                // PWC often indexes by arxiv ID in the search
                // Alternatively, can we get by arxiv ID directly? 
                // The /papers/ endpoint supports ?arxiv_id=...
                // But let's check docs. Actually PWC API docs say /papers/?arxiv_id=X works.
                const url = `${this.baseUrl}/papers/?arxiv_id=${model.arxiv_id}`;
                const data = await this._fetchWithRetry(url);
                if (data.count > 0) paper = data.results[0];
            } catch (e) {
                console.warn(`Failed PWC lookup by ArXiv ID ${model.arxiv_id}`);
            }
        }

        // Fallback: Search by name if verified ArXiv lookup failed
        if (!paper && model.name) {
            paper = await this.searchPaper(model.name);
        }

        if (!paper) return null;

        // Now fetch evaluations (benchmarks)
        const evaluations = await this.getEvaluations(paper.id);

        // Process evaluations to extract meaningful stats
        // We want:
        // - List of benchmarks (Task + Dataset + Metric + Value)
        // - Total SOTA count (hard to determine from just evaluations, but we can count # of evaluations as a proxy for participation)

        const benchmarks = evaluations.map(evalItem => ({
            task: evalItem.task,
            dataset: evalItem.dataset,
            metric: evalItem.metric,
            value: evalItem.value,
            global_rank: evalItem.global_rank // Include rank if available
        }));

        const tasks = [...new Set(evaluations.map(e => e.task))];
        const datasets = [...new Set(evaluations.map(e => e.dataset))];

        // Count SOTA: evaluations where global_rank is 1
        const sotaCount = evaluations.filter(e => e.global_rank === 1).length;

        return {
            pwc_benchmarks: benchmarks,
            pwc_tasks: tasks,
            pwc_datasets: datasets,
            pwc_sota_count: sotaCount
        };
    }
}
