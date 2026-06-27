# @free2aitools/sdk

A free, public **TypeScript SDK** for the [Free2AITools](https://free2aitools.com)
AI discovery / evidence / identity **REST API**.

It retrieves **candidates, evidence, and FNI rankings** so an agent or app can
reason over them. It is built on standard Web APIs (`fetch`, `AbortController`,
`URL`, `URLSearchParams`) and has **zero runtime dependencies**.

> ## Honesty notes (please read)
>
> - **Caller makes the final decision.** Every method *retrieves* candidates,
>   evidence, and rankings. It does **not** assert "the best model", guarantee
>   compatibility, or make the final choice for you. The FNI factor breakdown is
>   *factual evidence*, not a verdict.
> - **Free is not unlimited.** The public API may return honest **503**
>   (transient / cold-path) responses. The SDK surfaces these as **typed errors**
>   — never as an empty array, `null`, or a fake `{ success: true }`. A `404`
>   means *proven absence*; a `503` means *try again*. They are never collapsed.
> - **No auth, no telemetry, no analytics, no ads.** The API is unauthenticated;
>   the SDK sends no API key and emits no telemetry or hidden requests.

## Package name + status

- **Package name is CONFIRMED:** `@free2aitools/sdk`. The npm org
  `free2aitools` is **created** and the `@free2aitools` scope is reserved.
- **Not yet published.** The package is **not** on npm yet; publication is
  pending Founder authorization and gated separately (D-125), out of scope here.
- The package is **`"private": true`** for now to prevent accidental publish.
  That guard is removed only at the later, authorized publish step.

## Install (available once published)

```bash
npm install @free2aitools/sdk   # confirmed name; available once published
```

## Usage

```ts
import { Free2AIClient } from "@free2aitools/sdk";

const client = new Free2AIClient(); // defaults to https://free2aitools.com

const results = await client.search({ q: "small coding model", limit: 5 });
for (const r of results.results) {
  // r.fni_score is evidence; r.fni_s is ALWAYS null (query-time baseline).
  console.log(r.name, r.fni_score);
}
```

### Configuration

```ts
const client = new Free2AIClient({
  baseUrl: "https://free2aitools.com", // override if you self-host a mirror
  fetch: myFetch,                       // inject your own fetch
  timeoutMs: 30_000,                    // per-request timeout (default 30s)
  signal: controller.signal,            // client-level AbortSignal
  retry: { attempts: 3 },               // idempotent-GET retry; attempts<=1 disables
});
```

## Methods (REST)

| Method | Endpoint | Notes |
| --- | --- | --- |
| `health()` | `GET /api/v1/health` | Per-isolate snapshot (not a global metric). |
| `search(req)` | `GET /api/v1/search` | Default limit **5**, 1-based `page`. No snapshot consistency. |
| `getEntity(req)` | `GET /api/v1/entity/{id}` | Tolerant id; `404` = absent, `503` = transient. |
| `select(req)` | `POST /api/v1/select` | Task + constraints. **POST = no auto-retry.** |
| `compare(req)` | `GET /api/v1/compare` | 2..25 ids; `found:false` = honest absence. |
| `getConcepts(req)` | `GET /api/v1/concepts` | **Offset/limit** pagination (not page-based). |
| `getTrendsBatch(req)` | `GET /api/v1/trends/batch` | 1..25 ids; `missing[]` = honest absence. |
| `listDatasets(req)` | `GET /api/v1/datasets` | Listing; returns URLs, does not stream bytes. |
| `getEntityEvidence(resp)` | *(local)* | Re-shapes evidence from a `getEntity()` response. No network. |
| `badgeUrl(idOrSlug)` | *(local)* | Pure URL builder. Does not fetch. |

### Not in this SDK: `rank` and `explain`

`rank` and `explain` exist **only as MCP tools** — there is **no REST route** for
them. The SDK does **not** invent one (that would be a server change, out of
scope). For an FNI factor breakdown without a remote call, use
`getEntityEvidence()` (it re-shapes the evidence `getEntity()` already returns).
To reach `rank`/`explain`, use an MCP client (see below).

## Retry / timeout / abort

- **Retry** is restricted to **idempotent GET** and triggers on network blip /
  `429` / `503`. It respects `Retry-After`, uses bounded backoff with jitter, has
  **finite** attempts, is **abortable**, and can be disabled (`retry:{attempts:1}`).
  `400` and `404` are **never** retried. `select()` is `POST` and is **never**
  auto-retried, even on `503`.
- **Timeout** is per-request (default 30s) via an internal `AbortController`;
  on expiry it throws `Free2AITimeoutError`.
- **Abort** is honored at both the client level (`options.signal`) and per call
  (`{ signal }`). Aborting never yields a fake empty result.

## Error model

```
Free2AIError                (base — carries status, retryAfterSeconds, body, cause, context)
 - Free2AIRequestError      (HTTP 400)
 - Free2AIValidationError   (client-side, request NOT sent)
 - Free2AIRateLimitError    (HTTP 429)
 - Free2AIUnavailableError  (HTTP 503 — transient)
 - Free2AINotFoundError     (HTTP 404 — proven absence)
 - Free2AITimeoutError      (timeout / abort)
```

Every error preserves HTTP status, `Retry-After`, the service error body, the
original cause, and a **sanitized** request context (method + path + primitive
params only — never bodies or secrets).

## Unknown additive fields

The catalog is **append-only / ever-growing**, so all response types are
**non-exhaustive**. Known fields are typed; unknown additive fields are
**preserved** (never stripped, never throws on extra keys).

## Supported runtimes

Tested with mocked + live fetch on **Node.js 22+** (older LTS lines that have
reached end-of-life are no longer a supported runtime). Supported runtime floor:
**Node 22**; the consumer matrix is exercised on **Node 22** and **Node 24**.
The implementation uses only
standard Web APIs, so it is expected to work on **Cloudflare Workers** and
**modern browsers** (API is CORS `*`) — list those as supported only after you
run the bundle tests in those targets. Deno/Bun: experimental until tested.

## MCP config example

For the MCP ecosystem (including `rank`/`explain`), point a standard MCP client
at the Free2AITools MCP endpoint. The SDK ships **config examples only** — no
proprietary MCP transport.

```json
{
  "mcpServers": {
    "free2aitools": {
      "type": "http",
      "url": "https://free2aitools.com/api/mcp"
    }
  }
}
```

Canonical tool list: `https://free2aitools.com/.well-known/mcp.json`.

## Versioning + compatibility policy

- **SemVer.** Pre-1.0 (`0.x`): minor versions may include breaking changes;
  patch versions are backward-compatible fixes.
- **API-compatibility policy.** The SDK tracks the public REST contract. Because
  the dataset is append-only, additive response fields are **non-breaking** and
  tolerated automatically. A change to a route, param, limit, default, error
  semantic, or a removed required field is treated as **breaking** and gated
  behind a major (or, pre-1.0, a minor) bump with a changelog entry.

## Changelog

See [`CHANGELOG.md`](./CHANGELOG.md).

## License

MIT.
