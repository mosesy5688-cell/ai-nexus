import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore — JS ESM modules (no .d.ts); tested for their runtime contract.
import {
    emitTerminalState, deriveSuccessStatus, buildSidecar, STATUS,
    PARTIAL_REASON, TIMEOUT_KIND,
} from '../../scripts/ingestion/harvest-state.js';
// @ts-ignore
import { harvestSingle } from '../../scripts/ingestion/harvest-single.js';

// PR-H2c: per-source terminal state. The sidecar is an OBSERVATION artifact —
// writing/printing it MUST NEVER alter the harvest exit code (REINFORCEMENT 1).

describe('harvest-state — deriveSuccessStatus precedence', () => {
    it('partial-by-design (budgetCapped) -> partial/enrich_budget (highest precedence)', () => {
        const r = deriveSuccessStatus({ total: 4000, rateLimited: true, terminalMeta: { budgetCapped: true } });
        expect(r.status).toBe(STATUS.PARTIAL);
        expect(r.partial_reason).toBe(PARTIAL_REASON.ENRICH_BUDGET);
    });
    it('rate-limit early-finish above floor -> partial/rate_limit_early_finish', () => {
        const r = deriveSuccessStatus({ total: 9000, rateLimited: true, terminalMeta: null });
        expect(r.status).toBe(STATUS.PARTIAL);
        expect(r.partial_reason).toBe(PARTIAL_REASON.RATE_LIMIT_EARLY_FINISH);
    });
    it('genuine zero clean completion -> valid_zero', () => {
        expect(deriveSuccessStatus({ total: 0, rateLimited: false, terminalMeta: null }).status).toBe(STATUS.VALID_ZERO);
    });
    it('normal completion -> success', () => {
        expect(deriveSuccessStatus({ total: 500, rateLimited: false, terminalMeta: null }).status).toBe(STATUS.SUCCESS);
    });
});

describe('harvest-state — buildSidecar normalization', () => {
    it('always emits schema_version 1 + errors[] array + boolean defaults', () => {
        const sc = buildSidecar({ source: 'arxiv', status: STATUS.SUCCESS, yield: 10, duration_ms: 5 });
        expect(sc.schema_version).toBe(1);
        expect(Array.isArray(sc.errors)).toBe(true);
        expect(sc.had_adapter_error).toBe(false);
        expect(sc.floor_violated).toBe(false);
        expect(sc.duration_ms).toBe(5);
    });
    it('omits null terminal_meta but keeps a non-null one', () => {
        expect(buildSidecar({ source: 'a', terminal_meta: null }).terminal_meta).toBeUndefined();
        expect(buildSidecar({ source: 'a', terminal_meta: { cause: 'rate_limited' } }).terminal_meta).toEqual({ cause: 'rate_limited' });
    });
});

describe('harvest-state — emitTerminalState IO (REINFORCEMENT 1)', () => {
    let tmp: string; let cwd: string;
    beforeEach(() => {
        cwd = process.cwd();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2c-'));
        process.chdir(tmp);
    });
    afterEach(() => {
        process.chdir(cwd);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        vi.restoreAllMocks();
    });

    it('writes a <1KB sidecar file AND prints the fixed HARVEST_STATE machine line', () => {
        const logged: string[] = [];
        vi.spyOn(console, 'log').mockImplementation((m: any) => { logged.push(String(m)); });
        const sc = emitTerminalState({ source: 'arxiv', status: STATUS.SUCCESS, yield: 60000, duration_ms: 1000 });

        const file = path.join(tmp, 'data', 'state', 'harvest-state-arxiv.json');
        expect(fs.existsSync(file)).toBe(true);
        expect(fs.statSync(file).size).toBeLessThan(1024);
        expect(JSON.parse(fs.readFileSync(file, 'utf-8')).source).toBe('arxiv');
        expect(logged.some(l => l.startsWith('HARVEST_STATE {'))).toBe(true);
        expect(sc.status).toBe(STATUS.SUCCESS);
    });

    it('a sidecar WRITE FAILURE degrades to ::warning and NEVER throws (exit code untouched)', () => {
        vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { throw new Error('EROFS read-only'); });
        const warns: string[] = [];
        vi.spyOn(console, 'warn').mockImplementation((m: any) => { warns.push(String(m)); });
        vi.spyOn(console, 'log').mockImplementation(() => {});
        expect(() => emitTerminalState({ source: 'github', status: STATUS.SUCCESS, yield: 1 })).not.toThrow();
        expect(warns.some(w => w.includes('::warning::harvest-state sidecar write failed'))).toBe(true);
    });
});

