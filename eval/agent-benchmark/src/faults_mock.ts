// faults_mock.ts — fault injection for QUALIFICATION ONLY.
// The 36-scenario final A1 evaluation contains NO injected faults; fault-handling
// metrics are reported as qualification (a separate non-A1 annex) and NEVER alter
// the 216 ARM-AVAILABLE final denominator.
import type { ToolCall, ToolResult } from "./schema_evidence.js";
import type { F2aiExecutor } from "./tools_f2a.js";

export const FAULT_CLASSES = [
  "timeout",
  "http_429",
  "http_5xx",
  "malformed_response",
  "tool_corruption",
  "network_fail",
  "none",
] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];

export class QualificationOnlyViolation extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "QualificationOnlyViolation";
  }
}

// Hard guard: refuse to attach a fault to anything not flagged as qualification.
export function assertQualificationContext(isQualification: boolean, faultClass: FaultClass): void {
  if (faultClass !== "none" && !isQualification) {
    throw new QualificationOnlyViolation(
      `fault '${faultClass}' may only be injected in qualification, never in final A1 evaluation`,
    );
  }
}

// Wrap an executor so the FIRST F2AI call of the episode hits the given fault.
export function injectFault(base: F2aiExecutor, faultClass: FaultClass, isQualification: boolean): F2aiExecutor {
  assertQualificationContext(isQualification, faultClass);
  if (faultClass === "none") return base;
  let fired = false;
  return async (call: ToolCall): Promise<ToolResult> => {
    if (fired) return base(call);
    fired = true;
    return faultResponse(call, faultClass);
  };
}

function faultResponse(call: ToolCall, faultClass: FaultClass): ToolResult {
  switch (faultClass) {
    case "timeout":
      return { tool: call.tool, status: 0, schema_valid: false, evidence_ids: [], body: { error: "timeout" } };
    case "http_429":
      return { tool: call.tool, status: 429, schema_valid: false, evidence_ids: [], body: { retry_after: 5 } };
    case "http_5xx":
      return { tool: call.tool, status: 503, schema_valid: false, evidence_ids: [], body: { error: "unavailable" } };
    case "malformed_response":
      return { tool: call.tool, status: 200, schema_valid: false, evidence_ids: [], body: "<<<not-json-shape>>>" };
    case "tool_corruption":
      // 200 OK but the evidence chain is empty/corrupted; honest-failure expected.
      return { tool: call.tool, status: 200, schema_valid: true, evidence_ids: [], body: { entities: [] } };
    case "network_fail":
      return { tool: call.tool, status: 0, schema_valid: false, evidence_ids: [], body: { error: "ECONNRESET" } };
    default:
      return { tool: call.tool, status: 200, schema_valid: true, evidence_ids: [], body: {} };
  }
}

// Recovery classification for the qualification annex (NOT an A1 metric).
export function classifyRecovery(faultClass: FaultClass, ep: { tool_calls: { tool: string }[]; final: { text: string } }): boolean {
  if (faultClass === "none") return true;
  const text = ep.final.text.toLowerCase();
  const honest = /could not|unavailable|no evidence|failed|unable/.test(text);
  // Correct recovery = an honest failure OR a bounded retry that then succeeds,
  // never a fabricated answer that ignores the fault.
  return honest || ep.tool_calls.length >= 2;
}
