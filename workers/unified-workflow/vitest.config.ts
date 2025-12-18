/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        include: ['tests/unit/**/*.{test,spec}.ts'],
        environment: 'node',
        coverage: {
            provider: 'v8'
        }
    },
});
