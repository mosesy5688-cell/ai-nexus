/**
 * P2 Adoption Telemetry -- AE WRITE ADAPTER (the SINGLE write module).
 *
 * Authority: SPEC s6 (Workers Analytics Engine sink, writeDataPoint-only,
 * one-way by construction), s8 (telemetry can never fail/slow/alter a response),
 * s11 (kill switch, TELEMETRY_ENABLED default-OFF); Founder DISPOSITION
 * D-2026-0615-49 O-1 (binding name = ADOPTION_TELEMETRY) + O-6 (B-1..B-4: local
 * no-op guard, env access path). Telemetry Spec Erratum #5: Analytics Engine
 * writeDataPoint() is itself fire-and-forget and NON-BLOCKING (it returns
 * immediately; the platform flushes the point), so there is NO async work to
 * hand to ctx.waitUntil -- wrapping it in a Promise + waitUntil only created a
 * false "ran inside waitUntil" appearance and masked synchronous throws. We call
 * writeDataPoint DIRECTLY inside a local try/catch instead.
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
 *  - FAILURE ISOLATION: the writeDataPoint call is fully try/caught; a telemetry
 *    failure NEVER throws into, delays, or changes the caller (SPEC s8 line 226).
 *    On a SYNCHRONOUS throw a single in-proc submission-error counter increments
 *    and emit() honestly reports attempted:false (the only meta-signal). This is
 *    a SUBMISSION error count (the writeDataPoint call threw), NOT a confirmed AE
 *    delivery-failure count -- AE confirms no delivery to the caller.
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

// In-process SYNCHRONOUS-SUBMISSION-ERROR meta-counter (SPEC s11 line 304):
// increments when dataset.writeDataPoint() THROWS synchronously. It is NOT a
// confirmed AE delivery-failure count (AE never confirms delivery to us). Not
// persisted, not a dimension; a single number for operational visibility only.
let submissionErrors = 0;
export const getSubmissionErrorCount = (): number => submissionErrors;
export const resetSubmissionErrorCount = (): void => { submissionErrors = 0; };

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
 * emit -- the public emitter. Signature accepts ONLY (env, rawEvent). rawEvent
 * is validated against the closed schema before anything else; an invalid event
 * is dropped (never thrown). The AE writeDataPoint() is itself non-blocking
 * (Erratum #5) so it is called DIRECTLY inside a local try/catch -- NO async
 * IIFE, NO Promise, NO waitUntil. A synchronous throw is caught, counted, and
 * reported honestly; it NEVER throws into / delays / alters the caller.
 *
 * Returns a small META-ONLY status object for tests/operational signal:
 *  - attempted: true  => writeDataPoint() was invoked and returned without
 *                        throwing synchronously. This is NOT a delivery
 *                        confirmation (AE never confirms delivery to us); the
 *                        point was merely SUBMITTED.
 *  - attempted: false => the adapter no-op'd (disabled / no-binding / invalid)
 *                        or writeDataPoint() threw synchronously (reason set).
 * The object is never persisted, never delivered, never a serving value.
 */
export interface EmitResult { attempted: boolean; reason?: string; }

export function emit(
  env: TelemetryEnv | undefined,
  rawEvent: unknown,
): EmitResult {
  // 1. Default-OFF + no-binding guards -> safe no-op (never touches the sink).
  if (!isEnabled(env)) return { attempted: false, reason: 'disabled' };
  const dataset = env?.ADOPTION_TELEMETRY;
  if (!dataset) return { attempted: false, reason: 'no-binding' };

  // 2. Closed-world validation. Only validated enums may proceed.
  const v = validateEvent(rawEvent);
  if (!v.ok || !v.event) return { attempted: false, reason: 'invalid:' + v.errors.join(';') };

  // 3. Direct, synchronous, fully-isolated submission. writeDataPoint() is the
  // platform's own fire-and-forget (Erratum #5); we do NOT wrap it. A sync throw
  // is caught so the serve path is never affected -- and reported honestly.
  const point = eventToDataPoint(v.event);
  try {
    dataset.writeDataPoint(point);
  } catch {
    submissionErrors++;   // sync submission error (SPEC s11 line 303); serve path sacred
    return { attempted: false, reason: 'submission-threw' };
  }
  return { attempted: true };
}
