/**
 * P2 Adoption Telemetry -- ROUTE-LOCAL emit helper (TA2 call-site seam).
 *
 * Authority: Founder DISPOSITION D-2026-0624-103 (Phase-A route-local re-attempt;
 * the #2218-safe redo of TA2). This is the ONLY bridge a route handler uses to
 * reach the telemetry substrate. It is CALLED FROM WITHIN a route handler
 * (route-local), NEVER from middleware. There is, by construction, NO import edge
 * from src/middleware.ts into this module or anything it pulls in.
 *
 * #2218 PREVENTION: the #2218 production SSR empty-body-500 came from a
 * middleware STATIC-import path. This module is imported ONLY by the two approved
 * route files (src/pages/api/mcp.ts, src/pages/api/v1/datasets.ts). It deliberately
 * does NOT name the AE binding token (the no-read static gate forbids that token
 * in the route paths); it reads the runtime env OPAQUELY and hands it to the sole
 * write adapter (ae-adapter.emit), which is the one module allowed to dereference
 * the binding.
 *
 * Hard guarantees (on top of the adapter's own isolation):
 *  - DEFAULT-OFF / NO-BINDING / FAIL-OPEN are all enforced inside emit(); this
 *    helper additionally wraps the WHOLE build+emit in a try/catch so even a
 *    classifier bug can never propagate to the serve path.
 *  - PURE input contract: callers pass ALREADY-EXTRACTED coarse primitives
 *    (surface, numeric status, optional tool name, optional referer host string,
 *    audience hints). This helper NEVER receives a Request/Response/Headers/body/
 *    URL/query/raw path. No raw value can reach the closed schema.
 *  - Returns ONLY a meta status object; NEVER a Response / serving value.
 *
 * ASCII-only (CES Art 8.1).
 */
import { emit, type EmitResult, type TelemetryEnv } from './ae-adapter';
import { SCHEMA_VERSION } from './schema';
import {
  statusToClass, classifyRefererHost, classifyAudience,
  type Surface, type McpTool, type CacheClass, type AudienceHints,
} from './vocab';

/**
 * extractTelemetryEnv -- pull the telemetry env OPAQUELY out of a route's
 * `locals`/`context.locals` runtime shape WITHOUT naming the AE binding token
 * (so the no-read gate stays green on the route file AND here we still never
 * dereference the binding -- we only forward the env object to the adapter).
 * Returns undefined when no runtime env is present (e.g. local dev) -> emit()
 * then no-ops. Never throws.
 */
export function extractTelemetryEnv(locals: unknown): TelemetryEnv | undefined {
  try {
    const rt = (locals as { runtime?: { env?: unknown } } | undefined)?.runtime;
    const env = rt?.env;
    if (env && typeof env === 'object') return env as TelemetryEnv;
  } catch {
    /* fail-open: any access error => undefined => emit() no-ops */
  }
  return undefined;
}

/** UTC hour bucket "YYYY-MM-DDTHH" (raw rows only; matches schema UTC_BUCKET). */
function utcHourBucket(d: Date): string {
  return d.toISOString().slice(0, 13); // "YYYY-MM-DDTHH"
}

/**
 * Coarse, already-extracted call-site facts. EXACTLY the closed-enum inputs the
 * event needs -- nothing raw. `operation` is meaningful ONLY for mcp.tools_call
 * (the adapter/schema reject it on any other surface). `refererHost` is an
 * already-parsed hostname string (the helper classifies it to a closed class and
 * never stores it raw); omit it to record 'none'.
 */
export interface RouteEmitInput {
  surface: Surface;
  status: number;
  operation?: McpTool | null;
  cacheClass?: CacheClass;
  audience?: AudienceHints;
  refererHost?: string | null;
  ownHost?: string;
  /** Test-only deterministic clock; production uses the real UTC hour. */
  now?: Date;
}

/**
 * emitRoute -- the route-local entry point. Builds a CLOSED event from coarse
 * primitives and forwards it to the single write adapter. FAIL-OPEN: the entire
 * body is try/caught so telemetry can never alter the route's status/body/latency
 * control flow. Returns a meta-only status (attempted/reason) for tests; the
 * route MUST ignore it. When telemetry is OFF or unbound, emit() no-ops and ZERO
 * AE write is attempted.
 */
export function emitRoute(
  env: TelemetryEnv | undefined,
  input: RouteEmitInput,
): EmitResult {
  try {
    const event = {
      schema_version: SCHEMA_VERSION,
      surface: input.surface,
      operation: input.surface === 'mcp.tools_call' ? (input.operation ?? null) : null,
      status_class: statusToClass(input.status),
      cache_class: input.cacheClass ?? 'none',
      audience_class: classifyAudience(input.audience ?? {}),
      referer_host_class: classifyRefererHost(input.refererHost, input.ownHost),
      time_bucket: utcHourBucket(input.now ?? new Date()),
    };
    return emit(env, event);
  } catch {
    // Belt-and-suspenders: even a classifier/Date bug never reaches the caller.
    return { attempted: false, reason: 'route-emit-threw' };
  }
}
