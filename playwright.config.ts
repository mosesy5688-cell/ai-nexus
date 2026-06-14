import { defineConfig, devices } from '@playwright/test';

// SRS-2A: when BASE_URL is set we run READ-ONLY against deployed prod
// (e.g. https://free2aitools.com) and MUST NOT spin up the local dev server.
// Default behaviour (BASE_URL unset) is unchanged: local dev server on :4321.
const PROD_TARGET = process.env.BASE_URL;

export default defineConfig({
    testDir: './tests/e2e',
    fullyParallel: true,
    // Fail request that are 404 or 500 automatically? No, we might test for them.
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: 'html',

    // WebServer: Run dev server (Cloudflare adapter doesn't support preview).
    // Skipped entirely when targeting deployed prod via BASE_URL.
    webServer: PROD_TARGET
        ? undefined
        : {
              command: 'npm run dev',
              port: 4321,
              reuseExistingServer: !process.env.CI,
              timeout: 120 * 1000,
          },

    use: {
        baseURL: PROD_TARGET || 'http://localhost:4321', // Astro Preview port
        trace: 'on-first-retry',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
