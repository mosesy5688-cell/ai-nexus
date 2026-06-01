/**
 * Slug normalization + multi-form ID candidate generation.
 *
 * Shared between /api/v1/entity/[...id].ts and /api/v1/compare.ts — both
 * endpoints need to map an Agent-provided ID (which may be HF-native
 * `author/name`, bare `name`, internal canonical `hf-model--author--name`,
 * uppercase/mixed case, or slug form) to the canonical lookup keys stored
 * in meta-NN.db.
 *
 * Extracted from entity/[...id].ts + compare.ts (V27.22 dedup) to:
 *   - keep entity/[...id].ts under the 250-line CES monolith cap
 *   - eliminate the literal SLUG_PREFIXES + deriveSlug duplication that
 *     drifted between the two files
 */

export const SLUG_PREFIXES = [
    'hf-model', 'hf-agent', 'hf-tool', 'hf-dataset', 'hf-space', 'hf-paper', 'hf-collection',
    'gh-model', 'gh-agent', 'gh-tool', 'gh-repo',
    'arxiv-paper', 'arxiv', 'paper',
    'replicate-model', 'replicate-agent', 'replicate-space',
    'civitai-model', 'ollama-model', 'kaggle-dataset', 'kaggle-model',
    'langchain-prompt', 'langchain-agent',
    'knowledge', 'concept', 'report', 'dataset', 'model', 'agent', 'tool', 'space', 'prompt',
];

/** Auto-prepended prefixes when input has no recognized prefix. */
const AUTO_PREFIXES = ['hf-model', 'gh-model', 'gh-tool', 'arxiv-paper', 'replicate-model',
    'hf-dataset', 'kaggle-model', 'civitai-model', 'ollama-model'];

/**
 * Strip recognized source prefix and normalize separators to `--`.
 * Example: `hf-model--meta-llama/Llama-3-8B` → `meta-llama--llama-3-8b`
 */
export function deriveSlug(id: string): string {
    let r = (id || '').toLowerCase();
    for (const p of SLUG_PREFIXES) {
        if (r.startsWith(`${p}--`) || r.startsWith(`${p}:`) || r.startsWith(`${p}/`)) {
            r = r.slice(p.length + (r[p.length] === '-' ? 2 : 1));
            break;
        }
    }
    return r.replace(/[:\/]/g, '--').replace(/^--|--$/g, '').replace(/--+/g, '--');
}

/**
 * V27.92 T3(b): candidate lookup keys for a /paper/<urlslug> page request.
 *
 * The paper page route emits /paper/<bare-arxiv-id> (dots preserved, e.g.
 * 2307.01952). The page resolver normalizes that to the same bare form. But
 * real arxiv papers store slug='arxiv--<id>' (~75%) or bare '<id>' no-sep
 * (~20%), while only content-hash papers store 'unknown--<sha>' (~3.2%).
 * Hashing only the legacy 'unknown--<id>' form lands on the wrong meta shard,
 * so the entity is unreachable. Returning every plausible stored form lets the
 * caller hash each to ITS OWN shard and recover the link.
 *
 * `normalized` is the already-normalized bare urlslug (no source prefix). Out
 * of scope: old-style category tail `arxiv--cs--<id>` (~3K, needs `.`->`--`
 * reversal) — documented follow-up.
 */
export function generatePaperCandidates(normalized: string): string[] {
    const bare = (normalized || '').toLowerCase();
    if (!bare) return [];
    const candidates = new Set<string>();
    if (bare.includes('--')) {
        // Already a prefixed/canonical form (e.g. unknown--<sha>): query as-is.
        candidates.add(bare);
    } else {
        candidates.add(`arxiv--${bare}`);   // ~75% real arxiv papers
        candidates.add(bare);               // ~20% bare no-sep
        candidates.add(`unknown--${bare}`); // ~3.2% content-hash papers
    }
    return [...candidates].filter(Boolean);
}

