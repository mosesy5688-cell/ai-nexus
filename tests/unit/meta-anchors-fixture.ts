// Shared fixture for the meta-anchors producer tests. Not a suite itself --
// vitest collects only *.test.ts / *.spec.ts, so this file is imported, not run.
// It is split out because CES caps every file, tests included, at 250 lines.
import { expect, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const workspaces: string[] = [];

export async function workspace() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'meta-anchors-'));
    workspaces.push(root);
    const out = path.join(root, 'data');
    const cache = path.join(root, 'cache');
    await fs.mkdir(out, { recursive: true });
    await fs.mkdir(path.join(cache, 'knowledge', 'articles'), { recursive: true });
    await fs.mkdir(path.join(cache, 'reports', 'daily'), { recursive: true });
    return { out, cache };
}

export async function cleanup() {
    vi.restoreAllMocks();
    delete process.env.OUTPUT_DIR;
    delete process.env.CACHE_DIR;
    while (workspaces.length) {
        await fs.rm(workspaces.pop()!, { recursive: true, force: true }).catch(() => {});
    }
}

/** OUTPUT_DIR/CACHE_DIR are read at module scope, so re-import per workspace. */
export async function load(out: string, cache: string) {
    process.env.OUTPUT_DIR = out;
    process.env.CACHE_DIR = cache;
    vi.resetModules();
    return await import('../../scripts/factory/lib/meta-anchors.js');
}

export function captureLog() {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
        lines.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    return lines;
}

export function logLine(lines: string[], marker: string): string {
    const line = lines.find(l => l.includes(marker));
    expect(line, `no log line containing "${marker}"`).toBeDefined();
    return line!;
}

/**
 * The first integer the log prints for this database. Deliberately tolerant of
 * wording so the assertion reads the same number on the pre-fix revision (where
 * the line said "N articles indexed") as on this one.
 */
export function reported(lines: string[], marker: string): number {
    const line = logLine(lines, marker);
    const m = /(\d+)/.exec(line.slice(line.indexOf(marker) + marker.length));
    expect(m, `no count in log line: ${line}`).not.toBeNull();
    return Number(m![1]);
}

/** Reads one labelled quantity out of a log line, by the words that follow it. */
export function quantity(line: string, label: string): number {
    const m = new RegExp(`(\\d+) ${label}`).exec(line);
    expect(m, `no "<n> ${label}" in log line: ${line}`).not.toBeNull();
    return Number(m![1]);
}

export function readRows(out: string, dbFile: string) {
    const db = new Database(path.join(out, dbFile), { readonly: true });
    const rows = db.prepare('SELECT id, umid FROM articles ORDER BY id').all() as
        Array<{ id: string; umid: string | null }>;
    db.close();
    return rows;
}

export async function writeArticle(cache: string, name: string, payload: unknown) {
    const file = path.join(cache, 'knowledge', 'articles', name);
    await fs.writeFile(file, JSON.stringify(payload));
}

export async function writeReport(cache: string, id: string, payload: unknown) {
    const file = path.join(cache, 'reports', 'daily', `${id}.json`);
    await fs.writeFile(file, JSON.stringify(payload));
}
