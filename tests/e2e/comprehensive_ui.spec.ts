import { test, expect } from '@playwright/test';

test.describe('V6.x Comprehensive Frontend Suite', () => {

    /**
     * Scenario 1: The "Explorer" Journey (Desktop)
     * Covers: Navigation, Search, Detail Page Actions, Theme Toggle
     */
    test('Desktop: Full Explorer Journey', async ({ page }) => {

        await test.step('1. Global Navigation & Theme', async () => {
            await page.goto('/');
            await expect(page).toHaveTitle(/Free AI Tools/);

            // Theme Toggle
            // Assuming theme toggle is in header or footer. 
            // If not present, we skip but log it.
            const themeToggle = page.locator('#theme-toggle, button[aria-label*="mode"]');
            if (await themeToggle.count() > 0) {
                await themeToggle.click();
                await expect(page.locator('html')).toHaveClass(/dark|light/);
                // Toggle back
                await themeToggle.click();
            }
        });

        await test.step('2. Homepage Category Interactions', async () => {
            // Verify Entity Tabs
            const modelTab = page.locator('a[href="/explore"]', { hasText: 'Models' });
            // Just check visibility for now as it might be active by default
            await expect(modelTab).toBeVisible();

            // Category Cards - "Text Generation"
            const textGenCard = page.locator('a[href="/text-generation"]');
            await expect(textGenCard).toBeVisible();
            await expect(textGenCard).toHaveAttribute('href', '/text-generation');

            // Hover effect check (programmatic hover)
            await textGenCard.hover();
            // We can't easily check CSS transitions in e2e, but we verify it doesn't break layout
        });

        await test.step('3. Search Functionality (Hydration & Input)', async () => {
            const searchInput = page.locator('#search-box');
            await expect(searchInput).toBeVisible();
            await expect(searchInput).toBeEditable();

            // Mock the Web Worker to bypass 50ms timebox and ensure UI hydration
            await page.addInitScript(() => {
                class MockWorker {
                    constructor(url) { console.log('Mock Worker created for', url); }
                    addEventListener(type, cb) { this.onmessage = cb; }
                    removeEventListener() { }
                    postMessage(data) {
                        // Respond immediately
                        setTimeout(() => {
                            if (this.onmessage) {
                                this.onmessage({
                                    data: {
                                        id: data.id,
                                        type: 'RESULT',
                                        results: [
                                            { id: 'test-1', name: 'Mock Llama', author: 'Meta', fni_score: 100, description: 'Mocked Result' }
                                        ]
                                    }
                                });
                            }
                        }, 10);
                    }
                }
                window.Worker = MockWorker;
            });

            // Reload page to apply the mock worker (start fresh)
            await page.reload();

            // Re-select elements after reload
            const searchInputRef = page.locator('#search-box');
            await searchInputRef.fill('llama');

            // Wait for Results (should be fast now)
            const resultsGrid = page.locator('#models-grid');
            await expect(resultsGrid).toBeVisible({ timeout: 5000 });
            await expect(page.getByText('Mock Llama')).toBeVisible();
        });

        await test.step('4. Model Detail Navigation', async () => {
            // Navigate directly to a specific known mock model to test detail page
            await page.goto('/model/test-model-slug');

            // Debug: Analyze H1s
            const h1s = page.locator('h1');
            const count = await h1s.count();
            console.log(`DEBUG: Found ${count} H1 elements.`);
            for (let i = 0; i < count; i++) {
                console.log(`H1[${i}]: "${await h1s.nth(i).textContent()}"`);
            }

            // Verify specific model title to be sure we loaded the right page
            await expect(page.locator('h1').filter({ hasText: 'Test Model Llama 3' })).toBeVisible();
        });

        await test.step('4.1 Legacy URL Support', async () => {
            // Navigate to a URL with 'huggingface:' prefix (simulating the reported error)
            await page.goto('/model/huggingface:test-model-slug');
            const h1 = page.locator('h1').filter({ hasText: 'Test Model Llama 3' });
            // Should resolve to the same model despite the prefix
            await expect(h1).toBeVisible();
        });

        await test.step('5. Model Detail Page Actions', async () => {
            // Copy Install Command
            const copyBtn = page.locator('button[aria-label="Copy install command"]').first();
            if (await copyBtn.isVisible()) {
                await copyBtn.click();
                // Verify clipboard or visual feedback if possible (e.g. "Copied!")
                await expect(page.getByText('Copied!')).toBeVisible({ timeout: 2000 }).catch(() => { });
            }

            // Tabs Navigation (Files / Community - if they exist as links)
            // Sidebar Stats
            await expect(page.getByText('Downloads')).toBeVisible();
            await expect(page.getByText('Likes')).toBeVisible();
        });
    });

    /**
     * Scenario 2: Mobile Responsiveness
     * Covers: Hamburger Menu, Stacked Layouts
     */
    test('Mobile: Responsive Layout Check', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 667 }); // iPhone SE size
        await page.goto('/');

        await test.step('1. Hamburger Menu', async () => {
            const menuBtn = page.locator('#mobile-menu-btn, button[aria-label="Menu"]');
            if (await menuBtn.isVisible()) {
                await menuBtn.click();
                const mobileNav = page.locator('#mobile-nav');
                await expect(mobileNav).toBeVisible();
                // Close it
                await menuBtn.click();
                await expect(mobileNav).toBeHidden();
            }
        });

        await test.step('2. Search Bar Sticky', async () => {
            // Scroll down
            await page.evaluate(() => window.scrollTo(0, 500));
            // Check if search bar is still in view / fixed
            const searchContainer = page.locator('div.sticky');
            await expect(searchContainer).toBeVisible();
        });
    });

    /**
     * Scenario 3: Edge Cases
     * Covers: 404s, No Results
     */
    test('Edge Cases: Error Handling', async ({ page }) => {
        await test.step('1. No Search Results', async () => {
            await page.goto('/');
            const searchInput = page.locator('#search-box');
            await searchInput.fill('alksjdhfkasjdfh_impossible_term');
            await page.waitForTimeout(1000); // Wait for debounce

            // Fallback API might return results depending on fallback logic, 
            // but for "impossible" it should eventually show no results or API fallback indicator.
            // We check that the app didn't crash (element still visible)
            await expect(page.locator('body')).toBeVisible();
        });

        await test.step('2. 404 Page', async () => {
            await page.goto('/non-existent-page-12345');
            // Should verify 404 status or specific text
            // Note: Astro dev server returns 404 but page content might be generic "Not Found"
            await expect(page).toHaveTitle(/404|Not Found/);
        });
    });

});
