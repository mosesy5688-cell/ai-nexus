/**
 * P2 Adoption Telemetry -- CLOSED-WORLD EVENT SCHEMA + validator.
 *
 * Authority: FINAL RAW EVENT SCHEMA, Founder DISPOSITION D-2026-0615-49:
 *   {schema_version, surface, operation/tool enum, status_class(2xx|3xx|4xx|5xx),
 *    cache/result class, audience_class, referer_host_class, UTC time bucket}.
 * FORBIDDEN (assert absent): latency, deployment SHA, snapshot ID, request body,
 *   MCP arguments, query string, prompt, entity ID, slug/dynamic path segment,
 *   canonical_id, UMID, source URL, raw IP, raw User-Agent, raw/full referer,
 *   cookie, fingerprint, geo, clientInfo, arbitrary error text.
 *
 * The validator is the ONLY contract by which a raw event reaches the write
 * adapter. It (1) requires EXACTLY the allowed keys, each a closed enum, and
 * (2) REJECTS any extra key -- closed-world ("nothing outside this list, ever",
 * SPEC s5 line 133) -- AND hard-rejects the named forbidden field names so a
 * future careless caller cannot smuggle one in. PURE; no I/O. ASCII (CES 8.1).
 */
import {
  isSurface, isMcpTool, isStatusClass, isAudienceClass, isCacheClass,
  isRefererHostClass, ROUTE_FAMILIES, DISCOVERY_SURFACES,
  type Surface, type McpTool, type StatusClass, type AudienceClass,
  type CacheClass, type RefererHostClass,
} from './vocab';

export const SCHEMA_VERSION = '1';

/** The closed raw-event shape. EXACTLY these keys; nothing else, ever. */
export interface TelemetryEvent {
  schema_version: string;     // frozen '1'
  surface: Surface;           // closed surface vocabulary
  operation: McpTool | null;  // MCP tool name for mcp.tools_call; else null
  status_class: StatusClass;  // 2xx|3xx|4xx|5xx (Erratum #4)
  cache_class: CacheClass;    // hit|miss|none
  audience_class: AudienceClass;
  referer_host_class: RefererHostClass;
  time_bucket: string;        // UTC hour bucket "YYYY-MM-DDTHH" (raw rows only)
}

/** The frozen allowed key set -- the closed world. */
export const ALLOWED_KEYS = [
  'schema_version', 'surface', 'operation', 'status_class',
  'cache_class', 'audience_class', 'referer_host_class', 'time_bucket',
] as const;

/**
 * FORBIDDEN field names -- the privacy floor (D-49). Any of these appearing as a
 * key in a candidate event is a HARD rejection (defense in depth on top of the
 * "extra key" rejection). These names also seed the static no-read gate so the
 * source of the module is scanned for them. Keep additive.
 */
export const FORBIDDEN_FIELDS = [
  'latency', 'latency_bucket', 'duration', 'timing',
  'deployment', 'deployment_sha', 'sha', 'snapshot', 'snapshot_id',
  'body', 'request_body', 'arguments', 'args', 'query', 'q', 'prompt',
  'entity_id', 'entityId', 'id', 'slug', 'path', 'pathname',
  'canonical_id', 'canonicalId', 'umid', 'source_url', 'sourceUrl',
  'ip', 'remote_addr', 'user_agent', 'userAgent', 'ua',
  'referer', 'referrer', 'cookie', 'cookies', 'fingerprint',
  'geo', 'country', 'colo', 'region', 'clientInfo', 'client_info',
  'error', 'error_text', 'message', 'stack',
] as const;

const UTC_BUCKET = /^\d{4}-\d{2}-\d{2}T\d{2}$/;

export interface ValidationResult {
  ok: boolean;
  event?: TelemetryEvent;
  errors: string[];
}

/**
 * validateEvent -- the closed-world gate. Returns ok:false with reasons on ANY
 * deviation; NEVER throws (telemetry must never break a caller). On ok it returns
 * a NEW object containing ONLY the allowed keys (so nothing the caller attached
 * can ride along to the sink).
 */
export function validateEvent(input: unknown): ValidationResult {
  const errors: string[] = [];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['event must be a plain object'] };
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);

  // (1) Closed world: reject any key not in the allowed set, and explicitly name
  // a forbidden field if that is why (clearer failure for the privacy canary).
  const forbidden = new Set<string>(FORBIDDEN_FIELDS as readonly string[]);
  for (const k of keys) {
    if (forbidden.has(k)) errors.push(`forbidden field present: ${k}`);
    else if (!(ALLOWED_KEYS as readonly string[]).includes(k)) {
      errors.push(`unknown field (closed-world violation): ${k}`);
    }
  }
  // (2) Require every allowed key.
  for (const k of ALLOWED_KEYS) {
    if (!(k in obj)) errors.push(`missing required field: ${k}`);
  }

  // (3) Each field must be its closed enum / shape.
  if (obj.schema_version !== SCHEMA_VERSION) errors.push('schema_version must be "1"');
  if (!isSurface(obj.surface)) errors.push('surface not in closed vocabulary');
  if (!isStatusClass(obj.status_class)) errors.push('status_class not 2xx|3xx|4xx|5xx');
  if (!isCacheClass(obj.cache_class)) errors.push('cache_class not hit|miss|none');
  if (!isAudienceClass(obj.audience_class)) errors.push('audience_class not in closed enum');
  if (!isRefererHostClass(obj.referer_host_class)) errors.push('referer_host_class not in closed allowlist');
  if (typeof obj.time_bucket !== 'string' || !UTC_BUCKET.test(obj.time_bucket)) {
    errors.push('time_bucket must be UTC "YYYY-MM-DDTHH"');
  }
  // operation: tool name ONLY for mcp.tools_call; MUST be null for every other
  // surface (no operation dimension smuggling for REST/discovery surfaces).
  if (obj.surface === 'mcp.tools_call') {
    if (!isMcpTool(obj.operation)) errors.push('mcp.tools_call requires a closed tool name');
  } else if (obj.operation !== null) {
    errors.push('operation must be null except for mcp.tools_call');
  }

  if (errors.length > 0) return { ok: false, errors };
  const event: TelemetryEvent = {
    schema_version: SCHEMA_VERSION,
    surface: obj.surface as Surface,
    operation: (obj.operation as McpTool | null),
    status_class: obj.status_class as StatusClass,
    cache_class: obj.cache_class as CacheClass,
    audience_class: obj.audience_class as AudienceClass,
    referer_host_class: obj.referer_host_class as RefererHostClass,
    time_bucket: obj.time_bucket as string,
  };
  return { ok: true, event, errors: [] };
}

/** Surfaces that never carry an operation (everything but mcp.tools_call). */
export const NON_OPERATION_SURFACES = [
  ...ROUTE_FAMILIES, ...DISCOVERY_SURFACES, 'mcp.initialize',
] as const;
