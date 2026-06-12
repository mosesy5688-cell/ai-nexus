import { describe, it, expect } from 'vitest';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import {
    EXPECTED_SOURCES, evaluateSource, evaluateEnrichment, rollUp,
    renderTable, finalLine, indexPrevious, buildDoc,
    DRAFT_YIELD_DROP, DRAFT_ENRICH_RATIO, DRAFT_STALE_DAYS,
} from '../../scripts/ingestion/harvest-health.js';
// @ts-ignore
import { STATUS } from '../../scripts/ingestion/harvest-state.js';

// PR-H2c: the harvest-health aggregator is an OBSERVATION layer. These tests pin
// the ANTI-LYING rules (absence=failure, layered severity, cold-start resilience)
// and the defense-in-depth verdict rules (RED only for an H2a-class escape).

const gated = (s: string) => EXPECTED_SOURCES.find((e: any) => e.source === s);
const small = (s: string) => EXPECTED_SOURCES.find((e: any) => e.source === s);

describe('harvest-health — EXPECTED_SOURCES contract', () => {
    it('lists exactly the 15 workflow-invoked sources', () => {
        expect(EXPECTED_SOURCES.map((e: any) => e.source).sort()).toEqual([
            'agents', 'arxiv', 'benchmark', 'civitai', 'deepspec', 'github',
            'huggingface', 'huggingface-datasets', 'huggingface-papers',
            'kaggle', 'mcp', 'ollama', 'openllm', 'replicate', 'semanticscholar',
        ]);
    });
    it('gates exactly the 6 floor-mapped known-large sources', () => {
        const g = EXPECTED_SOURCES.filter((e: any) => e.gated).map((e: any) => e.source).sort();
        expect(g).toEqual(['arxiv', 'github', 'huggingface', 'huggingface-datasets', 'huggingface-papers', 'semanticscholar']);
    });
});

describe('harvest-health — evaluateSource verdict rules', () => {
    it('GREEN: gated source success above floor', () => {
        const row = evaluateSource(gated('arxiv'),
            { source: 'arxiv', status: STATUS.SUCCESS, yield: 60000 }, 'success', undefined, undefined);
        expect(row.verdict).toBe('green');
    });

    it('GREEN: partial-by-design (enrich_budget) is green, not red', () => {
        const row = evaluateSource(gated('huggingface-datasets'),
            { source: 'huggingface-datasets', status: STATUS.PARTIAL, partial_reason: 'enrich_budget', yield: 4000 },
            'success', undefined, undefined);
        expect(row.verdict).toBe('green');
    });

    it('GREEN: valid_zero clean completion', () => {
        const row = evaluateSource(small('ollama'),
            { source: 'ollama', status: STATUS.VALID_ZERO, yield: 0 }, 'success', undefined, undefined);
        expect(row.verdict).toBe('green');
    });

    it('RED: gated source floor_violation reached merge (H2a escaped)', () => {
        const row = evaluateSource(gated('huggingface'),
            { source: 'huggingface', status: STATUS.FLOOR_VIOLATION, yield: 12, floor_violated: true },
            'success', undefined, undefined);
        expect(row.verdict).toBe('red');
    });

    it('RED (absence=failure): gated source with NO sidecar', () => {
        const row = evaluateSource(gated('github'), null, 'failure', undefined, undefined);
        expect(row.verdict).toBe('red');
        // failure/cancelled job + missing sidecar -> step_killed timeout, not bare missing
        expect(row.status).toBe(STATUS.TIMEOUT);
        expect(row.timeout_kind).toBe('step_killed');
    });

    it('RED: gated failed-class state reached merge', () => {
        const row = evaluateSource(gated('semanticscholar'),
            { source: 'semanticscholar', status: STATUS.FAILED, yield: 0 }, 'success', undefined, undefined);
        expect(row.verdict).toBe('red');
    });

    it('DEGRADED (layered): SMALL source missing sidecar is degraded, never red', () => {
        const row = evaluateSource(small('civitai'), null, 'success', undefined, undefined);
        expect(row.verdict).toBe('degraded');
    });

    it('DEGRADED: small source failed is visibility-degraded, never red', () => {
        const row = evaluateSource(small('replicate'),
            { source: 'replicate', status: STATUS.FAILED, yield: 0 }, 'failure', undefined, undefined);
        expect(row.verdict).toBe('degraded');
    });

    it('DEGRADED: rate_limited above floor (gated) is degraded, not red', () => {
        const row = evaluateSource(gated('huggingface'),
            { source: 'huggingface', status: STATUS.RATE_LIMITED, yield: 9000 }, 'success', undefined, undefined);
        expect(row.verdict).toBe('degraded');
    });

    it('DEGRADED (DRAFT): gated yield < 50% prev despite passing floor', () => {
        const row = evaluateSource(gated('arxiv'),
            { source: 'arxiv', status: STATUS.SUCCESS, yield: 6000 }, 'success', 60000, undefined);
        expect(row.verdict).toBe('degraded');
        expect(row.draft).toBe(true);
    });
});

