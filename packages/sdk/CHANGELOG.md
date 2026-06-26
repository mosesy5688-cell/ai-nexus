# Changelog

All notable changes to `@free2aitools/sdk` are documented here. The format is
based on Keep a Changelog; this package follows SemVer (pre-1.0: `0.x` minors may
break, patches are compatible fixes).

## [0.1.0]

### Changed

- Packaging hardening (no runtime/API behavior change): added MIT `LICENSE`
  file (matching the long-standing README MIT claim) and shipped it in the
  package; added `repository`, `homepage`, and `bugs` publish metadata; dropped
  emitted source maps (`sourceMap`/`declarationMap` off) so the archive no
  longer references unshipped `src/`. `private: true` is retained — this is not
  a publish.

## [Unreleased]

### Added

- SDK-0: initial TypeScript REST client (`Free2AIClient`).
- Methods: `health`, `search`, `getEntity`, `select`, `compare`, `getConcepts`,
  `getTrendsBatch`, `listDatasets`, plus local helpers `getEntityEvidence`
  (no network) and `badgeUrl` (pure URL builder).
- Typed requests + non-exhaustive (append-only-tolerant) response types.
- Error hierarchy: `Free2AIError` + `Free2AIRequestError`,
  `Free2AIValidationError`, `Free2AIRateLimitError`, `Free2AIUnavailableError`,
  `Free2AINotFoundError`, `Free2AITimeoutError`.
- Finite, abortable, `Retry-After`-respecting retry for idempotent GET only;
  per-request timeout; injectable fetch; client + per-call `AbortSignal`.

### Notes

- Package name `@free2aitools/sdk` is a CANDIDATE (npm name/org ownership not yet
  verified). Package is `private` (no accidental publish).
- `rank` and `explain` are MCP-only and intentionally NOT exposed as REST methods.
