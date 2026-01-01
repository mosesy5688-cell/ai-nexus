/**
 * Template Summary Generator - V12 AI Summary Optimization
 * 
 * Constitution Compliant: Extracted from model-enricher.ts for Art 5.1
 * 
 * Features:
 * - Enhanced template with params_billions
 * - Downloads filter for AI generation eligibility
 */

/**
 * Generate template-based SEO summary for entities
 * B.19: Fallback for entities that don't get AI-generated summaries
 * V12: Enhanced with params_billions and pipeline_tag
 * 
 * @param model - The model/entity data
 * @returns SEO-friendly summary string
 */
export function generateTemplateSummary(model: any): string {
    const name = model.name || 'AI Model';
    const author = model.author || 'Unknown';
    const type = model.type || 'model';
    const pipelineTag = model.pipeline_tag || '';
    const description = (model.description || '').substring(0, 120).trim();

    // V12: Extract params info for richer summaries
    const params = model.params_billions || model.config?.num_parameters;
    const paramsStr = params ? formatParams(params) : '';

    // Build template based on type
    let summary = '';

    switch (type) {
        case 'agent':
            summary = `${name} is an AI agent by ${author}`;
            if (pipelineTag) summary += ` for ${pipelineTag}`;
            break;
        case 'dataset':
            summary = `${name} is a dataset by ${author}`;
            if (pipelineTag) summary += ` for ${pipelineTag} tasks`;
            break;
        case 'paper':
            summary = `${name} is a research paper by ${author}`;
            break;
        default: // model
            summary = `${name} is an open-source AI model`;
            if (paramsStr) summary += ` with ${paramsStr} parameters`;
            summary += ` by ${author}`;
            if (pipelineTag) summary += ` for ${pipelineTag}`;
    }

    // Append truncated description if available
    if (description) {
        summary += `. ${description}`;
        if (description.length >= 120) summary += '...';
    }

    return summary.trim();
}

/**
 * Format parameter count for display
 */
function formatParams(params: number): string {
    if (params >= 1e9) {
        return `${(params / 1e9).toFixed(1)}B`;
    } else if (params >= 1e6) {
        return `${(params / 1e6).toFixed(0)}M`;
    } else if (params >= 1) {
        // Already in billions
        return `${params.toFixed(1)}B`;
    }
    return '';
}

/**
 * V12: Check if model qualifies for AI summary generation
 * Filter: downloads > 10,000 threshold
 */
export function qualifiesForAiSummary(model: any): boolean {
    const downloads = model.downloads || 0;
    const MIN_DOWNLOADS = 10000;
    return downloads >= MIN_DOWNLOADS;
}