describe('harvest-health — cold-start resilience (REINFORCEMENT 3)', () => {
    it('indexPrevious returns empty index for null/old-schema doc', () => {
        expect(indexPrevious(null)).toEqual({ prevYield: {}, lastYieldedAt: {} });
        expect(indexPrevious({ schema_version: 0, sources: [] })).toEqual({ prevYield: {}, lastYieldedAt: {} });
    });
    it('previous-based check SKIPPED when previous_yield is null (no false degrade)', () => {
        const row = evaluateSource(gated('arxiv'),
            { source: 'arxiv', status: STATUS.SUCCESS, yield: 10 }, 'success', undefined, undefined);
        expect(row.previous_yield).toBeNull();
        expect(row.verdict).toBe('green'); // not degraded — history unreadable
    });
});

describe('harvest-health — enrichment (params-backfill) never red', () => {
    it('GREEN below 25% ratio', () => {
        expect(evaluateEnrichment({ name: 'params-backfill', ratio: 0.1, fetched: 100, blocked: 10 }).verdict).toBe('green');
    });
    it('DEGRADED above 25% ratio (DRAFT), never red', () => {
        const e = evaluateEnrichment({ name: 'params-backfill', ratio: 0.4, fetched: 100, blocked: 40 });
        expect(e.verdict).toBe('degraded');
        expect(e.draft).toBe(true);
    });
    it('missing record => degraded note, never red', () => {
        expect(evaluateEnrichment(null).verdict).toBe('degraded');
    });
});

describe('harvest-health — rollUp + final line contract', () => {
    const greenRow = { source: 'a', verdict: 'green' };
    const degRow = { source: 'b', verdict: 'degraded' };
    const redRow = { source: 'c', verdict: 'red', status: STATUS.FLOOR_VIOLATION };

    it('RED wins over degraded/green', () => {
        expect(rollUp([greenRow, degRow, redRow] as any, null)).toBe('red');
    });
    it('DEGRADED when any degraded, no red', () => {
        expect(rollUp([greenRow, degRow] as any, null)).toBe('degraded');
    });
    it('enrichment-only degraded pulls overall to degraded', () => {
        expect(rollUp([greenRow] as any, { verdict: 'degraded' })).toBe('degraded');
    });
    it('GREEN when all green', () => {
        expect(rollUp([greenRow] as any, { verdict: 'green' })).toBe('green');
    });

    it('FINAL LINE: green contract replaces "Complete | Total: X"', () => {
        const rows = [{ source: 'a', verdict: 'green' }, { source: 'b', verdict: 'green' }];
        expect(finalLine('green', rows as any)).toBe('HARVEST_HEALTH=green | Complete | 2/2 sources healthy');
    });
    it('FINAL LINE: degraded lists the degraded sources', () => {
        const rows = [{ source: 'a', verdict: 'green' }, { source: 'b', verdict: 'degraded' }];
        expect(finalLine('degraded', rows as any)).toBe('HARVEST_HEALTH=degraded | Complete with degraded sources: b');
    });
    it('FINAL LINE: red carries the reason', () => {
        const rows = [{ source: 'c', verdict: 'red', status: STATUS.FLOOR_VIOLATION }];
        expect(finalLine('red', rows as any)).toBe('HARVEST_HEALTH=red | Failed: c:floor_violation');
    });
});

describe('harvest-health — table + doc shape', () => {
    it('renders a stable HARVEST SOURCE HEALTH markdown table', () => {
        const rows = [evaluateSource(gated('arxiv'),
            { source: 'arxiv', status: STATUS.SUCCESS, yield: 60000 }, 'success', undefined, undefined)];
        const t = renderTable(rows, evaluateEnrichment(null), 'green');
        expect(t).toContain('## HARVEST SOURCE HEALTH');
        expect(t).toContain('| Source | Tier | Status | Yield | Prev | Freshness | Verdict | Notes |');
        expect(t).toContain('| arxiv | gated | success | 60000 |');
    });
    it('buildDoc emits schema_version 1 + carry-forward last_yielded_at', () => {
        const ts = Date.parse('2026-06-12T00:00:00Z');
        const rows = [{ source: 'arxiv', tier: 'gated', gated: true, status: 'success', yield: 100, previous_yield: null, freshness: 'fresh', verdict: 'green', draft: false }];
        const doc = buildDoc('green', rows as any, evaluateEnrichment(null), {}, ts);
        expect(doc.schema_version).toBe(1);
        expect(doc.harvest_health).toBe('green');
        expect(doc.sources[0].last_yielded_at).toBe('2026-06-12T00:00:00.000Z');
        expect(doc.final_line).toContain('HARVEST_HEALTH=green');
    });
});

describe('harvest-health — DRAFT threshold constants are the documented values', () => {
    it('yield-drop 0.5, enrich 0.25, stale 7d', () => {
        expect(DRAFT_YIELD_DROP).toBe(0.5);
        expect(DRAFT_ENRICH_RATIO).toBe(0.25);
        expect(DRAFT_STALE_DAYS).toBe(7);
    });
});
