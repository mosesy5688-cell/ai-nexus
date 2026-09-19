/**
 * Work order G -- /ranking public entity-count correction (honest contract).
 *
 * DEFECT (live on a public page): src/pages/ranking/index.astro rendered a
 * per-category entity count on five badges, e.g. "4,412 Models". The number came
 * from a GROUP BY over the SINGLE shard meta-00.db, while meta-*.db is
 * META_SHARD_COUNT = 96 hash-distributed shards (src/constants/shard-constants.js).
 * A 1/96 sample was therefore published as the category total with no disclosure.
 *
 * FIX: the five counts AND the dedicated VFS query chain (loadManifest /
 * getCachedDbConnection('meta-00.db') / executeSql(... GROUP BY category ...)) are
 * REMOVED. The five category entries are kept and the badge slot carries the
 * pre-existing `Explore` affordance. A replacement count is explicitly NOT
 * permitted (no cross-shard scan, no cached/precomputed count, and no
 * "single-shard count x 96" extrapolation).
 *
 * This guard is HERMETIC. It (a) EXECUTES the page's real CATEGORY_META object
 * literal to prove all five category entries still render with all four fields,
 * and (b) resolves the badge slot out of the page template and proves it is a
 * STATIC TEXT NODE equal to `Explore` -- no Astro expression, therefore the
 * rendered badge text for EVERY category is exactly that literal.
 *
 * Anti-vacuity: every locator throws (red) if it cannot bind, so a renamed badge
 * or a deleted CATEGORY_META fails loudly instead of passing empty.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../..');
const PAGE_REL = 'src/pages/ranking/index.astro';
const SRC = fs.readFileSync(path.join(ROOT, PAGE_REL), 'utf-8');

const FENCE = '---';
const EXPECTED_KEYS = [
    'text-generation', 'knowledge-retrieval', 'vision-multimedia',
    'automation-workflow', 'infrastructure-ops'
];
// The badge <span> is addressed by its existing utility classes (G-3 forbids
// renaming them, so this anchor is stable and its loss is a real failure).
const BADGE_ANCHOR = 'rounded-full border border-blue-100/50';

function frontmatter(src: string): string {
    if (!src.startsWith(FENCE)) throw new Error('page has no frontmatter fence');
    const end = src.indexOf('\n' + FENCE, FENCE.length);
    if (end < 0) throw new Error('frontmatter fence is not closed');
    return src.slice(FENCE.length, end);
}

function template(src: string): string {
    const end = src.indexOf('\n' + FENCE, FENCE.length);
    if (end < 0) throw new Error('frontmatter fence is not closed');
    return src.slice(end + FENCE.length + 1);
}

type CategoryEntry = { label: string; icon: string; description: string; href: string };

/** Extract and EXECUTE the page's own CATEGORY_META object literal. */
function categoryMeta(fm: string): Record<string, CategoryEntry> {
    const decl = fm.indexOf('const CATEGORY_META');
    if (decl < 0) throw new Error('CATEGORY_META declaration not found');
    const open = fm.indexOf('= {', decl);
    if (open < 0) throw new Error('CATEGORY_META initializer not found');
    let depth = 0;
    let end = -1;
    for (let i = open + 2; i < fm.length; i++) {
        if (fm[i] === '{') depth++;
        else if (fm[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error('CATEGORY_META object literal is not balanced');
    return new Function('return (' + fm.slice(open + 2, end + 1) + ');')();
}

/** Inner source of the badge <span>. */
function badgeSlot(tpl: string): string {
    const anchor = tpl.indexOf(BADGE_ANCHOR);
    if (anchor < 0) throw new Error('badge span not found (anchor: ' + BADGE_ANCHOR + ')');
    const openEnd = tpl.indexOf('>', anchor);
    const close = tpl.indexOf('</span>', openEnd);
    if (openEnd < 0 || close < 0) throw new Error('badge span is not closed');
    return tpl.slice(openEnd + 1, close);
}

const FM = frontmatter(SRC);
const TPL = template(SRC);

describe('work order G -- /ranking badge locators bind (anti-vacuity)', () => {
    it('the page, its CATEGORY_META literal and its badge span all resolve', () => {
        expect(SRC.length).toBeGreaterThan(0);
        expect(Object.keys(categoryMeta(FM)).length).toBe(5);
        expect(badgeSlot(TPL).length).toBeGreaterThan(0);
    });
});

describe('G-1/G-3 -- the badge renders `Explore`, never an entity count', () => {
    const slot = badgeSlot(TPL);

    it('the badge slot is a STATIC TEXT NODE (no Astro expression)', () => {
        // No `{`/`}` in the slot means the compiler emits the literal verbatim:
        // the SOURCE text below IS the rendered text, for every category.
        expect(slot).not.toContain('{');
        expect(slot).not.toContain('}');
    });

    it('the rendered badge text is exactly `Explore`', () => {
        expect(slot.trim()).toBe('Explore');
    });

    it('the badge carries no digit, no count word and no number formatting', () => {
        expect(/[0-9]/.test(slot)).toBe(false);
        expect(slot).not.toContain('Models');
        expect(slot).not.toContain('toLocaleString');
    });

    it('no entity count is rendered anywhere in the page template', () => {
        expect(TPL).not.toContain('categoryCounts');
        expect(TPL).not.toContain('toLocaleString');
        expect(TPL).not.toContain(' Models');
    });
});

describe('G-2 -- all five category entries are kept, with all four fields', () => {
    const meta = categoryMeta(FM);

    it('exactly the five expected category keys are present', () => {
        expect(Object.keys(meta).sort()).toEqual([...EXPECTED_KEYS].sort());
    });

    it('every entry has a non-empty label / icon / description / href', () => {
        for (const key of EXPECTED_KEYS) {
            const entry = meta[key];
            expect(entry, key + ' entry must exist').toBeTruthy();
            for (const field of ['label', 'icon', 'description', 'href'] as const) {
                expect(typeof entry[field], key + '.' + field).toBe('string');
                expect(entry[field].length, key + '.' + field + ' must be non-empty').toBeGreaterThan(0);
            }
        }
    });

    it('the grid renders from CATEGORY_META itself, so all five entries render', () => {
        expect(TPL).toMatch(/Object\.(values|entries)\(CATEGORY_META\)\s*\.map\(/);
        expect(TPL).toContain('{meta.label}');
        expect(TPL).toContain('{meta.icon}');
        expect(TPL).toContain('{meta.description}');
        expect(TPL).toContain('{meta.href}');
    });
});

describe('G-4/G-5 -- the dedicated shard query and its dead scaffolding are gone', () => {
    it('the meta-00.db GROUP BY chain no longer exists in this route', () => {
        for (const token of [
            'loadManifest', 'getCachedDbConnection', 'executeSql',
            'meta-00.db', 'GROUP BY category', 'sqlite-engine'
        ]) {
            expect(SRC, PAGE_REL + ' must not contain ' + token).not.toContain(token);
        }
    });

    it('no count scaffolding or now-unused binding is left behind', () => {
        for (const token of [
            'categoryCounts', 'r2Bucket', 'shouldSimulate', 'isDev',
            "from 'cloudflare:workers'", 'R2_ASSETS'
        ]) {
            expect(FM, 'frontmatter must not contain ' + token).not.toContain(token);
        }
    });

    it('no replacement count source was introduced (F-1/F-2)', () => {
        for (const token of ['category_stats', 'shard-constants', 'total_entities', 'fetch(']) {
            expect(FM, 'frontmatter must not contain ' + token).not.toContain(token);
        }
    });
});

describe('G-6/G-7 -- untouched invariants', () => {
    it('the edge Cache-Control header line is preserved byte-identically', () => {
        expect(SRC).toContain(
            "Astro.response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate, s-maxage=3600, stale-while-revalidate=604800');"
        );
    });

    it('the route rendering mode is unchanged (no prerender directive added)', () => {
        expect(SRC).not.toContain('prerender');
    });
});

/**
 * G-1, whole-card guard. The `Explore` assertions above address the ONE badge
 * span via its class anchor. A count re-introduced as a SIBLING element beside
 * that badge slips past them: the mutant that appends `<span>4,412</span>` next
 * to the badge was measured GREEN against the anchored assertions alone. This
 * block therefore guards the WHOLE repeated category card -- every text node it
 * renders must come from `meta`, so neither a literal number nor an
 * un-allowlisted expression can reach the page anywhere inside the card.
 */
const ALLOWED_CARD_EXPRESSIONS = ['{meta.icon}', '{meta.label}', '{meta.description}'];

/** Inner source of the #ranking-grid container = the repeated category card. */
function cardRegion(tpl: string): string {
    const grid = tpl.indexOf('id="ranking-grid"');
    if (grid < 0) throw new Error('#ranking-grid container not found');
    const inner = tpl.indexOf('>', grid);
    const end = tpl.indexOf('))}', inner);
    if (inner < 0 || end < 0) throw new Error('category card region is not delimited');
    return tpl.slice(inner + 1, end);
}

/** Card text nodes only: drop tags, the map header, and the allowed `meta` reads. */
function cardResidue(tpl: string): string {
    let residue = cardRegion(tpl).replace(/<[^>]*>/g, ' ');
    residue = residue.replace(/\{Object\.(?:values|entries)\(CATEGORY_META\)[^\n]*/, ' ');
    for (const expr of ALLOWED_CARD_EXPRESSIONS) residue = residue.split(expr).join(' ');
    return residue;
}

describe('G-1 (whole card) -- no count reaches the card, even beside the badge', () => {
    it('the card region and its text residue resolve (anti-vacuity)', () => {
        expect(cardRegion(TPL).length).toBeGreaterThan(0);
        expect(cardResidue(TPL)).toContain('Explore');
    });

    it('no literal number is rendered anywhere in the category card', () => {
        expect(/[0-9]/.test(cardResidue(TPL))).toBe(false);
    });

    it('the card renders no expression other than the allowlisted `meta` reads', () => {
        expect(cardResidue(TPL)).not.toContain('{');
    });

    it('the card injects no raw HTML that could smuggle a count past this guard', () => {
        expect(cardRegion(TPL)).not.toContain('set:html');
    });
});
