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
});
