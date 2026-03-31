/**
 * HuggingFace Datasets Adapter — Helpers
 * Extracted per CES Art 5.1 Anti-Monolith.
 * normalize(), extractAssets(), buildMetaJson(), parseDatasetId(), normalizeTags()
 *
 * @module ingestion/adapters/datasets-helpers
 */

/**
 * Extract schema data from datasets-server info response
 */
export function extractSchemaInfo(schemaData) {
    let schemaMarkdown = '';
    let totalRows = 0;
    if (!schemaData) return { schemaMarkdown, totalRows };

    try {
        const configKey = Object.keys(schemaData).includes('default') ? 'default' : Object.keys(schemaData)[0];
        if (configKey) {
            const info = schemaData[configKey];
            const features = info.features || {};
            const splits = info.splits || {};

            Object.values(splits).forEach(s => { totalRows += (s.num_examples || 0); });

            if (Object.keys(features).length > 0) {
                schemaMarkdown += '\n\n## 📊 Structured Schema (Zero-Fabrication)\n';
                schemaMarkdown += '| Feature Key | Data Type |\n| :--- | :--- |\n';
                Object.entries(features).forEach(([fKey, fVal]) => {
                    let typeStr = fVal.dtype || fVal._type || 'unknown';
                    if (fVal._type === 'Sequence' && fVal.feature) typeStr = `Sequence[${fVal.feature.dtype || fVal.feature._type}]`;
                    schemaMarkdown += `| \`${fKey}\` | \`${typeStr}\` |\n`;
                });
                if (totalRows > 0) {
                    schemaMarkdown += `\n**Estimated Rows:** \`${totalRows.toLocaleString()}\`\n`;
                }
            }
        }
    } catch (e) { }

    return { schemaMarkdown, totalRows };
}

/**
 * Extract meaningful images from dataset siblings
 */
export function extractDatasetAssets(raw) {
    const assets = [];
    const siblings = raw.siblings || [];
    const meaningfulKeywords = ['sample', 'example', 'visualization',
        'preview', 'demo', 'overview', 'distribution'];

    for (const file of siblings) {
        const filename = file.rfilename || '';
        if (/\.(webp|png|jpg|jpeg|gif)$/i.test(filename)) {
            const isMeaningful = meaningfulKeywords.some(kw =>
                filename.toLowerCase().includes(kw)
            );
            if (isMeaningful) {
                assets.push({
                    type: 'visualization',
                    url: `https://huggingface.co/datasets/${raw.id}/resolve/main/${filename}`,
                    filename
                });
            }
        }
    }
    return assets;
}

/**
 * Build meta_json for dataset entity
 */
export function buildDatasetMetaJson(raw) {
    let metricRows = 0;
    if (raw._schemaData) {
        try {
            const configKey = Object.keys(raw._schemaData).includes('default') ? 'default' : Object.keys(raw._schemaData)[0];
            if (configKey && raw._schemaData[configKey].splits) {
                Object.values(raw._schemaData[configKey].splits).forEach(s => metricRows += (s.num_examples || 0));
            }
        } catch (e) { }
    }

    return {
        size_category: raw.cardData?.size_category || null,
        task_categories: raw.cardData?.task_categories || [],
        task_ids: raw.cardData?.task_ids || [],
        language: raw.cardData?.language || null,
        multilinguality: raw.cardData?.multilinguality || null,
        source_datasets: raw.cardData?.source_datasets || [],
        paperswithcode_id: raw.cardData?.paperswithcode_id || null,
        files_count: raw._filesCount || raw.siblings?.length || 0,
        rows_count: metricRows || null,
        gated: raw.gated || false,
        private: raw.private || false,
        citation: raw.cardData?.citation || null
    };
}

export function parseDatasetId(datasetId) {
    const parts = (datasetId || '').split('/');
    if (parts.length >= 2) return [parts[0], parts.slice(1).join('-')];
    return ['unknown', datasetId || 'unknown'];
}

export function normalizeDatasetTags(tags) {
    if (!Array.isArray(tags)) return [];
    return tags
        .filter(t => typeof t === 'string')
        .map(t => t.toLowerCase().trim())
        .filter(t => t.length > 0 && t.length < 50);
}
