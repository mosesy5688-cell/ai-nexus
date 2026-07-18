/**
 * R5 Phase-1 published-pointer resolver (fenced reader substrate).
 *
 * Design source: FREE2AITOOLS_R5_ATOMIC_PUBLISH_IMPLEMENTATION_DESIGN_GATE_v1
 * (§2.6 reader, §3.2 pointer schema, §3.3 cycle manifest, MF-9 degrade), narrowed
 * by Founder ruling D-2026-0717-350 (THE FENCE).
 *
 * THE FENCE (D-350, non-negotiable):
 *   Production runs `legacy_only`. In legacy_only this substrate NEVER GETs
 *   `data/current.json`, adds ZERO new R2 request and ZERO latency vs today, and
 *   returns a legacy CyclePin byte-identical to today's loadManifest. The
 *   `pointer_capable` branch (GET current.json + cycle manifest + build
 *   logicalToBlob + degrade) is implemented but reachable ONLY via dependency
 *   injection in tests — NO production caller passes `pointer_capable`, so it is
 *   unreachable in production. Switching prod to pointer_capable is a FUTURE
 *   Founder ruling; NO production path is wired to it here.
 */
import { META_SHARD_COUNT } from '../constants/shard-constants.js';

export type ReaderMode = 'legacy_only' | 'pointer_capable';

// THE production mode. A hardcoded module constant — NOT an env var, NOT any
// ungoverned toggle. Every production caller resolves against this value.
export const PHASE1_READER_MODE: ReaderMode = 'legacy_only';

// The only pointer schema this reader understands. Any other value (unknown or
// greater) fails safe: degrade, never mis-route.
export const SUPPORTED_POINTER_SCHEMA = 1;

export interface CyclePin {
    build_id: string | null;
    cyclePrefix: string;
    manifestKey: string;
    generation: number | null;
    logicalToBlob: Map<string, string> | null;   // logical name -> `data/blobs/<sha>`
    partitions: any;
    _etag: string;
    source: 'pointer' | 'legacy' | 'fallback';
}

export interface ResolveDeps {
    /** Degrade target: the legacy shards_manifest.json CyclePin (today's path). */
    loadLegacy: () => Promise<CyclePin>;
}

/**
 * Legacy CyclePin from a parsed shards_manifest.json. Spreads EVERY raw manifest
 * field first so unedited fixed-key consumers that read arbitrary manifest fields
 * are unaffected, then stamps the CyclePin fields. build_id/partitions/_etag are
 * byte-identical to today's loadManifest; logicalToBlob=null so callers use fixed
 * keys; source='legacy'.
 */
export function buildLegacyCyclePin(raw: any, etag: string): CyclePin {
    return {
        ...raw,
        build_id: raw?.build_id ?? null,
        cyclePrefix: '',
        manifestKey: 'data/shards_manifest.json',
        generation: null,
        logicalToBlob: null,
        partitions: raw?.partitions,
        _etag: etag,
        source: 'legacy',
    };
}

/** Hard-fallback CyclePin — mirrors today's `{ partitions:{meta_shards}, _etag:'fallback' }`. */
export function buildFallbackCyclePin(): CyclePin {
    return {
        build_id: null,
        cyclePrefix: '',
        manifestKey: 'data/shards_manifest.json',
        generation: null,
        logicalToBlob: null,
        partitions: { meta_shards: META_SHARD_COUNT },
        _etag: 'fallback',
        source: 'fallback',
    };
}

/**
 * Today's loadManifest footprint EXACTLY: a single GET of data/shards_manifest.json
 * (R2 binding in prod, CDN under simulate/dev), returning a legacy CyclePin, with
 * the hard-fallback retained. This is the ONLY R2 request the legacy_only path makes.
 */
