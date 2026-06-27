# Changelog

All notable changes to `@free2aitools/sdk` are documented here. The format is
based on Keep a Changelog; this package follows SemVer (pre-1.0: `0.x` minors may
break, patches are compatible fixes).

## [0.1.0] — unreleased (first version, prepared; not yet published)

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

### Changed

- Packaging hardening (no runtime/API behavior change): added MIT `LICENSE`
  file (matching the long-standing README MIT claim) and shipped it in the
  package; added `repository`, `homepage`, and `bugs` publish metadata; dropped
  emitted source maps (`sourceMap`/`declarationMap` off) so the archive no
  longer references unshipped `src/`. `private: true` is retained — this is not
  a publish.
- Publish-prep metadata: added `publishConfig.access: public` (scoped public
  package), `author`, and a defensive `prepublishOnly` build hook. `private:
  true` is retained as the accidental-publish guard.

### Notes

- Package name `@free2aitools/sdk` is CONFIRMED; the npm org `free2aitools` is
  created and the `@free2aitools` scope is reserved. The package is **not yet
  published** (publication pending Founder authorization) and remains `private`
  (accidental-publish guard).
- `rank` and `explain` are MCP-only and intentionally NOT exposed as REST methods.
