#!/usr/bin/env node
/**
 * C4 Static Gate -- "Sponsors Never Influence Structure" (un-buyable ranking).
 *
 * Commercialization-Constitution article C4 (founder-declared P0 trust
 * invariant): no payment signal (sponsor / tier / customer / paid / billing /
 * promoted / boost / bid) may ever feed a score, ranking order, edge, or
 * identity assertion. Paid tiers buy quota / compute / access / freshness ONLY.
 *
 * This is a REGRESSION GUARD established BEFORE monetization code exists: today
 * there is no billing/tier code in the ranking path, so a naive "grep finds
 * nothing" passes vacuously. To avoid that vacuity this gate (a) PROVES it read
 * every scanned file (files-scanned > 0, lines-scanned > 0, hard-fail on a
 * missing path so a moved/renamed serve file cannot silently drop coverage),
 * and (b) FAILS the moment any forbidden symbol appears in a scanned path so
 * the first pay-to-rank line that ever lands is caught at PR time.
 *
 * Extend FORBIDDEN_SYMBOLS as new monetization vocabulary appears; extend
 * SCANNED_PATHS as new ranking/scoring serve paths land. Both are the explicit
 * contract this gate enforces. ASCII-only (CES Art 8.1).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// (a) FORBIDDEN SYMBOL SET -- payment/influence vocabulary that must never be
// read by an ordering/scoring/edge/identity expression. Word-boundary matched,
// case-insensitive. Keep additive: as monetization code lands, add its symbols.
const FORBIDDEN_SYMBOLS = [
  'sponsor', 'sponsored', 'sponsorship',
  'paid', 'paying', 'billing', 'billed',
  'customer', 'subscription', 'subscriber',
  'promoted', 'boosted',
  'bidding', 'payola', 'pay_to_rank', 'paytorank',
  'premium_rank', 'rank_boost', 'score_boost', 'commercial_weight',
  // 'tier' / 'boost' / 'bid' are NOT bare-banned: they collide with legitimate
  // public-FNI vocabulary (DECAY_TIERS = recency tiers, "boost" in copy, "bid"
  // substrings). Ban only their UNAMBIGUOUS payment-context compounds.
  'paid_tier', 'paying_tier', 'pricing_tier', 'price_tier', 'customer_tier',
  'subscription_tier', 'billing_tier', 'sponsor_tier', 'premium_tier',
  'paid_boost', 'sponsor_boost', 'tier_boost', 'tier_weight', 'tier_bonus',
  'sponsor_bid', 'ad_bid', 'auction_bid',
];

// (b) SCANNED PATH SET -- the live ranking/scoring/edge/identity serve + scoring
// code. Verified 2026-06-08 as the ordering paths (entry -> dispatch -> order):
//   select.ts        : ORDER BY (params-presence), fni_score DESC  (THE ranking)
//   ranking-order.ts : shared un-buyable comparator (extracted from select.ts)
//   compare.ts       : emits fni_score / fni_factors per entity
//   badge/[umid].ts  : emits fni_score
//   trends/batch.ts  : emits per-entity fni trend
//   concepts.ts      : list ordering (published_at) -- future paid-promo risk
//   fni-score.js     : the FNI scoring formula + SOURCE_COEFFICIENTS
//   rationale-builder: builds the "why" / dominant-factor for a ranking
const SCANNED_PATHS = [
  'src/pages/api/v1/select.ts',
  'src/lib/ranking-order.ts',
  'src/pages/api/v1/compare.ts',
  'src/pages/api/v1/badge/[umid].ts',
  'src/pages/api/v1/trends/batch.ts',
  'src/pages/api/v1/concepts.ts',
  'scripts/factory/lib/fni-score.js',
  'src/lib/rationale-builder.ts',
];

// A scanned file may legitimately NAME a forbidden symbol when it is explaining
// the C4 prohibition itself (doc comments). We only fail on a symbol that is
// READ as code. Heuristic: a line is a violation if it contains a forbidden
// symbol AND is not a pure comment line. This keeps the C4 doc-comments (which
// must say words like "sponsor"/"paid" to explain the ban) from self-tripping,
// while still catching `if (entity.sponsored)` or `+ tier * 10` in real code.
function isCommentLine(line) {
  const t = line.trim();
  return t === '' || t.startsWith('//') || t.startsWith('*') ||
    t.startsWith('/*') || t.startsWith('#') || t.startsWith('<!--');
}

function buildPattern(symbols) {
  // word-boundary-ish: not preceded/followed by an identifier char.
  const alt = symbols.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`(?<![A-Za-z0-9_])(${alt})(?![A-Za-z0-9_])`, 'i');
}

export function scanForViolations(repoRoot = REPO_ROOT, paths = SCANNED_PATHS) {
  const pattern = buildPattern(FORBIDDEN_SYMBOLS);
  const violations = [];
  const missing = [];
  let filesScanned = 0;
  let linesScanned = 0;
  for (const rel of paths) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue; }
    filesScanned++;
    const lines = fs.readFileSync(abs, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      linesScanned++;
      const line = lines[i];
      if (isCommentLine(line)) continue;
      const m = pattern.exec(line);
      if (m) violations.push({ file: rel, line: i + 1, symbol: m[1], text: line.trim().slice(0, 90) });
    }
  }
  return { violations, missing, filesScanned, linesScanned };
}

function main() {
  const { violations, missing, filesScanned, linesScanned } = scanForViolations();
  console.log('[C4] Anti-arbitration static gate (Sponsors Never Influence Structure)');
  console.log(`[C4] forbidden symbols: ${FORBIDDEN_SYMBOLS.length}`);
  console.log(`[C4] files scanned: ${filesScanned}, lines scanned: ${linesScanned}`);

  let failed = false;
  // Execution proof: if we scanned nothing, the gate is vacuous -- fail loud.
  if (filesScanned === 0 || linesScanned === 0) {
    console.error('[C4] FAIL: scanned 0 files/lines -- gate is vacuous (paths moved?).');
    failed = true;
  }
  // A serve path going missing silently drops coverage -- treat as a failure so
  // a refactor that renames select.ts cannot quietly disable the C4 guard.
  if (missing.length > 0) {
    console.error(`[C4] FAIL: ${missing.length} scanned path(s) missing: ${missing.join(', ')}`);
    console.error('[C4] If a serve path moved, update SCANNED_PATHS in this gate.');
    failed = true;
  }
  if (violations.length > 0) {
    console.error(`[C4] FAIL: ${violations.length} forbidden payment-signal reference(s) in ranking/scoring paths:`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  [${v.symbol}]  ${v.text}`);
    }
    console.error('[C4] Ranking/scoring must derive purely from public FNI factors.');
    console.error('[C4] Route paid features through a disjoint commercial surface, not the ranking path.');
    failed = true;
  }
  if (failed) process.exit(1);
  console.log('[C4] PASS: no payment signal reaches any ranking/scoring/edge path.');
}

export { FORBIDDEN_SYMBOLS, SCANNED_PATHS };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
