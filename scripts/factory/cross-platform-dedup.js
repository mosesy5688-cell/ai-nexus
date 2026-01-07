/**
 * Factory Cross-Platform Deduplication V14.5
 * 
 * Constitution: Art 3 (Factory), Art 6 (Search Quality)
 * Governance: SPEC-V14.5-OPT-FINAL
 * 
 * Strategy: Fan-In Deduplication
 * 1. Normalize Names (remove quantized suffixes)
 * 2. Group by Similarity (0.8 threshold)
 * 3. Select Canonical using Truth Hierarchy (HF > GH > Eco)
 * 4. Merge Metadata (Tag Union, Longest Description)
 */

// Truth Hierarchy: Lower index = Higher authority
const SOURCE_AUTHORITY = [
    'huggingface',          // Tier 1: Gold standard for metadata
    'huggingface-datasets',
    'huggingface-spaces',
    'github',              // Tier 1: Agents source
    'arxiv',               // Tier 2: Academic
    'semanticscholar',
    'civitai',             // Tier 3: Ecosystem
    'kaggle',
    'ollama',
    'replicate',
    'openllm',
    'deepspec',
    'mcp',
    'agents'
];

/**
 * Get authority score for a source (Lower is better)
 */
function getAuthorityScore(source) {
    if (!source) return 999;
    // Handle composite sources (e.g. "huggingface:user/repo")
    const baseSource = source.split(':')[0];
    const index = SOURCE_AUTHORITY.indexOf(baseSource);
    return index === -1 ? 999 : index;
}

/**
 * Normalize model name for comparison
 */
function normalizeName(name) {
    if (!name) return '';
    return name
        .toLowerCase()
        .replace(/[\-_\.]/g, '')
        .replace(/gguf$/i, '')
        .replace(/ggml$/i, '')
        .replace(/\d+b$/i, '')
        .replace(/\d+m$/i, '')
        .replace(/fp16$/i, '')
        .replace(/int[48]$/i, '')
        .replace(/q[48]_[01k]$/i, '')
        .trim();
}

/**
 * Calculate similarity score between two entities
 */
function calculateSimilarity(e1, e2) {
    const n1 = normalizeName(e1.name);
    const n2 = normalizeName(e2.name);

    if (n1 === n2) return 1.0;
    if (n1.includes(n2) || n2.includes(n1)) return 0.8;

    // Check author + partial name
    const a1 = (e1.author || '').toLowerCase();
    const a2 = (e2.author || '').toLowerCase();

    if (a1 && a2 && a1 === a2) {
        // Same author, check base name similarity
        const base1 = n1.split('/').pop() || n1;
        const base2 = n2.split('/').pop() || n2;
        if (base1.includes(base2) || base2.includes(base1)) return 0.7;
    }

    return 0;
}

/**
 * Find duplicate groups in a list of entities
 */
function findDuplicateGroups(entities) {
    const groups = [];
    const processed = new Set();

    // Sort by authority first to optimize finding the best candidate early
    const sorted = [...entities].sort((a, b) => getAuthorityScore(a.source) - getAuthorityScore(b.source));

    for (let i = 0; i < sorted.length; i++) {
        if (processed.has(sorted[i].id)) continue;

        const group = [sorted[i]];
        processed.add(sorted[i].id);

        for (let j = i + 1; j < sorted.length; j++) {
            if (processed.has(sorted[j].id)) continue;

            const similarity = calculateSimilarity(sorted[i], sorted[j]);
            if (similarity >= 0.8) { // Strict threshold for auto-merge
                group.push(sorted[j]);
                processed.add(sorted[j].id);
            }
        }

        if (group.length > 1) {
            groups.push(group);
        }
    }

    return groups;
}

/**
 * Select canonical entity and merge metadata
 */
function mergeGroup(group) {
    // 1. Select Canonical based on Truth Hierarchy
    const canonical = group.sort((a, b) => {
        // Primary: Source Authority (HF > GH > Eco)
        const authDiff = getAuthorityScore(a.source) - getAuthorityScore(b.source);
        if (authDiff !== 0) return authDiff;

        // Secondary: Downloads/Popularity
        const pA = (a.downloads || 0) + (a.likes || 0);
        const pB = (b.downloads || 0) + (b.likes || 0);
        if (pA !== pB) return pB - pA;

        // Tertiary: Content Length (Longer is usually better)
        return (b.description?.length || 0) - (a.description?.length || 0);
    })[0];

    // 2. Metadata Merger (Tag Union & Stats)
    const allTags = new Set(canonical.tags || []);
    let maxDownloads = canonical.downloads || 0;
    let maxLikes = canonical.likes || 0;

    // Track merged IDs for transparency
    const mergedIds = [];

    for (const e of group) {
        if (e.id === canonical.id) continue;

        // Union Tags
        if (Array.isArray(e.tags)) {
            e.tags.forEach(tag => allTags.add(tag));
        }

        // Maximize known stats
        maxDownloads = Math.max(maxDownloads, e.downloads || 0);
        maxLikes = Math.max(maxLikes, e.likes || 0);

        mergedIds.push(e.id);

        // Keep longer description if canonical description is very short/empty
        if ((!canonical.description || canonical.description.length < 50) && (e.description && e.description.length > 100)) {
            canonical.description = e.description;
        }
    }

    // Apply merged data to canonical
    canonical.tags = Array.from(allTags);
    canonical.downloads = maxDownloads;
    canonical.likes = maxLikes;

    // Add dedup metadata (optional, for debugging)
    if (mergedIds.length > 0) {
        canonical._dedup = {
            merged_count: mergedIds.length,
            sources: group.map(g => g.source)
        };
    }

    return canonical;
}

/**
 * Main Deduplication Function
 */
export function dedupCrossPlatform(entities) {
    if (!entities || entities.length === 0) return entities;

    // 1. Identify groups
    const groups = findDuplicateGroups(entities);

    // 2. Map IDs to remove
    const removalMap = new Set();
    const dedupMap = {}; // id -> canonical_id

    groups.forEach(group => {
        const canonical = mergeGroup(group);

        group.forEach(e => {
            if (e.id !== canonical.id) {
                removalMap.add(e.id);
                dedupMap[e.id] = canonical.id;
            }
        });
    });

    // 3. Filter list
    const finalEntities = entities.filter(e => !removalMap.has(e.id));

    return {
        entities: finalEntities,
        dedupMap,
        stats: {
            input: entities.length,
            output: finalEntities.length,
            groups: groups.length,
            merged: removalMap.size
        }
    };
}
