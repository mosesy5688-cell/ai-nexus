/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        include: ['**/*.{test,spec}.ts'],
        // Strictly exclude Playwright (e2e). packages/** is excluded so the root
        // SRS-1 unit-test job stays scoped to tests/srs1 + tests/unit; the
        // packages/sdk workspace ships its OWN vitest.config.ts and runs its
        // tests independently. Test-config scoping only — not a runtime change.
        exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**', 'packages/**'],
        environment: 'node',
        alias: {
            'cloudflare:workers': path.resolve(__dirname, './tests/mocks/cloudflare-workers.ts')
        },
        globals: true
    },
    plugins: [
        // V24.10d: Mock .wasm imports for Vitest (Cloudflare adapter handles these at build time)
        {
            name: 'mock-wasm-imports',
            enforce: 'pre',
            resolveId(source) {
                if (source.endsWith('.wasm') || source.endsWith('.wasm?module')) return '\0mock-wasm';
            },
            load(id) {
                if (id === '\0mock-wasm') return 'export default {};';
            }
        }
    ]
});
