
// src/utils/builders/seo-builder.js
import { getDisplayName, getBestDescription } from './model-getters.js';
import { truncate } from './parsing-utils.js';
import { toMetricRows } from '../benchmark-labels.js';

// Build full JSON-LD SEO schema (S-Grade with Dataset)
export function buildSEOSchema(model, benchmarks, specs) {
    const name = getDisplayName(model);
    const desc = truncate(getBestDescription(model), 160);
    const url = `https://free2aitools.com/model/${model.id || model.umid}`;

    const schema = {
        "@context": "https://schema.org/",
        "@type": "SoftwareApplication",
        "name": name,
        "applicationCategory": "AIModel",
        "operatingSystem": "Cross-platform",
        "description": desc,
        "url": url,
        "aggregateRating": {
            "@type": "AggregateRating",
            // V27.88: v2 'average' (fallback to legacy avg_score)
            "ratingValue": benchmarks?.average ?? benchmarks?.avg_score ?? 0,
            "bestRating": 100,
            "worstRating": 0,
            "ratingCount": Math.max(1, specs.ollama_pulls || 0) // Use pulls as proxy for count
        },
        // V27.88: one PropertyValue per real metric, schema-agnostic (no hardcoded MMLU)
        "customMetric": toMetricRows(benchmarks).map((r) => ({
            "@type": "PropertyValue",
            "name": r.label,
            "value": r.value,
            "maxValue": 100,
        }))
    };

    // Add Dataset schema if it's a dataset type (future proofing)
    if (model.type === 'dataset') {
        return {
            ...schema,
            "@type": "Dataset",
            "license": specs.license_spdx
        };
    }

    return schema;
}

// Build SEO metadata
export function buildSEOMeta(model, benchmarks, specs) {
    const name = getDisplayName(model);
    const desc = truncate(getBestDescription(model), 160);

    return {
        title: `${name} - Model Specs & Benchmarks | AI Nexus`,
        description: desc,
        openGraph: {
            title: name,
            description: desc,
            type: 'website',
            image: model.cover_image || 'https://free2aitools.com/og-default.jpg'
        },
        twitter: {
            card: 'summary_large_image',
            title: name,
            description: desc
        }
    };
}