export async function loadLegacyCyclePin(r2Bucket: any, simulate: boolean): Promise<CyclePin> {
    try {
        if (r2Bucket && !simulate) {
            const obj = await r2Bucket.get('data/shards_manifest.json');
            const raw = await obj.json();
            const etag = (obj.httpEtag || obj.etag || 'v23').replace(/"/g, '');
            return buildLegacyCyclePin(raw, etag);
        }
        const res = await fetch('https://cdn.free2aitools.com/data/shards_manifest.json');
        const raw = await res.json();
        const etag = (res.headers.get('etag') || 'v23-dev').replace(/"/g, '');
        return buildLegacyCyclePin(raw, etag);
    } catch {
        return buildFallbackCyclePin();
    }
}

// Last VALIDATED good pointer pin, resident per isolate — the MF-9 degrade target
// when a pointer resolves but its manifest/blobs break. Reset in tests.
let lastGoodPin: CyclePin | null = null;

function degrade(deps: ResolveDeps): Promise<CyclePin> {
    // MF-9: prefer the last validated-good pin resident this isolate; else the
    // legacy fixed-key path. Mirrors the loadManifest hard-fallback — never 500,
    // never mis-route.
    if (lastGoodPin) return Promise.resolve(lastGoodPin);
    return deps.loadLegacy();
}

function validatePointer(p: any): boolean {
    return !!p && typeof p === 'object'
        && p.schema === SUPPORTED_POINTER_SCHEMA
        && typeof p.build_id === 'string' && p.build_id.length > 0
        && typeof p.manifest_key === 'string' && p.manifest_key.length > 0;
}

function buildLogicalToBlob(manifest: any): Map<string, string> | null {
    const blobs = manifest?.blobs;
    if (!blobs || typeof blobs !== 'object') return null;
    const map = new Map<string, string>();
    for (const [logical, sha] of Object.entries(blobs)) {
        if (typeof sha !== 'string' || !sha) continue;
        // Content-addressed key VERBATIM: `data/blobs/<sha>` (an optional
        // `sha256:` prefix is stripped; the key must NEVER become `data/<sha>`).
        map.set(logical, `data/blobs/${sha.replace(/^sha256:/, '')}`);
    }
    return map.size > 0 ? map : null;
}

/**
 * Resolve the published cycle pin.
 *   legacy_only (PRODUCTION): return the legacy CyclePin — NEVER GET
 *     data/current.json, accept no stray pointer, add zero R2 request/latency.
 *   pointer_capable (DI-TEST-ONLY, unreachable in prod): GET data/current.json via
 *     the R2 BINDING (never CDN), validate schema + shape, GET the immutable cycle
 *     manifest, build logicalToBlob, else fail-safe degrade (MF-9). Every fault
 *     (pointer absent / corrupt / unknown-schema / manifest 404 / no blobs map)
 *     degrades to cached-good-or-legacy; never a 500, never a mis-route.
 */
export async function resolvePublishedPointer(
    r2Bucket: any, simulate: boolean, mode: ReaderMode, deps: ResolveDeps,
): Promise<CyclePin> {
    if (mode === 'legacy_only') return deps.loadLegacy();

    // --- pointer_capable (test-injected only) ---
    if (!r2Bucket || simulate) return degrade(deps);   // no binding -> degrade
    let pointer: any;
    try {
        const obj = await r2Bucket.get('data/current.json');
        if (!obj) return degrade(deps);                // pointer absent
        pointer = await obj.json();
    } catch {
        return degrade(deps);                          // corrupt / unparseable
    }
    if (!validatePointer(pointer)) return degrade(deps); // unknown/greater schema, bad shape

    let manifest: any;
    try {
        const mObj = await r2Bucket.get(pointer.manifest_key);
        if (!mObj) return degrade(deps);               // dangling manifest (MF-9)
        manifest = await mObj.json();
    } catch {
        return degrade(deps);
    }
    const logicalToBlob = buildLogicalToBlob(manifest);
    if (!logicalToBlob) return degrade(deps);          // manifest carries no blobs map

    const pin: CyclePin = {
        build_id: pointer.build_id,
        cyclePrefix: pointer.cycle_prefix || '',
        manifestKey: pointer.manifest_key,
        generation: typeof pointer.generation === 'number' ? pointer.generation : null,
        logicalToBlob,
        partitions: manifest.partitions,
        _etag: pointer.build_id,     // immutable build_id is the etag bucket
        source: 'pointer',
    };
    lastGoodPin = pin;
    return pin;
}

/** Test hook: clear the per-isolate last-good pointer cache. */
export function _resetPublishedPointerForTest(): void {
    lastGoodPin = null;
}
