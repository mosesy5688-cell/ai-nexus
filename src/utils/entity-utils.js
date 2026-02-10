/**
 * Entity Metadata Extraction Utilities
 * V1.0 - Focused on Identity and Source Reliability
 */

export function extractAuthor(id, fallbackAuthor) {
    if (!id) return fallbackAuthor || 'Open Source';

    // If author is numeric, treat it as missing/invalid
    const isNumeric = /^\d+$/.test(fallbackAuthor);

    // Strip source prefix and standard hf-model-- style prefixes
    const cleanId = id.replace(/^[a-z]+:/i, '').replace(/^[a-z]+-[a-z]+--/i, '');

    // If we have a valid non-numeric author, use it
    if (fallbackAuthor && !isNumeric) return fallbackAuthor;

    // Otherwise, extract from ID (e.g., "meta-llama/llama-3" -> "meta-llama")
    const parts = cleanId.split(/[:/]/);
    if (parts.length >= 2) {
        return parts[0];
    }

    return 'Open Source';
}

export function getSourceMetadata(id) {
    if (!id) return { type: 'unknown', icon: '📦', label: 'Source' };
    const lowId = id.toLowerCase();

    if (lowId.startsWith('hf:') || lowId.includes('huggingface')) {
        return { type: 'huggingface', icon: '🤗', label: 'HF' };
    }
    if (lowId.startsWith('gh:') || lowId.includes('github')) {
        return { type: 'github', icon: '🐙', label: 'GH' };
    }
    if (lowId.startsWith('arxiv:') || lowId.includes('arxiv')) {
        return { type: 'arxiv', icon: '📄', label: 'ArXiv' };
    }
    if (lowId.includes('pytorch')) {
        return { type: 'pytorch', icon: '🔥', label: 'PT' };
    }
    return { type: 'unknown', icon: '📦', label: 'Source' };
}

export function isActive(lastModified) {
    if (!lastModified) return false;
    const date = new Date(lastModified);
    if (isNaN(date.getTime())) return false;

    const daysSince = (Date.now() - date.getTime()) / (1000 * 3600 * 24);
    return daysSince <= 30;
}
