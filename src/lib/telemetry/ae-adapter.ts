/**
 * P2 Adoption Telemetry -- AE WRITE ADAPTER (the SINGLE write module).
 *
 * Authority: SPEC s6 (Workers Analytics Engine sink, writeDataPoint-only,
 * one-way by construction), s8 (fire-and-forget via Astro.locals.cfContext.
 * waitUntil; telemetry can never fail/slow/alter a response), s11 (kill switch,
 * TELEMETRY_ENABLED default-OFF); Founder DISPOSITION D-2026-0615-49 O-1
 * (binding name = ADOPTION_TELEMETRY) + O-6 (B-1..B-4: local no-op guard,
 * waitUntil, env access path).
 *
 * THIS IS THE ONLY MODULE IN THE REPO ALLOWED TO DEREFERENCE
 * env.ADOPTION_TELEMETRY AT RUNTIME (binding-confinement gate enforces this).
 *
 * Hard guarantees:
 *  - Accepts ONLY a validated closed-enum event (schema.validateEvent). It does
 *    NOT accept Request/URL/Headers/body/query/raw-path/raw-error/arbitrary obj.
 *  - DEFAULT-OFF: when TELEMETRY_ENABLED is not exactly the string 'true', the
 *    adapter is a no-op (SPEC s11 line 297).
 *  - LOCAL/NO-BINDING NO-OP: if the AE binding is absent (local pages dev; SPEC
 *    s6 line 173), the adapter is a safe no-op -- never assume a local write.
 *  - FAILURE ISOLATION: the write is fire-and-forget through the caller-supplied
 *    waitUntil and is fully try/caught; a telemetry failure NEVER throws into,
 *    delays, or changes the caller (SPEC s8 line 226). On error a single in-proc
 *    lost-write counter increments (the only meta-signal; SPEC s11 line 304).
 *
 * ASCII-only (CES Art 8.1).
 */
import { validateEvent, type TelemetryEvent } from './schema';

// Frozen binding name (D-49 O-1). Dataset names live in wrangler.toml ONLY and
// are NEVER constructed here from any customer/route/secret input.
export const TELEMETRY_BINDING_NAME = 'ADOPTION_TELEMETRY';

/** Minimal AE binding surface: writeDataPoint ONLY (no read API exists). */
export interface AnalyticsEngineDataset {
  writeDataPoint(event: {
    blobs?: (string | null)[];
    doubles?: number[];
    indexes?: string[];
  }): void;
}

/** The runtime env shape this adapter (and ONLY this adapter) reads. */
export interface TelemetryEnv {
  ADOPTION_TELEMETRY?: AnalyticsEngineDataset;
  TELEMETRY_ENABLED?: string;
}

/** Caller passes the platform fire-and-forget hook (TA2: Astro.locals.cfContext
 *  .waitUntil). Optional: when absent the adapter still never blocks the caller. */
export type WaitUntil = (p: Promise<unknown>) => void;

// In-process lost-write meta-counter (SPEC s11 line 304). Not persisted, not a
// dimension; a single number for operational visibility only.
let lostWrites = 0;
export const getLostWriteCount = (): number => lostWrites;
export const resetLostWriteCount = (): void => { lostWrites = 0; };

/** isEnabled -- default-OFF unless the flag is EXACTLY the string 'true'. */
export function isEnabled(env: TelemetryEnv | undefined): boolean {
  return !!env && env.TELEMETRY_ENABLED === 'true';
}

/**
 * eventToDataPoint -- map a VALIDATED closed event to the AE data-point shape.
 * Respects the AE caps (SPEC s6 lines 169-172): <=20 blobs, <=20 doubles,
 * EXACTLY ONE index. All dimensions are closed-enum strings -> blobs; the single
 * index is the surface (the primary count axis). No raw value can appear here
 * because the input is already schema-validated.
 */
export function eventToDataPoint(e: TelemetryEvent): {
  blobs: (string | null)[]; doubles: number[]; indexes: string[];
} {
  return {
    blobs: [
      e.schema_version, e.surface, e.operation, e.status_class,
      e.cache_class, e.audience_class, e.referer_host_class, e.time_bucket,
    ],
    doubles: [],            // counting is by row; no numeric dimension in v0
    indexes: [e.surface],   // EXACTLY ONE index (multi-index silently drops)
  };
}

/**
 * emit -- the public emitter. Signature accepts ONLY (env, rawEvent, waitUntil).
 * rawEvent is validated against the closed schema before anything else; an
 * invalid event is dropped (never thrown). The actual writeDataPoint runs inside
 * a try/catch wrapped in waitUntil so it can never reach the response path.
 *
 * Returns a small status object for tests/meta only -- callers ignore it.
 */
export interface EmitResult { written: boolean; reason?: string; }

export function emit(
  env: TelemetryEnv | undefined,
  rawEvent: unknown,
  waitUntil?: WaitUntil,
): EmitResult {
  // 1. Default-OFF + no-binding guards -> safe no-op (never touches the sink).
  if (!isEnabled(env)) return { written: false, reason: 'disabled' };
  const dataset = env?.ADOPTION_TELEMETRY;
  if (!dataset) return { written: false, reason: 'no-binding' };

  // 2. Closed-world validation. Only validated enums may proceed.
  const v = validateEvent(rawEvent);
  if (!v.ok || !v.event) return { written: false, reason: 'invalid:' + v.errors.join(';') };

  // 3. Fire-and-forget write, fully isolated from the caller.
  const point = eventToDataPoint(v.event);
  const task = (async () => {
    try {
      dataset.writeDataPoint(point);
    } catch {
      lostWrites++;   // silently lost (SPEC s11 line 303); serve path is sacred
    }
  })();
  if (waitUntil) {
    try { waitUntil(task); } catch { lostWrites++; }
  } else {
    // No platform hook (e.g. unit context): swallow the rejection so the floating
    // promise can never surface as an unhandled rejection in the caller.
    task.catch(() => { lostWrites++; });
  }
  return { written: true };
}