/** Bare arxiv id shape, e.g. 2604.22294 (mirrors utils/slug-utils.isArxivId). */
const ARXIV_ID_RE = /^\d{4}\.\d{4,5}$/;
/**
 * V27.94 (FIX A): content-hash paper shape. Content-hash papers (~3.2%) have no
 * native arxiv id, so they store slug='unknown--<sha>' (id arxiv-paper--unknown--<sha>)
 * and their /paper/<sha> URL emits the BARE sha. A bare sha is pure hex with no
 * `--`/`/` separator and no `.` (so it cannot collide with the arxiv-id shape or
 * any normal `author--name`/`author/name` slug, which always carry non-hex chars
 * or separators). 32 = md5, 40 = sha1; both observed in the corpus.
 */
const CONTENT_HASH_RE = /^[0-9a-f]{32,40}$/;
/** Source prefixes that indicate a paper lookup even with a prefix present. */
const PAPER_PREFIXES = ['arxiv-paper', 'arxiv', 'paper', 'hf-paper'];

/**
 * V27.93: detect whether a raw entity id should be treated as a paper lookup.
 * True for a bare arxiv id (2604.22294), a bare content-hash sha (V27.94 FIX A),
 * or any paper-source-prefixed form (arxiv--<id>, arxiv-paper--<id>, paper:<id>,
 * hf-paper/<id>). For a bare sha, looksLikePaper=true routes it through
 * generatePaperCandidates which injects the matching stored 'unknown--<sha>' form
 * (the extra 'arxiv--<sha>'/bare candidates are harmless misses, +1 cold shard).
 */
export function looksLikePaper(rawId: string): boolean {
    const lower = (rawId || '').toLowerCase();
    if (ARXIV_ID_RE.test(lower)) return true;
    if (CONTENT_HASH_RE.test(lower)) return true;
    return PAPER_PREFIXES.some(p =>
        lower.startsWith(`${p}--`) || lower.startsWith(`${p}:`) || lower.startsWith(`${p}/`)
    );
}

/**
 * V27.93 (D1+D2): ordered probe plan for /api/v1/entity/:id.
 *
 * Returns candidates ordered HIGHEST-probability first so a wall-clock budget
 * in a FLAT (non-primary-first) probe loop never bails before reaching the
 * shard that actually holds the entity (the page-resolver asymmetry trap:
 * the page resolver probes a privileged primary shard first, this API does
 * not, so order must be enforced here instead).
 *
 * Order: (1) exact lowered input + slash-normalized form (caller passed the
 * stored id/slug), (2) derived canonical slug, (3) for paper-shaped inputs the
 * stored paper forms (arxiv--<id>, bare, unknown--<id>) via generatePaperCandidates,
 * (4) AUTO_PREFIX fan-out LAST — and for paper inputs trimmed to paper prefixes
 * only, so we never blindly open ~10 cold non-paper shards for a paper id.
 */
export function buildEntityProbePlan(rawId: string): string[] {
    const lower = (rawId || '').toLowerCase();
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (c: string | undefined | null) => {
        if (c && !seen.has(c)) { seen.add(c); ordered.push(c); }
    };

    add(lower);
    add(lower.replace(/\//g, '--').replace(/--+/g, '--'));
    const slug = deriveSlug(rawId);
    add(slug);

    const isPaper = looksLikePaper(rawId);
    if (isPaper && slug) {
        for (const c of generatePaperCandidates(slug)) add(c);
    }

    const hasPrefix = SLUG_PREFIXES.some(p =>
        lower.startsWith(`${p}--`) || lower.startsWith(`${p}:`) || lower.startsWith(`${p}/`)
    );
    if (!hasPrefix && slug) {
        // Fan-out LAST. For paper-shaped ids the stored forms above already
        // cover the corpus, so skip the non-paper AUTO_PREFIX cold-shard storm.
        if (!isPaper) {
            for (const p of AUTO_PREFIXES) add(`${p}--${slug}`);
        }
    }
    return ordered;
}
