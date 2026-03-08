/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
    test: {
        include: ['**/*.{test,spec}.ts'],
        exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'], // Strictly exclude Playwright
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
                if (source.endsWith('.wasm')) return '\0mock-wasm';
            },
            load(id) {
                if (id === '\0mock-wasm') return 'export default {};';
            }
        }
    ]
});
