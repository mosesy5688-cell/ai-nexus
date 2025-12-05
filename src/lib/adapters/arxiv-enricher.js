/**
 * ArXiv API Enricher
 * 
 * Fetches academic metadata from ArXiv repository for AI models
 * Based on pattern from github-enricher.js (Task 6)
 */

import axios from 'axios';
import xml2js from 'xml2js';

const ARXIV_API_BASE = 'http://export.arxiv.org/api/query';
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds

/**
 * Extract ArXiv ID from model source_url or description
 * @param {Object} model - Model object with source_url and description
 * @returns {string|null} ArXiv ID or null if not found
 */
export function extractArxivId(model) {
    // Pattern 1: Check source_url for arxiv.org links
    if (model.source_url && model.source_url.includes('arxiv.org')) {
        // Match patterns:
        // https://arxiv.org/abs/2301.12345
        // https://arxiv.org/pdf/2301.12345.pdf
        // https://arxiv.org/abs/cs/0601001
        const absMatch = model.source_url.match(/arxiv\.org\/(?:abs|pdf)\/([a-z-]+\/\d{7}|\d{4}\.\d{4,5})/i);
        if (absMatch) {
            return absMatch[1].replace('.pdf', '');
        }
    }

    // Pattern 2: Check description for ArXiv ID mentions
    if (model.description) {
        // Match patterns:
        // arXiv:2301.12345
        // arxiv:cs/0601001
        const descMatch = model.description.match(/arXiv[:\s]+([a-z-]+\/\d{7}|\d{4}\.\d{4,5})/i);
        if (descMatch) {
            return descMatch[1];
        }
    }

    return null;
}

/**
 * Fetch metadata for an ArXiv paper
 * @param {string} arxivId - ArXiv ID (e.g., "2301.12345" or "cs/0601001")
 * @returns {Promise<Object|null>} Paper metadata or null
 */
export async function fetchArxivMetadata(arxivId) {
    let lastError = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
            const url = `${ARXIV_API_BASE}?id_list=${arxivId}`;

            const response = await axios.get(url, {
                timeout: 10000, // 10 second timeout
                headers: {
                    'User-Agent': 'AI-Nexus-Enricher/1.0'
                }
            });

            // Parse Atom XML response
            const parser = new xml2js.Parser({
                explicitArray: false,
                tagNameProcessors: [xml2js.processors.stripPrefix], // Remove xmlns prefixes
                attrkey: 'attrs',
                charkey: 'value'
            });

            const result = await parser.parseStringPromise(response.data);

            // Extract entry from feed
            const entry = result.feed.entry;

            if (!entry) {
                // No results found
                console.warn(`ArXiv ID not found: ${arxivId}`);
                return null;
            }

            // Extract metadata
            const metadata = {
                arxiv_id: arxivId,
                arxiv_category: null,
                arxiv_published: null,
                arxiv_updated: null,
                title: null,
                abstract: null
            };

            // Extract primary category
            if (entry.primary_category && entry.primary_category.attrs) {
                metadata.arxiv_category = entry.primary_category.attrs.term;
            }

            // Extract dates
            if (entry.published) {
                metadata.arxiv_published = entry.published;
            }

            if (entry.updated) {
                metadata.arxiv_updated = entry.updated;
            }

            // Extract title and abstract (for verification)
            if (entry.title) {
                metadata.title = entry.title.trim();
            }

            if (entry.summary) {
                metadata.abstract = entry.summary.trim();
            }

            return metadata;

        } catch (error) {
            lastError = error;

            // Don't retry on 404 or invalid XML
            if (error.response?.status === 404 || error.name === 'Error') {
                console.warn(`ArXiv fetch failed for ${arxivId}: ${error.message}`);
                return null;
            }

            // Retry on network errors or timeouts
            if (attempt < MAX_RETRIES - 1) {
                const delay = RETRY_DELAY * Math.pow(2, attempt); // Exponential backoff
                console.warn(`Retry ${attempt + 1}/${MAX_RETRIES} for ${arxivId} in ${delay}ms`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    console.error(`Failed to fetch ArXiv metadata after ${MAX_RETRIES} attempts for ${arxivId}:`, lastError?.message);
    return null;
}

/**
 * Enrich a model with ArXiv metadata
 * @param {Object} model - Model object to enrich
 * @returns {Promise<Object|null>} Enrichment data or null
 */
export async function enrichModelWithArxiv(model) {
    try {
        // Step 1: Extract ArXiv ID
        const arxivId = extractArxivId(model);

        if (!arxivId) {
            // No ArXiv reference found
            return null;
        }

        console.log(`  Found ArXiv ID: ${arxivId}`);

        // Step 2: Fetch metadata from ArXiv API
        const metadata = await fetchArxivMetadata(arxivId);

        if (!metadata) {
            // API fetch failed
            return null;
        }

        // Step 3: Return enrichment data
        return {
            arxiv_id: metadata.arxiv_id,
            arxiv_category: metadata.arxiv_category || '',
            arxiv_published: metadata.arxiv_published || '',
            arxiv_updated: metadata.arxiv_updated || ''
        };

    } catch (error) {
        console.error(`Error enriching model ${model.id} with ArXiv:`, error.message);
        return null;
    }
}

/**
 * Check if model has potential ArXiv reference
 * @param {Object} model - Model object
 * @returns {boolean} True if model might have ArXiv reference
 */
export function hasArxivReference(model) {
    if (!model) return false;

    const hasArxivUrl = model.source_url && model.source_url.includes('arxiv.org');
    const hasArxivMention = model.description &&
        (model.description.includes('arXiv:') || model.description.includes('arxiv.org'));

    return hasArxivUrl || hasArxivMention;
}
