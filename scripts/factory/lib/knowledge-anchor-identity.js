/**
 * Knowledge Anchor Article Admission (meta-knowledge.db identity gate)
 *
 * `buildKnowledgeDb()` in meta-anchors.js indexes `output/cache/knowledge/`
 * into meta-knowledge.db. Every row it writes is stamped `status='published'`
 * and a `https://free2aitools.com/knowledge/<slug>` canonical_url, and three
 * public surfaces consume those rows as if a page existed behind each one:
 * the sitemap (sitemap-generator.js §2b), the /knowledge hub listing, and the
 * machine-readable /api/v1/concepts endpoint.
 *
 * That cache directory does NOT hold only articles. knowledge-data-generator.js
 * writes its own catalog `index.json` and telemetry `stats.json` there through
 * smart-writer.js, which additionally leaves `.v-1`/`.v-2` rotations and
 * `.meta.json` checksum sidecars beside them. Real articles are ALSO written
 * here, at `articles/<slug>.json.zst` (knowledge-data-generator.js:132-133); the
 * `output/cache/fused/` copy written at :155-158 is a second copy for VFS
 * packing, not the only one.
 *
 * Measured defect this gate closes: `stats.json.zst` was admitted as an
 * article. The previous id fallback stripped only `.json`/`.json.gz` — never
 * `.json.zst` — so the id became the literal filename and slug sanitisation
 * mapped `.` to `-`, publishing `/knowledge/stats-json-zst`. That URL is a live
 * 404 (src/pages/knowledge/[slug].astro resolves nothing for it in any of its
 * three sources) yet it was carried in the sitemap and served by
 * /api/v1/concepts as a titleless "concept".
 *
 * This module is the single admission rule. It is pure and side-effect free so
 * the rule can be asserted directly rather than inferred from pipeline output.
 *
 * @module scripts/factory/lib/knowledge-anchor-identity
 */

// The three payload shapes smart-writer.js can emit for one logical key.
const ARTICLE_EXT = /\.json(?:\.gz|\.zst)?$/;

// smart-writer.js rotates 3 versions: `<base>.v-1<ext>` and `<base>.v-2<ext>`.
// A rotation is a previous copy of its base key, never a separate article.
const ROTATION_SUFFIX = /\.v-\d+$/;

/**
 * Basenames the knowledge cache generator writes for its OWN bookkeeping.
 * `index` = the article catalog array; `stats` = the run telemetry object.
 * Neither is an article, at any nesting depth.
 */
export const RESERVED_KNOWLEDGE_BASENAMES = Object.freeze(['index', 'stats']);

/**
 * Does this entry's NAME look like a JSON payload rather than a `.meta.json`
 * checksum sidecar? It filters candidates by name and does nothing else: it
 * does not stat the path, so a DIRECTORY named `foo.json` passes (measured:
 * isKnowledgeJsonFile('adir.json') === true for a directory on disk) and the
 * caller's fs.readFile then throws EISDIR. It sizes the candidate set, so an
 * entry whose name does not match never reaches buildKnowledgeDb's counters.
 *
 * This module is consulted at two different points, and they feed different
 * counters. This name filter runs first, in buildKnowledgeDb's
 * `files.filter(...)`; entries it drops reach no counter. Later, inside the
 * try, knowledgeArticleIdentity() runs, and its rejections are logged on their
 * own as `non-article candidate(s) excluded by the identity gate`. That is a
 * different bucket from `candidate(s) failed during processing`, which counts
 * whatever threw inside that try -- including read, decompress and parse
 * failures, which occur before knowledgeArticleIdentity() is reached. Neither
 * count is a measure of the other, and neither is a count of articles lost.
 *
 * Until the two were split they shared one counter, and the line read
 * `0 articles indexed, 32 candidate(s) rejected` over the 29 real
 * `src/pages/knowledge/*.md` sources plus 3 cache artifacts -- a pre-split
 * measurement under those source conditions, recorded as the reason for the
 * split. It is not a measurement of the current code or of production.
 * @param {string} file - path relative to the knowledge cache dir
 * @returns {boolean}
 */
