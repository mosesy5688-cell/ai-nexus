/**
 * Entity Metadata Extraction & Identity Utilities
 * V19.5 - Consolidated for Global Registry Support
 */

import { heuristicMining } from './entity-type-handlers.js';

/**
 * 1. Identity & Author Extraction (V1.0 Legacy Restoration)
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
        return { type: 'huggingface', icon: '🫂', label: 'HF' };
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

/**
 * 2. Beautification & Modular Hydration (V19.5 Modular Addition)
 */

export function beautifyName(hydrated) {
    const isSlug = hydrated.name && !hydrated.name.includes(' ') && (hydrated.name.includes('-') || hydrated.name.includes('_') || hydrated.name.includes('--'));
    const isArXivID = /^\d{4}\.\d{4,5}$/.test(hydrated.name || '');
    const matchesId = hydrated.name === hydrated.id;
    const hasValidName = hydrated.name && hydrated.name !== 'Unknown' && hydrated.name !== 'Unknown Model' && hydrated.name !== 'Unknown Entity';

    if (!hasValidName || isSlug || matchesId || isArXivID) {
        const id = hydrated.id || '';
        const parts = id.split('--');
        const rawName = parts[parts.length - 1] || id || 'Unknown Entity';

        if (isArXivID || /^\d{4}\.\d{4,5}$/.test(rawName)) {
            hydrated.name = `Paper ${rawName}`;
        } else {
            hydrated.name = rawName
                .replace(/[-_]/g, ' ')
                .split(' ')
                .filter(Boolean)
                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' ');
        }

        if (!hydrated.name || hydrated.name === 'Model' || hydrated.name === 'Agent') {
            hydrated.name = rawName || 'Deep Insight Node';
        }
    }
}

export function beautifyAuthor(hydrated) {
    const id = hydrated.id || '';
    const parts = id.split('--');
    const hasValidAuthor = hydrated.author && hydrated.author !== 'Unknown' && !hydrated.author.includes('-') && hydrated.author !== '';

    if (!hasValidAuthor && parts.length >= 2) {
        const rawAuthor = (parts.length > 2) ? parts[parts.length - 2] : parts[0];
        hydrated.author = rawAuthor
            .replace(/[-_]/g, ' ')
            .split(' ')
            .filter(Boolean)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

        if (!hydrated.author || hydrated.author === 'Hf' || hydrated.author === 'Gh') {
            hydrated.author = 'Independent / Community';
        }
    }
}

export function extractTechSpecs(hydrated, entity, meta) {
    const config = entity.config || meta.config || meta.extended?.config || {};
    const getVal = (paths, fallback = null) => {
        for (const path of paths) {
            const val = path.split('.').reduce((obj, key) => obj?.[key], config);
            if (val !== undefined && val !== null) return val;
        }
        return fallback;
    };

    hydrated.context_length = hydrated.context_length || meta.extended?.context_length ||
        getVal(['max_position_embeddings', 'n_ctx', 'max_seq_len', 'max_sequence_length', 'model_max_length', 'seq_length', 'n_positions']);

    hydrated.architecture = hydrated.architecture || meta.extended?.architecture ||
        getVal(['model_type', 'architectures.0', 'arch']);

    hydrated.params_billions = parseFloat(hydrated.params_billions || meta.extended?.params_billions ||
        getVal(['num_parameters', 'n_params', 'safetensors.total']) || 0) || null;

    if (!hydrated.params_billions && hydrated.name) {
        const pMatch = hydrated.name.match(/(\d+(\.\d+)?)\s?[Bb]([iI][lL])?/);
        if (pMatch) hydrated.params_billions = parseFloat(pMatch[1]);
    }

    if (meta.params && !hydrated.params_billions) {
        hydrated.params_billions = parseFloat(meta.params);
    }
    if (meta.storage_bytes && !hydrated.size_kb) {
        hydrated.size_kb = Math.round(meta.storage_bytes / 1024);
    }
    const quant = meta.config?.quantization_config?.quant_method || meta.config?.quantization_config?.bits;
    if (quant && !hydrated.quant_bits) {
        hydrated.quant_bits = typeof quant === 'number' ? quant : (parseInt(quant) || null);
    }

    if (!hydrated.context_length && hydrated.name) {
        const cMatch = hydrated.name.match(/(\d+)\s?[Kk]([wW]|[tT])?/);
        if (cMatch) {
            const kVal = parseInt(cMatch[1]);
            if (!isNaN(kVal)) hydrated.context_length = kVal * 1024;
        }
    }

    if (!hydrated.context_length && hydrated.params_billions) {
        hydrated.context_length = 4096;
    }

    hydrated.num_layers = hydrated.num_layers || config.num_hidden_layers || config.n_layer || config.n_layers;
    hydrated.hidden_size = hydrated.hidden_size || config.hidden_size || config.n_embd || config.d_model || config.dim;
    hydrated.num_heads = hydrated.num_heads || config.num_attention_heads || config.n_head || config.n_heads;

    hydrated.moe_experts = getVal(['num_local_experts', 'num_experts', 'n_experts', 'moe.num_experts']);
    hydrated.moe_active = getVal(['num_experts_per_tok', 'num_active_experts', 'n_active_experts']);
    hydrated.kv_heads = getVal(['num_key_value_heads', 'multi_query_attention', 'n_kv_heads']);
    hydrated.vocab_size = getVal(['vocab_size', 'n_vocab']);
    hydrated.tie_weights = getVal(['tie_word_embeddings'], false);

    if (!hydrated.body_content) {
        hydrated.body_content = entity.html_readme || entity.htmlFragment || meta.html_readme || meta.htmlFragment || meta.extended?.html_readme || entity.body_content || entity.readme || meta.readme || meta.model_card || meta.description || meta.abstract || null;
    }

    heuristicMining(hydrated);

    if (hydrated.body_content && (!hydrated.gallery_images || hydrated.gallery_images.length === 0)) {
        const imgRegex = /!\[.*?\]\((.*?)\)/g;
        const images = [];
        let m;
        while ((m = imgRegex.exec(hydrated.body_content)) !== null) {
            if (m[1] && !images.includes(m[1])) images.push(m[1]);
        }
        hydrated.gallery_images = images.slice(0, 6);
    }
}
