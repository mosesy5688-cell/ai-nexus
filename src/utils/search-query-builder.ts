/**
 * Search Query Builder (Extracted from search.ts to conform to CES size limits)
 * Processes GitHub-style commands and builds FTS5/B-Tree SQL queries.
 */

export const cyrb53 = (str: string, seed = 0) => {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0, ch; i < str.length; i++) {
        ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 4294967296 * (2097151 & h2) + (h1 >>> 0);
};

export function getShardIndex(nameStr: string, shardCount: number) {
    if (!shardCount || shardCount <= 1) return 1;
    const hash = cyrb53(nameStr || '');
    return (hash % shardCount) + 1;
}

/**
 * V23.2: Federated Search Router
 * - Keyword search (q present): full federation across ALL shards in two phases
 * - Browse mode (no q): core or category-specific shard only
 * - Exact slug lookup: use getShardForSlug() separately (Layer 3 hash routing)
 *
 * Returns { priority, expansion } for two-phase execution:
 *   Phase A (priority): high-hit-rate DBs, ~200-500ms
 *   Phase B (expansion): remaining shards, only if Phase A results < limit
 */
export function determineTargetDbs(type: string, q: string, page: number, manifest?: any): { priority: string[], expansion: string[] } {
    const partitions = manifest?.partitions || { model: 5, paper: 14 }; // V23.1 Default Fallback

    const formatName = (cat: string, idx: number, total: number) => {
        return total === 1 ? `meta-${cat}.db` : `meta-${cat}-shard-${String(idx).padStart(2, '0')}.db`;
    };

    // No search query: browse/pagination mode
    if (!q) {
        if (type === 'model') {
            return { priority: ['meta-model-core.db'], expansion: [] };
        }
        if (type === 'all') {
            // Cross-type browse: core + one shard per single-shard category
            const priority: string[] = ['meta-model-core.db'];
            for (const [cat, count] of Object.entries(partitions) as [string, number][]) {
                if (cat === 'model') continue;
                priority.push(count === 1 ? `meta-${cat}.db` : formatName(cat, 1, count));
            }
            return { priority, expansion: [] };
        }
        const count = partitions[type] || 1;
        return { priority: [formatName(type, 1, count)], expansion: [] };
    }

    // Keyword search: federated across all shards

    // Phase A: priority DBs (core + single-shard categories)
    const priority: string[] = ['meta-model-core.db'];
    for (const [cat, count] of Object.entries(partitions) as [string, number][]) {
        if (cat === 'model') continue;
        if (count === 1) priority.push(formatName(cat, 1, 1));
    }

    // Phase B: expansion DBs (all shards of multi-shard categories)
    const expansion: string[] = [];

    if (type === 'all') {
        for (const [cat, count] of Object.entries(partitions) as [string, number][]) {
            if (count <= 1) continue; // already in priority
            for (let i = 1; i <= count; i++) {
                if (cat === 'model') {
                    expansion.push(`meta-model-shard-${String(i).padStart(2, '0')}.db`);
                } else {
                    expansion.push(formatName(cat, i, count));
                }
            }
        }
    } else if (type === 'model') {
        // Model-specific: core already in priority, add all model shards
        const mCount = partitions.model || 5;
        for (let i = 1; i <= mCount; i++) {
            expansion.push(`meta-model-shard-${String(i).padStart(2, '0')}.db`);
        }
    } else {
        // Category-specific: federate all shards of that category
        const count = partitions[type] || 1;
        if (count > 1) {
            // Remove single-shard entry from priority if present, add all shards
            const singleName = formatName(type, 1, 1);
            const idx = priority.indexOf(singleName);
            if (idx > -1) priority.splice(idx, 1);
            for (let i = 1; i <= count; i++) {
                priority.push(formatName(type, i, count));
            }
        }
    }

    return { priority, expansion };
}

/**
 * Layer 3: Hash-Direct slug lookup (detail pages / hydration only)
 */
export function getShardForSlug(slug: string, type: string, manifest?: any): string {
    const partitions = manifest?.partitions || { model: 5, paper: 14 };
    if (type === 'model') {
        const idx = getShardIndex(slug, partitions.model || 5);
        return `meta-model-shard-${String(idx).padStart(2, '0')}.db`;
    }
    const count = partitions[type] || 1;
    const idx = getShardIndex(slug, count);
    return count === 1 ? `meta-${type}.db` : `meta-${type}-shard-${String(idx).padStart(2, '0')}.db`;
}

/**
 * Parse GitHub-style command filters from query string.
 */
export function parseCommands(rawQuery: string) {
    const tokens = (rawQuery || '').split(/\s+/);
    const filters: Record<string, string> = {};
    const searchTerms: string[] = [];

    for (const token of tokens) {
        const lower = token.toLowerCase();
        if (lower.includes(':')) {
            const [key, val] = lower.split(':');
            if (['author', 'task', 'license', 'params', 'fni', 'ctx'].includes(key) && val) {
                filters[key] = val;
            } else {
                searchTerms.push(token);
            }
        } else if (token) {
            searchTerms.push(token);
        }
    }

    return { query: searchTerms.join(' '), filters };
}

/**
 * Build SQL query with FTS5 MATCH or B-Tree path.
 */
export function buildQuery(parsed: { query: string; filters: Record<string, string> }, type: string) {
    const columns = `e.id, e.slug, e.name, e.type, e.author, e.summary, e.fni_score, e.stars, e.downloads, e.last_modified, e.license, e.pipeline_tag, e.params_billions, e.context_length`;
    const combined = { ...parsed.filters };
    const q = parsed.query;

    let sql = `SELECT ${columns} FROM entities e`;
    const params: any[] = [];
    let isFTS = false;

    if (q && q.length >= 2) {
        const safeQuery = q.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/)
            .filter((t: string) => t.length > 0).map((t: string) => `"${t}"*`).join(' AND ');
        if (safeQuery) {
            sql = `SELECT s.rank as rank, ${columns} FROM search s JOIN entities e ON s.rowid = e.rowid WHERE search MATCH ?`;
            params.push(safeQuery);
            isFTS = true;
        }
    } else {
        sql += ` WHERE 1=1`;
    }

    if (combined.author) { sql += ` AND e.author LIKE ?`; params.push(`%${combined.author}%`); }
    if (combined.params) {
        const op = combined.params.match(/[><=]+/)?.[0] || '>=';
        const val = parseFloat(combined.params.replace(/[^\d.]/g, ''));
        if (!isNaN(val)) { sql += ` AND e.params_billions ${op} ?`; params.push(val); }
    }
    if (combined.fni) {
        const op = combined.fni.match(/[><=]+/)?.[0] || '>=';
        const val = parseFloat(combined.fni.replace(/[^\d.]/g, ''));
        if (!isNaN(val)) { sql += ` AND e.fni_score ${op} ?`; params.push(val); }
    }
    if (combined.ctx) {
        const op = combined.ctx.match(/[><=]+/)?.[0] || '>=';
        const val = parseFloat(combined.ctx.replace(/[^\d.]/g, ''));
        if (!isNaN(val)) { sql += ` AND e.context_length ${op} ?`; params.push(val); }
    }
    if (combined.license) { sql += ` AND e.license LIKE ?`; params.push(`%${combined.license}%`); }
    if (combined.task) { sql += ` AND e.pipeline_tag LIKE ?`; params.push(`%${combined.task}%`); }
    if (type && type !== 'all') { sql += ` AND e.type = ?`; params.push(type); }

    return { sql, params, isFTS };
}
