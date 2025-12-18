import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    // Fail request that are 404 or 500 automatically? No, we might test for them.
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',

    // WebServer: Build & Serve the static site
    // This uses "npm run preview" to serve "dist/"
    webServer: {
        command: 'npm run build && npm run preview',
        port: 4321,
        reuseExistingServer: !process.env.CI,
        timeout: 120 * 1000,
    },

    use: {
        baseURL: 'http://localhost:4321', // Astro Preview port
        trace: 'on-first-retry',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
