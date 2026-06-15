/**
 * P2 Adoption Telemetry -- LOCAL NO-OP / MOCK binding (D-49 O-6 B-2).
 *
 * The AE binding does NOT work in local pages dev (SPEC s6 line 173). This is
 * the safe local stand-in: a writeDataPoint that does nothing (records a local
 * call count for dev introspection only -- never persisted, never a dimension).
 * The adapter already no-ops when the real binding is absent; this mock lets
 * local dev / tests exercise the write path WITHOUT a real sink and WITHOUT
 * pretending a local write reached production.
 *
 * It is NOT referenced from any serve path. Importing it never dereferences the
 * real env.ADOPTION_TELEMETRY binding. ASCII-only (CES Art 8.1).
 */
import type { AnalyticsEngineDataset, TelemetryEnv } from './ae-adapter';

export class MockTelemetryDataset implements AnalyticsEngineDataset {
  public calls: Array<{ blobs?: (string | null)[]; doubles?: number[]; indexes?: string[] }> = [];
  writeDataPoint(event: { blobs?: (string | null)[]; doubles?: number[]; indexes?: string[] }): void {
    this.calls.push(event);
  }
}

/** Build a local TelemetryEnv with the mock dataset bound. Flag still defaults
 *  OFF unless explicitly enabled by the caller (mirrors production posture). */
export function makeMockEnv(enabled = false): TelemetryEnv & { ADOPTION_TELEMETRY: MockTelemetryDataset } {
  return {
    ADOPTION_TELEMETRY: new MockTelemetryDataset(),
    TELEMETRY_ENABLED: enabled ? 'true' : 'false',
  };
}
