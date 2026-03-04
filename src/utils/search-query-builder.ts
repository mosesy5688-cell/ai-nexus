/**
 * Search Query Builder (Extracted from search.ts to conform to CES size limits)
 * Processes GitHub-style commands and builds FTS5/B-Tree SQL queries.
 */

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
            sql = `SELECT ${columns} FROM search s JOIN entities e ON s.rowid = e.rowid WHERE search MATCH ?`;
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
