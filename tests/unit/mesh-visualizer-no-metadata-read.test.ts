/**
 * Work order M guard: MeshVisualizer initiates NO site-metadata read.
 *
 * WHY: src/components/mesh/MeshVisualizer.astro used to `await
 * loadSiteMetadata('mesh_stats')` in its frontmatter while its template read
 * none of the resulting values. The read was removed. This guard pins the
 * removal so it cannot silently return.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT: it proves only that this component
 * does not initiate that read and still renders its five nav entries. It makes
 * NO claim about home-page latency, /ranking, or any wait-bound question.
 *
 * ISOLATION MODEL: the component is compiled with @astrojs/compiler using the
 * same option set Astro's own build uses, then instantiated against an EXPLICIT
 * binding registry. No module resolution happens at all, so the module can only
 * see the namespaces handed to it: the reader stub cannot be bypassed and the
 * real reader (with its sqlite/VFS/R2 chain) is unreachable by construction.
 * An unregistered specifier, a non-stub namespace or an unsupported import
 * clause ABORTS (fail-closed) rather than falling back. Outbound network is
 * blocked in-process, independently of PATH, and the block is proven effective
 * before the render assertions run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { transform } from '@astrojs/compiler';
import * as ASTRO_RUNTIME from 'astro/compiler-runtime';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import net from 'node:net';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const COMPONENT = 'src/components/mesh/MeshVisualizer.astro';
const READER = '../../utils/vfs-site-metadata.js';
const RUNTIME = 'astro/compiler-runtime';
const SENTINEL = 'mesh-visualizer-isolated-reader-stub';
// Numbers no real payload would carry, so any leak into the HTML is obvious.
const STUB_NODES = 424242;
const STUB_EDGES = 313131;
const EXPECTED = [
    { label: 'Models', href: '/models' },
    { label: 'Tools', href: '/tools' },
    { label: 'Datasets', href: '/datasets' },
    { label: 'Papers', href: '/papers' },
    { label: 'Knowledge', href: '/knowledge' }
];

// --- P-2: outbound block, independent of PATH, covering this process. -------
const outbound: string[] = [];
const deny = (tag: string) => (..._a: unknown[]): never => {
    outbound.push(tag);
    throw new Error(`E_OUTBOUND_BLOCKED:${tag}`);
};
const realFetch = globalThis.fetch;
const realConnect = net.Socket.prototype.connect;
(globalThis as { fetch: unknown }).fetch = deny('fetch');
net.Socket.prototype.connect = deny('net.Socket.connect') as never;
afterAll(() => {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
});

// --- Reader stub ------------------------------------------------------------
function makeStub() {
    const calls: unknown[][] = [];
    const ns = {
        __STUB__: SENTINEL,
        loadSiteMetadata: (...args: unknown[]) => {
            calls.push(args);
            return Promise.resolve({ nodes: STUB_NODES, edges: STUB_EDGES, by_type: {} });
        }
    };
    return { ns, calls };
}

// --- Compile / instantiate harness ------------------------------------------
const compile = async (filename: string, source: string): Promise<string> =>
    (await transform(source, {
        filename, sourcemap: false, internalURL: RUNTIME,
        resultScopedSlot: true, resolvePath: async (s: string) => s
    })).code;

const specifiersOf = (code: string): string[] =>
    [...code.matchAll(/^[ \t]*import[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);

const AsyncFunction = Object.getPrototypeOf(async () => { /* noop */ }).constructor as
    new (arg: string, body: string) => (ns: unknown[]) => Promise<unknown>;

async function instantiate(code: string, registry: Record<string, unknown>): Promise<unknown> {
    for (const [spec, ns] of Object.entries(registry)) {
        if (spec === RUNTIME) continue;
        if ((ns as { __STUB__?: string })?.__STUB__ !== SENTINEL) throw new Error(`E_NOT_A_STUB:${spec}`);
    }
    const slots: unknown[] = [];
    const binds: string[] = [];
    let body = code.replace(
        /^[ \t]*import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"];?/gm,
        (_m: string, clause: string, spec: string) => {
            if (!(spec in registry)) throw new Error(`E_UNREGISTERED_IMPORT:${spec}`);
            const i = slots.push(registry[spec]) - 1;
            const c = clause.trim();
            if (c.startsWith('{')) binds.push(`const ${c.replace(/\bas\b/g, ':')} = __ns[${i}];`);
            else if (c.startsWith('* as ')) binds.push(`const ${c.slice(5).trim()} = __ns[${i}];`);
            else throw new Error(`E_UNSUPPORTED_IMPORT_CLAUSE:${c}`);
            return '';
        }
    );
    body = body.replace(/^export const /gm, 'const ').replace(/^export default\s+/gm, '__default = ');
    if (/^[ \t]*(import|export)\s/m.test(body)) throw new Error('E_UNTRANSFORMED_MODULE_SYNTAX');
    const fn = new AsyncFunction('__ns', `let __default;\n${binds.join('\n')}\n${body}\nreturn __default;`);
    return await fn(slots);
}

