// agent_claude_adapter.ts — CELL-B Claude Code / Opus ONLY (command / config / event-parse).
// D-193 P3/P4 + D-194 C2/C3. Builds the frozen `claude -p` command (task via STDIN), an ISOLATED
// settings/config root, --bare + fresh session, and per-arm MCP config where CONTROL = an EXPLICIT
// empty/baseline mcpServers (omitting --mcp-config alone is NOT proof; --bare alone is NOT proof)
// and AVAILABLE = identical + exactly ONE F2AI relay entry. METHOD A non-MCP capability parity:
// native web/network tools (WebSearch/WebFetch/Bash) disallowed IDENTICALLY in both arms. Parses
// the --output-format stream-json tool_use/tool_result blocks (CORROBORATION only; relay primary).
import type { Arm } from "./schema_evidence.js";
import type { CommandSpec } from "./subject_runner.js";
import { assertModelResolved } from "./subject_runner.js";
import { resolveDirectLaunch, assertProductionCommandSpec, type FrozenLaunchIdentity } from "./frozen_launch_identity.js";
import { hashJson } from "./manifest.js";
import type { ArmDiffRecord, NativeToolCall } from "./agent_codex_adapter.js";

export const CLAUDE_ENV_ALLOWLIST = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "HOME", "LANG"];
const SECRET_ENV_DENY = /(TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|GITHUB|NPM|CLOUDFLARE|CF_|AWS_|OPENAI|ANTHROPIC)/i;

export function buildClaudeEnv(configDir: string, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of CLAUDE_ENV_ALLOWLIST) {
    const v = base[k];
    if (typeof v === "string" && !SECRET_ENV_DENY.test(k)) env[k] = v;
  }
  env.CLAUDE_CONFIG_DIR = configDir; // isolated settings/config root (per episode)
  return env;
}

// METHOD A: native web/network capability disabled IDENTICALLY in both arms; F2AI only via relay.
export const CLAUDE_CAPABILITY_PARITY = {
  method: "A",
  disallowed_tools: ["Edit", "Write", "Bash", "WebSearch", "WebFetch"],
  native_web_tools: "DISABLED_BOTH_ARMS",
  note: "WebSearch/WebFetch disallowed in BOTH arms closes the direct-F2AI bypass; only the relay reaches F2AI",
} as const;
const DISALLOWED_TOOLS = CLAUDE_CAPABILITY_PARITY.disallowed_tools.join(" ");

export interface ClaudeMcpConfig { mcpServers: Record<string, { type: string; url: string }>; }
// CONTROL = explicit empty baseline; AVAILABLE = identical + exactly one F2AI relay entry.
export function buildClaudeMcpConfig(arm: Arm, relayUrl?: string): ClaudeMcpConfig {
  if (arm === "CONTROL") return { mcpServers: {} };
  if (!relayUrl) throw new Error("AVAILABLE arm requires a relay endpoint");
  return { mcpServers: { free2aitools: { type: "http", url: relayUrl } } };
}

export interface ClaudeBuildArgs {
  model: string; modelConfirmed?: string | null; identity: FrozenLaunchIdentity; env: Record<string, string>;
  workspace: string; arm: Arm; mcpConfigPath: string; relayUrl?: string; task: string;
}
// Construct the exact frozen command. D-200 §H direct-launch: exe = the FROZEN ABSOLUTE NATIVE claude.exe
// (NOT via node, NOT exe:"claude"/PATH-name/.ps1/.cmd) with no prefix args. Task via STDIN; closed-world
// explicit env (§K). Fails closed on an unresolved model id (incl. bare "opus"). BOTH arms pass
// --mcp-config explicitly (CONTROL -> empty baseline file; AVAILABLE -> relay file).
export function buildClaudeCommand(a: ClaudeBuildArgs): CommandSpec {
  assertModelResolved(a.model, a.modelConfirmed);
  if (a.arm === "CONTROL" && a.relayUrl) throw new Error("CONTROL arm must NOT receive a relay endpoint");
  const launch = resolveDirectLaunch(a.identity);
  const benchArgs = [
    "-p", "--model", a.model, "--bare", "--add-dir", a.workspace,
    "--disallowedTools", DISALLOWED_TOOLS, "--output-format", "stream-json",
    "--mcp-config", a.mcpConfigPath,
  ];
  const spec: CommandSpec = { exe: launch.exe, args: [...launch.prefixArgs, ...benchArgs], env: a.env, stdin: a.task, shell: false };
  assertProductionCommandSpec(spec);
  return spec;
}

// ARM-DIFF: prove CONTROL vs AVAILABLE MCP config differs ONLY by the one F2AI relay entry.
export function buildClaudeArmDiff(control: ClaudeMcpConfig, available: ClaudeMcpConfig): ArmDiffRecord {
  const cKeys = Object.keys(control.mcpServers), aKeys = Object.keys(available.mcpServers);
  const added = aKeys.filter((k) => !cKeys.includes(k));
  const removed = cKeys.filter((k) => !aKeys.includes(k));
  const diff_is_f2ai_only = removed.length === 0 && cKeys.length === 0 && added.length === 1 && added[0] === "free2aitools";
  return {
    control_config_hash: hashJson(control),
    available_config_hash: hashJson(available),
    added, removed, env_changed: false, diff_is_f2ai_only,
  };
}

export interface ClaudeParse { parsedOk: boolean; nativeF2aiCalls: NativeToolCall[]; toolResultCount: number; }
const F2AI_PREFIX = "free2aitools_";

function scanContentBlocks(blocks: unknown, calls: NativeToolCall[]): number {
  let results = 0;
  if (!Array.isArray(blocks)) return 0;
  for (const b of blocks) {
    const blk = b as { type?: string; name?: string; input?: unknown };
    if (blk.type === "tool_use" && typeof blk.name === "string" && blk.name.startsWith(F2AI_PREFIX)) {
      calls.push({ tool: blk.name, arguments: blk.input ?? null });
    }
    if (blk.type === "tool_result") results++;
  }
  return results;
}

// Parse the Claude stream-json native event stream (JSONL). Blank/unparseable => parsedOk=false.
export function parseClaudeEvents(streamJson: string): ClaudeParse {
  const lines = streamJson.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { parsedOk: false, nativeF2aiCalls: [], toolResultCount: 0 };
  const calls: NativeToolCall[] = [];
  let results = 0;
  for (const line of lines) {
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line) as Record<string, unknown>; }
    catch { return { parsedOk: false, nativeF2aiCalls: [], toolResultCount: 0 }; }
    const msg = ev.message as { content?: unknown } | undefined;
    results += scanContentBlocks(msg?.content, calls);
    // Top-level tool_use/tool_result shape (defensive across stream-json variants).
    const t = String(ev.type ?? ""), name = String(ev.name ?? "");
    if (t === "tool_use" && name.startsWith(F2AI_PREFIX)) calls.push({ tool: name, arguments: (ev as { input?: unknown }).input ?? null });
    if (t === "tool_result") results++;
  }
  return { parsedOk: true, nativeF2aiCalls: calls, toolResultCount: results };
}
