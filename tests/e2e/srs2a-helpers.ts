/**
 * SRS-2A Frontend Baseline — shared helpers.
 *
 * Persistent harness against DEPLOYED PROD (default https://free2aitools.com,
 * override via BASE_URL). Read-only. Informational / non-blocking baseline that
 * closes the Frontend Matrix PENDING_RUNTIME browser cells.
 *
 * Holds: base-url resolution, real-id resolution via the public search API, a
 * descriptive test User-Agent, a bounded transient retry (<=2, Retry-After
 * aware), and a per-run PROVENANCE FREEZE artifact writer with SEPARATE outcome
 * counts. The SEVERE browser-error classifier lives in ./srs2a-classifier to
 * honor the 250-line CES floor.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserEvent } from './srs2a-classifier';

export const BASE_URL = (process.env.BASE_URL || 'https://free2aitools.com').replace(/\/+$/, '');

/** Descriptive UA identifying the test client. Requests NO privileged/allowlist
 * treatment; it only makes the baseline traffic attributable in access logs. */
export const TEST_UA = 'SRS-2A-frontend-baseline/1.0 (+free2aitools informational harness; read-only)';

/** Detail-page entity types we resolve + visit, with type-appropriate probe queries. */
export const DETAIL_TYPES: Array<{ type: string; route: string; queries: string[] }> = [
    { type: 'model', route: 'model', queries: ['llama', 'qwen', 'mistral'] },
    { type: 'paper', route: 'paper', queries: ['llm', 'transformer', 'attention'] },
    { type: 'dataset', route: 'dataset', queries: ['bench', 'image', 'text'] },
    { type: 'tool', route: 'tool', queries: ['code', 'agent', 'chat'] },
    { type: 'benchmark', route: 'benchmark', queries: ['mmlu', 'glue', 'eval'] },
];

/** Resolve a real slug for a given type via /api/v1/search. Returns null if sparse. */
export async function resolveRealSlug(
    request: { get: (url: string, opts?: any) => Promise<{ ok(): boolean; status(): number; json(): Promise<any> }> },
    type: string,
    queries: string[],
): Promise<string | null> {
    for (const q of queries) {
        const url = `${BASE_URL}/api/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=5`;
        try {
            const resp = await request.get(url, { headers: { 'user-agent': TEST_UA } });
            if (!resp.ok()) continue;
            const data = await resp.json();
            const results: any[] = Array.isArray(data?.results) ? data.results : [];
            const hit = results.find((r) => r && r.type === type && typeof r.slug === 'string' && r.slug.length > 0)
                || results.find((r) => r && typeof r.slug === 'string' && r.slug.length > 0);
            if (hit) return hit.slug as string;
        } catch {
            /* transient network — try next query */
        }
    }
    return null;
}

/**
 * Bounded retry for an EXPLICITLY-classified transient (429 / 503 / network).
 * MAX 2 retries; respects Retry-After (capped); NO infinite retry; NO retry for
 * deterministic contract failures (caller must not pass those here). `fn` should
 * return a status; `isTransient` decides whether to retry on that status.
 */
export async function withTransientRetry<T extends { status(): number; headers(): Record<string, string> }>(
    fn: () => Promise<T>,
    isTransient: (status: number) => boolean,
    maxRetries = 2,
): Promise<{ resp: T; retries: number }> {
    let retries = 0;
    let resp = await fn();
    while (isTransient(resp.status()) && retries < maxRetries) {
        const ra = Number(resp.headers()['retry-after']);
        const waitMs = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 5000) : 500 * (retries + 1);
        await new Promise((r) => setTimeout(r, waitMs));
        retries += 1;
        resp = await fn();
    }
    return { resp, retries };
}

/** Best-effort git SHA of the harness repo (provenance, not the deployed build). */
function repoSha(): string {
    try {
        return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    } catch {
        return process.env.GITHUB_SHA || 'unknown';
    }
}

/** Discover the deployed build id from a served response header, if exposed. */
export async function discoverBuildId(
    request: { get: (url: string, opts?: any) => Promise<{ headers(): Record<string, string> }> },
): Promise<string> {
    try {
        const resp = await request.get(`${BASE_URL}/`, { headers: { 'user-agent': TEST_UA } });
        const h = resp.headers();
        return h['x-build-id'] || h['cf-ray'] || h['etag'] || 'undiscoverable';
    } catch {
        return 'undiscoverable';
    }
}

