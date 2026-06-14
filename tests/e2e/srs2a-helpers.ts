/**
 * SRS-2A Frontend Baseline — shared helpers.
 *
 * Persistent harness against DEPLOYED PROD (default https://free2aitools.com,
 * override via BASE_URL). Read-only. Informational / non-blocking baseline that
 * closes the Frontend Matrix PENDING_RUNTIME browser cells.
 *
 * This module holds: base-url resolution, real-id resolution via the public
 * search API, a console-error collector, and a per-run PROVENANCE FREEZE
 * artifact writer. Kept separate from the spec to honor the 250-line CES floor.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Page, Request } from '@playwright/test';

export const BASE_URL = (process.env.BASE_URL || 'https://free2aitools.com').replace(/\/+$/, '');

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
    request: { get: (url: string) => Promise<{ ok(): boolean; json(): Promise<any> }> },
    type: string,
    queries: string[],
): Promise<string | null> {
    for (const q of queries) {
        const url = `${BASE_URL}/api/v1/search?q=${encodeURIComponent(q)}&type=${type}&limit=5`;
        try {
            const resp = await request.get(url);
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

/** Severe console errors only — ignore benign noise (favicon, 3rd-party, ResizeObserver). */
const BENIGN = [
    /favicon/i,
    /ResizeObserver loop/i,
    /Failed to load resource: the server responded with a status of 404.*favicon/i,
    /googletagmanager|google-analytics|gtag|plausible|clarity/i,
    // Cloudflare Web Analytics RUM beacon — third-party telemetry, not a product
    // asset; its failure/blocking is unrelated to frontend correctness.
    /cloudflareinsights\.com|\/cdn-cgi\/rum/i,
];

export function attachConsoleCollector(page: Page): { errors: string[]; badRequests: string[] } {
    const errors: string[] = [];
    const badRequests: string[] = [];
    page.on('console', (msg) => {
        if (msg.type() !== 'error') return;
        const text = msg.text();
        if (BENIGN.some((re) => re.test(text))) return;
        errors.push(text);
    });
    page.on('pageerror', (err) => {
        if (BENIGN.some((re) => re.test(err.message))) return;
        errors.push(err.message);
    });
    page.on('requestfailed', (req: Request) => {
        const u = req.url();
        if (BENIGN.some((re) => re.test(u))) return;
        badRequests.push(`${req.failure()?.errorText ?? 'failed'} ${u}`);
    });
    page.on('response', (resp) => {
        const u = resp.url();
        if (resp.status() === 404 && /\.(js|css|png|jpe?g|svg|webp|woff2?)(\?|$)/i.test(u)) {
            if (!BENIGN.some((re) => re.test(u))) badRequests.push(`404 asset ${u}`);
        }
    });
    return { errors, badRequests };
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
    request: { get: (url: string) => Promise<{ headers(): Record<string, string> }> },
): Promise<string> {
    try {
        const resp = await request.get(`${BASE_URL}/`);
        const h = resp.headers();
        return h['x-build-id'] || h['cf-ray'] || h['etag'] || 'undiscoverable';
    } catch {
        return 'undiscoverable';
    }
}

export interface ProvenanceRecord {
    assertion: string;
    expected: string;
    actual: string;
    keyFields?: Record<string, unknown>;
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
    records: ProvenanceRecord[];
}

const records: ProvenanceRecord[] = [];

export function record(rec: ProvenanceRecord): void {
    records.push(rec);
}

/** Emit the structured JSON run artifact (PROVENANCE FREEZE) at end of run. */
export async function emitRunArtifact(buildId: string, snapshotId: string): Promise<void> {
    const artifact: RunArtifact = {
        srs: 'SRS-2A-frontend-baseline',
        repo_sha: repoSha(),
        deployment_build_id: buildId,
        data_snapshot_id: snapshotId,
        base_url: BASE_URL,
        utc_time: new Date().toISOString(),
        region: process.env.SRS2A_REGION || process.env.RUNNER_OS || 'local',
        cold_or_warm: process.env.SRS2A_CACHE_STATE || 'unknown',
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
    console.log(`[SRS-2A] run artifact: ${shardOut} (${records.length} records)`);
}

/** Observe a data-snapshot id from the search API manifest etag, if present. */
export async function discoverSnapshotId(
    request: { get: (url: string) => Promise<{ headers(): Record<string, string> }> },
): Promise<string> {
    try {
        const resp = await request.get(`${BASE_URL}/api/v1/search?q=llama&limit=1`);
        return resp.headers()['etag'] || 'unobservable';
    } catch {
        return 'unobservable';
    }
}
