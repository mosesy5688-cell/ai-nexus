// agent_codex_adapter.ts — CELL-A Codex CLI ONLY (command / config / event-parse). D-193 P3/P4
// + D-194 C2/C3. Builds the frozen `codex exec` command (task via STDIN), a per-episode DISPOSABLE
// CODEX_HOME isolated state root with --ignore-user-config and a named profile INSIDE that root
// (no global `codex mcp` state, no operator-config mutation), per-arm MCP config (CONTROL: none;
// AVAILABLE: same + exactly ONE F2AI relay entry), a secret-env allowlist (no GH/npm/CF write
// creds), METHOD A non-MCP capability parity (native web/network disabled IDENTICALLY in both
// arms — a read-only FS sandbox alone does NOT disable web), and parses --json JSONL native events.
import type { Arm } from "./schema_evidence.js";
import type { CommandSpec } from "./subject_runner.js";
import { assertModelResolved } from "./subject_runner.js";
import { hashJson } from "./manifest.js";

// Only these env keys reach the child. Everything else (GITHUB_TOKEN, NPM_TOKEN, CLOUDFLARE_*,
// AWS_*, secrets) is dropped so the subject has NO write credential. CODEX_HOME is injected fresh.
export const CODEX_ENV_ALLOWLIST = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "LANG"];
const SECRET_ENV_DENY = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|GITHUB|NPM|CLOUDFLARE|CF_|AWS_|OPENAI|ANTHROPIC)/i;

export function buildCodexEnv(codexHome: string, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CODEX_ENV_ALLOWLIST) {
    const v = base[k];
    if (typeof v === "string" && !SECRET_ENV_DENY.test(k)) env[k] = v;
  }
  env.CODEX_HOME = codexHome; // disposable isolated state root (per episode)
  return env;
}

// METHOD A capability parity: identical in BOTH arms — read-only FS AND network disabled.
export const CODEX_CAPABILITY_PARITY = {
  method: "A",
  sandbox: "read-only",
  network_access: false,
  native_web_tools: "DISABLED_BOTH_ARMS",
  note: "read-only FS alone does NOT disable web; -c sandbox network_access=false closes the direct-F2AI bypass",
} as const;

// The single F2AI MCP override added ONLY in AVAILABLE; points at the per-episode relay endpoint.
function f2aiMcpOverrides(relayUrl: string): string[] {
  return ["-c", `mcp_servers.free2aitools.url=${relayUrl}`, "-c", "mcp_servers.free2aitools.transport=streamable_http"];
}

export interface CodexBuildArgs {
  model: string; modelConfirmed?: string | null; codexHome: string; profile: string;
  workspace: string; arm: Arm; relayUrl?: string; task: string; lastMsgFile: string;
}

// Construct the exact frozen command. Fails closed on an unresolved model id, on AVAILABLE without
// a relay, or on CONTROL carrying a relay (CONTROL must expose NO F2AI). Profile lives in CODEX_HOME.
export function buildCodexCommand(a: CodexBuildArgs): CommandSpec {
  assertModelResolved(a.model, a.modelConfirmed);
  if (a.arm === "AVAILABLE" && !a.relayUrl) throw new Error("AVAILABLE arm requires a relay endpoint");
  if (a.arm === "CONTROL" && a.relayUrl) throw new Error("CONTROL arm must NOT receive a relay endpoint");
  const args = [
    "exec", "-", "-m", a.model, "-s", "read-only", "--ephemeral", "--ignore-user-config",
    "-C", a.workspace, "--json", "-o", a.lastMsgFile, "-p", a.profile,
    "-c", "sandbox_workspace_write.network_access=false",
  ];
  if (a.arm === "AVAILABLE") args.push(...f2aiMcpOverrides(a.relayUrl!));
  return { exe: "codex", args, env: buildCodexEnv(a.codexHome), stdin: a.task };
}

export interface ArmDiffRecord {
  control_config_hash: string; available_config_hash: string;
  added: string[]; removed: string[]; env_changed: boolean; diff_is_f2ai_only: boolean;
}
// ARM-DIFF: prove CONTROL vs AVAILABLE differ ONLY by the F2AI MCP config — nothing inherited.
export function buildCodexArmDiff(control: CommandSpec, available: CommandSpec): ArmDiffRecord {
  const cSet = new Set(control.args), aSet = new Set(available.args);
  const added = available.args.filter((x) => !cSet.has(x));
  const removed = control.args.filter((x) => !aSet.has(x));
  const env_changed = hashJson(control.env) !== hashJson(available.env);
  const diff_is_f2ai_only =
    removed.length === 0 && !env_changed &&
    added.length > 0 && added.every((x) => x === "-c" || /^mcp_servers\.free2aitools\./.test(x));
  return {
    control_config_hash: hashJson({ args: control.args, env: control.env }),
    available_config_hash: hashJson({ args: available.args, env: available.env }),
    added, removed, env_changed, diff_is_f2ai_only,
  };
}

export interface NativeToolCall { tool: string; arguments: unknown; }
export interface CodexParse { parsedOk: boolean; nativeF2aiCalls: NativeToolCall[]; toolResultCount: number; }
const F2AI_PREFIX = "free2aitools_";

// Parse the Codex --json JSONL native event stream (CORROBORATION only; the relay is primary).
// A blank stream or any unparseable line => parsedOk=false (fail-closed upstream classification).
export function parseCodexEvents(jsonl: string): CodexParse {
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { parsedOk: false, nativeF2aiCalls: [], toolResultCount: 0 };
  const calls: NativeToolCall[] = [];
  let results = 0;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; }
    catch { return { parsedOk: false, nativeF2aiCalls: [], toolResultCount: 0 }; }
    const type = String(ev.type ?? "");
    const name = String((ev.name ?? (ev as { tool?: unknown }).tool) ?? "");
    if (/tool_call|function_call|mcp_tool_call/.test(type) && name.startsWith(F2AI_PREFIX)) {
      calls.push({ tool: name, arguments: (ev as { arguments?: unknown }).arguments ?? null });
    }
    if (/tool_result|function_call_output|mcp_tool_result/.test(type)) results++;
  }
  return { parsedOk: true, nativeF2aiCalls: calls, toolResultCount: results };
}