/** Observe a data-snapshot id from the search API manifest etag, if present. */
export async function discoverSnapshotId(
    request: { get: (url: string, opts?: any) => Promise<{ headers(): Record<string, string> }> },
): Promise<string> {
    try {
        const resp = await request.get(`${BASE_URL}/api/v1/search?q=llama&limit=1`, { headers: { 'user-agent': TEST_UA } });
        return resp.headers()['etag'] || 'unobservable';
    } catch {
        return 'unobservable';
    }
}

/**
 * Final per-cell assertion state. A cell is a clean PASS only when its contract
 * held. INCONCLUSIVE_TRANSIENT is NOT a pass and does NOT close a Matrix cell.
 */
export type CellState =
    | 'PASS'
    | 'PRODUCT_FAILURE'
    | 'HARNESS_FAILURE'
    | 'INCONCLUSIVE_TRANSIENT'
    | 'SKIPPED_NA';

export interface ProvenanceRecord {
    assertion: string;
    expected: string;
    actual: string;
    state: CellState;
    keyFields?: Record<string, unknown>;
    retries?: number;
    /** Every captured+classified browser event for this cell (never erased). */
    events?: BrowserEvent[];
    /** Convenience: PASS iff state === 'PASS'. */
    pass: boolean;
}

export interface RunArtifact {
    srs: 'SRS-2A-frontend-baseline';
    repo_sha: string;
    deployment_build_id: string;
    data_snapshot_id: string;
    base_url: string;
    utc_time: string;
    region: string;
    cold_or_warm: string;
    /** SEPARATE outcome counts (Founder-exact summary). */
    summary: {
        passed: number;
        product_failures: number;
        harness_failures: number;
        transient_warnings: number;
        inconclusive_transient: number;
        skipped_or_na: number;
    };
    /** True only when there are zero inconclusive-transient cells. */
    clean_stabilization_run: boolean;
    records: ProvenanceRecord[];
}

const records: ProvenanceRecord[] = [];

export function record(rec: Omit<ProvenanceRecord, 'pass'> & { pass?: boolean }): void {
    records.push({ ...rec, pass: rec.state === 'PASS' });
}

function summarize(recs: ProvenanceRecord[]): RunArtifact['summary'] {
    const s = { passed: 0, product_failures: 0, harness_failures: 0, transient_warnings: 0, inconclusive_transient: 0, skipped_or_na: 0 };
    for (const r of recs) {
        if (r.state === 'PASS') s.passed += 1;
        else if (r.state === 'PRODUCT_FAILURE') s.product_failures += 1;
        else if (r.state === 'HARNESS_FAILURE') s.harness_failures += 1;
        else if (r.state === 'INCONCLUSIVE_TRANSIENT') s.inconclusive_transient += 1;
        else if (r.state === 'SKIPPED_NA') s.skipped_or_na += 1;
        // Count WARNING-severity events as transient warnings (preserved, not erased).
        s.transient_warnings += (r.events || []).filter((e) => e.severity === 'WARNING').length;
    }
    return s;
}

/** Emit the structured JSON run artifact (PROVENANCE FREEZE) at end of run. */
export async function emitRunArtifact(buildId: string, snapshotId: string): Promise<void> {
    const summary = summarize(records);
    const artifact: RunArtifact = {
        srs: 'SRS-2A-frontend-baseline',
        repo_sha: repoSha(),
        deployment_build_id: buildId,
        data_snapshot_id: snapshotId,
        base_url: BASE_URL,
        utc_time: new Date().toISOString(),
        region: process.env.SRS2A_REGION || process.env.RUNNER_OS || 'local',
        cold_or_warm: process.env.SRS2A_CACHE_STATE || 'unknown',
        summary,
        clean_stabilization_run: summary.inconclusive_transient === 0,
        records,
    };
    // Per-worker filename so parallel workers do not clobber each other's
    // records; the canonical (no-suffix) name is also written by the primary
    // worker so single-worker / CI line runs still have a stable path.
    const worker = process.env.TEST_WORKER_INDEX ?? '0';
    const dir = resolve(process.cwd(), 'test-results');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const shardOut = resolve(dir, `srs2a-frontend-baseline.w${worker}.json`);
    writeFileSync(shardOut, JSON.stringify(artifact, null, 2), 'utf8');
    if (worker === '0') {
        writeFileSync(resolve(dir, 'srs2a-frontend-baseline.json'), JSON.stringify(artifact, null, 2), 'utf8');
    }
    // eslint-disable-next-line no-console
    console.log(
        `[SRS-2A] artifact: ${shardOut} | passed=${summary.passed} product=${summary.product_failures} ` +
        `harness=${summary.harness_failures} warn=${summary.transient_warnings} ` +
        `inconclusive=${summary.inconclusive_transient} skip=${summary.skipped_or_na} ` +
        `clean=${artifact.clean_stabilization_run}`,
    );
}
