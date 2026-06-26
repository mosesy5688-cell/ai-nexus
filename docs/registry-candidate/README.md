# MCP Registry submission CANDIDATE (REVIEW ONLY — NOT PUBLISHED)

`server.json` in this directory is a **review-only candidate** for a future
submission to the official Model Context Protocol Registry
(`modelcontextprotocol/registry`). It is prepared under Founder directive
**D-135, Lane C (F1)**.

## Status

- **NOT PUBLISHED.** No submission to the official MCP Registry has been made.
- This file is intentionally placed at a **non-served docs path**. It is NOT
  served by the site and does **not** replace
  `public/.well-known/mcp.json` — that served file is the site-local MCP
  manifest (tool catalog) and has a different role.
- **`IDENTITY_OWNERSHIP_UNVERIFIED`** — the `com.free2aitools/...` namespace is
  not yet proven/controlled in the official Registry. Namespace ownership
  (DNS- or GitHub-based authentication, per the Registry's namespace rules)
  MUST be verified before any publish step.

## Schema

Built against the current official schema cited in the candidate:
`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`
(remote-server form: `remotes: [{ "type": "streamable-http", "url": ... }]`).

Field shape was validated against the cited schema's required/optional fields.
The official Registry CLI / `publish` dry-run was **not** run in this
environment, so end-to-end registry validation is marked **UNVERIFIED**.

## Version coupling (Lane B)

The candidate `version` is the **MCP server** version domain. It is set to
`2.0.1` as a forward-looking value coupled to Lane B. If Lane B does not bump
the served MCP server version to `2.0.1`, this candidate MUST be reconciled to
the actually-served version (`2.0.0`). See the version-domain note in
`/developers` — SDK / MCP-server / OpenAPI / app / FNI versions are **distinct
domains** and must not be forced into numeric equality.

## Before any publication

1. Verify namespace ownership in the official Registry.
2. Reconcile `version` with the actually-served Lane-B MCP server version.
3. Run the official Registry CLI validation / publish dry-run.
4. Obtain Founder authorization (D-135 requires STOP-BEFORE-PUBLISH).