export function isKnowledgeJsonFile(file) {
    const name = basenameOf(file);
    if (!name || name.includes('.meta')) return false;
    return ARTICLE_EXT.test(name);
}

/**
 * Filename-derived article id, or null when the filename identifies something
 * that is not an article. Mirrors the historical fallback (extension stripped
 * from the cache-relative path, so nested `ai/foo.json.zst` keeps its `ai/foo`
 * form) but strips `.json.zst` too, which the previous regex did not.
 * @param {string} file - path relative to the knowledge cache dir
 * @returns {string|null}
 */
export function knowledgeArticleId(file) {
    if (!isKnowledgeJsonFile(file)) return null;
    const rel = normalize(file);
    const base = basenameOf(rel).replace(ARTICLE_EXT, '');
    if (!base) return null;
    if (ROTATION_SUFFIX.test(base)) return null;
    if (RESERVED_KNOWLEDGE_BASENAMES.includes(base)) return null;
    return rel.replace(ARTICLE_EXT, '');
}

/**
 * Does this parsed payload look like an article rather than a catalog array or
 * a telemetry blob? An array is never an article, and a payload with no title
 * cannot be rendered or honestly listed — a titleless row is exactly the
 * "empty-title rows in meta-knowledge.db" class the cache scan has produced.
 * @param {unknown} payload
 * @returns {boolean}
 */
export function isKnowledgeArticlePayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const title = /** @type {{title?: unknown}} */ (payload).title;
    return typeof title === 'string' && title.trim() !== '';
}

/**
 * The full admission decision: `{ id, slug }` for an admissible article, or
 * null. Identity precedence is unchanged from the historical code — declared
 * `id`, then declared `slug`, then the filename — and so is the slug
 * sanitisation expression.
 *
 * Canonical-URL continuity is NOT universal; it holds for payloads whose `id` or
 * `slug` is already a clean string. Measured old-vs-new over 10 realistic input
 * shapes, 5 produce the same slug (clean `slug`; clean `id`; both; uppercase
 * `id`, which stays equally broken at `----asics`; empty `id` falling through to
 * a clean `slug`) and 5 drift:
 *   filename fallback   `articles-lora-json-zst` -> `articles-lora` (the `.zst`
 *                        strip this module exists to fix)
 *   whitespace-padded `id` or `slug`  `--lora--` -> `lora`
 *   trailing-newline `id`             `lora-`    -> `lora`
 *   non-string `id`      old threw a TypeError   -> now admits `articles-lora`
 * A drifting shape changes which unresolvable slug is produced; it is not a
 * claim that the new one resolves (`articles-lora` has no route either). No
 * resolving URL is at risk here because none exists to lose: production's
 * meta-knowledge.db holds exactly one row, `/knowledge/stats-json-zst`, and that
 * URL is itself a 404. Over the actual corpus the question is moot — all 29
 * `src/pages/knowledge/*.md` articles carry a clean `slug` and no `id`, and 0 of
 * 29 drift.
 * @param {string} file - path relative to the knowledge cache dir
 * @param {unknown} payload - the parsed JSON payload of that file
 * @returns {{id: string, slug: string}|null}
 */
export function knowledgeArticleIdentity(file, payload) {
    const fromFile = knowledgeArticleId(file);
    if (fromFile === null) return null;
    if (!isKnowledgeArticlePayload(payload)) return null;
    const p = /** @type {{id?: unknown, slug?: unknown}} */ (payload);
    const declared = trimmedString(p.id) || trimmedString(p.slug);
    const id = declared || fromFile;
    return { id, slug: id.replace(/[^a-z0-9-]/g, '-') };
}

function normalize(file) {
    return String(file ?? '').replace(/\\/g, '/');
}

function basenameOf(file) {
    const rel = normalize(file);
    return rel.slice(rel.lastIndexOf('/') + 1);
}

function trimmedString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : '';
}