const renderIsolated = async (source: string, registry: Record<string, unknown>): Promise<string> => {
    const Component = await instantiate(await compile(resolve(ROOT, COMPONENT), source), registry);
    const container = await AstroContainer.create();
    return container.renderToString(Component as Parameters<typeof container.renderToString>[0]);
};

const parseEntries = (html: string) =>
    [...html.matchAll(/<a href="([^"]*)"[\s\S]*?tracking-tighter">\s*([^<]*?)\s*<\/div>/g)]
        .map((m) => ({ href: m[1], label: m[2] }));

const SRC = readFileSync(resolve(ROOT, COMPONENT), 'utf8');
// Targeted mutant: put the removed read back at the top of the frontmatter.
const MUTANT = SRC.replace(/^---\r?\n/, (m) =>
    `${m}import { loadSiteMetadata } from '${READER}';\n`
    + `const __reintroduced = await loadSiteMetadata('mesh_stats');\n`);

const stub = makeStub();
let html = '';
beforeAll(async () => {
    html = await renderIsolated(SRC, { [RUNTIME]: ASTRO_RUNTIME, [READER]: stub.ns });
});

describe('precondition: the isolation harness is fail-closed', () => {
    it('the targeted mutant really differs from the shipped source', () => {
        expect(MUTANT).not.toEqual(SRC);
        expect(MUTANT).toContain("loadSiteMetadata('mesh_stats')");
    });

    it('outbound network is blocked in this process, and the block is effective', () => {
        // Both denials throw synchronously, so no request can ever be dispatched.
        expect(() => new net.Socket().connect(443, 'example.invalid')).toThrow(/E_OUTBOUND_BLOCKED/);
        expect(() => fetch('https://example.invalid/')).toThrow(/E_OUTBOUND_BLOCKED/);
        expect(outbound).toEqual(['net.Socket.connect', 'fetch']);
    });

    it('a missing stub aborts instead of falling back to the real reader', async () => {
        await expect(renderIsolated(MUTANT, { [RUNTIME]: ASTRO_RUNTIME }))
            .rejects.toThrow(`E_UNREGISTERED_IMPORT:${READER}`);
    });

    it('a namespace that is not the stub aborts', async () => {
        const lookalike = { loadSiteMetadata: async () => ({ nodes: 1, edges: 1 }) };
        await expect(renderIsolated(MUTANT, { [RUNTIME]: ASTRO_RUNTIME, [READER]: lookalike }))
            .rejects.toThrow(`E_NOT_A_STUB:${READER}`);
    });

    it('module syntax the harness cannot bind aborts', async () => {
        await expect(instantiate('export function x() {}', {})).rejects
            .toThrow('E_UNTRANSFORMED_MODULE_SYNTAX');
    });
});

describe('V-1: the component no longer calls the reader', () => {
    it('source level: no reader import and no awaited call in the frontmatter', () => {
        const frontmatter = SRC.split(/^---\r?$/m)[1] ?? '';
        expect(frontmatter.length).toBeGreaterThan(0);
        expect(frontmatter).not.toMatch(/from\s+['"][^'"]*vfs-site-metadata/);
        expect(frontmatter).not.toMatch(/loadSiteMetadata\s*\(/);
        expect(frontmatter).not.toMatch(/\bawait\b/);
    });

    it('build-output level: the compiled module imports only the Astro runtime', async () => {
        expect(specifiersOf(await compile(resolve(ROOT, COMPONENT), SRC))).toEqual([RUNTIME]);
    });

    it('the import census discriminates: the mutant does list the reader', async () => {
        expect(specifiersOf(await compile(resolve(ROOT, COMPONENT), MUTANT))).toEqual([RUNTIME, READER]);
    });
});

describe('V-3: the read itself is what is asserted', () => {
    it('rendering the component initiates ZERO reader calls', () => {
        expect(stub.calls).toEqual([]);
    });

    it('no stub payload reaches the rendered output', () => {
        expect(html).not.toContain(String(STUB_NODES));
        expect(html).not.toContain(String(STUB_EDGES));
    });

    it('negative control: the same harness DOES record the read for the mutant', async () => {
        const mutantStub = makeStub();
        const out = await renderIsolated(MUTANT, { [RUNTIME]: ASTRO_RUNTIME, [READER]: mutantStub.ns });
        expect(mutantStub.calls).toEqual([['mesh_stats']]);
        expect(parseEntries(out)).toHaveLength(EXPECTED.length);
    });
});

describe('V-2: all five nav entries survive the removal', () => {
    it('renders exactly five nav entries', () => {
        expect(parseEntries(html)).toHaveLength(5);
    });

    EXPECTED.forEach((expected, index) => {
        it(`entry ${index} is ${expected.label} -> ${expected.href}`, () => {
            const entry = parseEntries(html)[index];
            expect(entry, `missing nav entry at index ${index}`).toBeDefined();
            expect(entry.label).toBe(expected.label);
            expect(entry.href).toBe(expected.href);
        });
    });

    it('entry order, labels and hrefs match exactly, with no extras', () => {
        expect(parseEntries(html)).toEqual(EXPECTED);
    });
});