// Integration: the sidecar must reflect the terminal path harvest-single took,
// while leaving the H2a exit semantics bit-identical.
describe('harvest-single — terminal-state integration', () => {
    let tmp: string; let cwd: string;
    beforeEach(() => {
        cwd = process.cwd();
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'h2c-hs-'));
        process.chdir(tmp);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        process.chdir(cwd);
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
        vi.restoreAllMocks();
    });

    const readSidecar = (src: string) => {
        const f = path.join(tmp, 'data', 'state', `harvest-state-${src}.json`);
        return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf-8')) : null;
    };

    function bufferAdapter(n: number, extra: any = {}) {
        const items = Array.from({ length: n }, (_, i) => ({ id: `e${i}` }));
        return { entityTypes: ['model'], fetch: async () => items, normalize: (r: any) => r, ...extra };
    }

    it('success path: gated source above floor -> status=success sidecar, NO result.error', async () => {
        const res = await harvestSingle('arxiv', { limit: 6000, skipBridge: true, _adapter: bufferAdapter(6000) });
        expect(res.error).toBeUndefined();
        const sc = readSidecar('arxiv');
        expect(sc.status).toBe(STATUS.SUCCESS);
        expect(sc.yield).toBe(6000);
        expect(typeof sc.duration_ms).toBe('number');
    });

    it('floor_violation below floor: status=floor_violation + result.error (H2a unchanged)', async () => {
        const res = await harvestSingle('github', { limit: 5, skipBridge: true, _adapter: bufferAdapter(3) });
        expect(res.error).toMatch(/floor violation/);
        const sc = readSidecar('github');
        expect(sc.status).toBe(STATUS.FLOOR_VIOLATION);
        expect(sc.floor_violated).toBe(true);
    });

    it('floor_violation WITH cause=rate_limited when a rate-limit early-finish drove the shortfall', async () => {
        const { RateLimitExceededError } = await import('../../scripts/ingestion/adapters/base-adapter.js');
        const adapter = {
            entityTypes: ['model'],
            fetch: async () => { throw new RateLimitExceededError('huggingface', '120'); },
            normalize: (r: any) => r,
        };
        const res = await harvestSingle('huggingface', { limit: 5, skipBridge: true, _adapter: adapter });
        expect(res.error).toMatch(/floor violation/); // H2a gate still fires (exit semantics unchanged)
        const sc = readSidecar('huggingface');
        expect(sc.status).toBe(STATUS.FLOOR_VIOLATION);
        expect(sc.terminal_meta).toEqual({ cause: STATUS.RATE_LIMITED });
    });

    it('partial-by-design (enrich_budget): adapter.terminalMeta -> status=partial, NO result.error', async () => {
        // ollama is un-floored; adapter signals a budget cap via terminalMeta.
        const adapter = bufferAdapter(50, { terminalMeta: { budgetCapped: true, processed: 50, total: 200 } });
        const res = await harvestSingle('ollama', { limit: 200, skipBridge: true, _adapter: adapter });
        expect(res.error).toBeUndefined();
        const sc = readSidecar('ollama');
        expect(sc.status).toBe(STATUS.PARTIAL);
        expect(sc.partial_reason).toBe(PARTIAL_REASON.ENRICH_BUDGET);
    });

    it('rate_limited above floor (un-floored small source): status=partial/rate_limit_early_finish, exit 0', async () => {
        const { RateLimitExceededError } = await import('../../scripts/ingestion/adapters/base-adapter.js');
        // Buffer some yield then NOT throw — simulate rate-limit by throwing with prior yield.
        // ollama is un-floored so no floor gate; rate-limit early finish stays success.
        const adapter = {
            entityTypes: ['model'],
            fetch: async (opts: any) => {
                await opts.onBatch(Array.from({ length: 20 }, (_, i) => ({ id: `r${i}` })));
                throw new RateLimitExceededError('ollama', '120');
            },
            normalize: (r: any) => r,
        };
        const res = await harvestSingle('ollama', { limit: 100, skipBridge: true, _adapter: adapter });
        expect(res.error).toBeUndefined();
        const sc = readSidecar('ollama');
        expect(sc.status).toBe(STATUS.PARTIAL);
        expect(sc.partial_reason).toBe(PARTIAL_REASON.RATE_LIMIT_EARLY_FINISH);
        expect(sc.yield).toBe(20);
    });

    it('request_timeout: FetchError kind=abort -> status=timeout + terminal_meta.timeout_kind=request_timeout', async () => {
        const { FetchError } = await import('../../scripts/ingestion/adapters/base-adapter.js');
        const adapter = {
            entityTypes: ['paper'],
            fetch: async () => { throw new FetchError('arxiv', 'abort', 'hung request'); },
            normalize: (r: any) => r,
        };
        const res = await harvestSingle('arxiv', { limit: 5, skipBridge: true, _adapter: adapter });
        expect(res.error).toBeTruthy(); // hard failure (H2a fail-loud unchanged)
        const sc = readSidecar('arxiv');
        expect(sc.status).toBe(STATUS.TIMEOUT);
        expect(sc.terminal_meta.timeout_kind).toBe(TIMEOUT_KIND.REQUEST_TIMEOUT);
        expect(sc.had_adapter_error).toBe(true);
    });
});
