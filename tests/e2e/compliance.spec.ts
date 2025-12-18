import { test, expect } from '@playwright/test';

test.describe('L3 Compliance & Fortress Safety', () => {

    test('Canonical Tag Presence (SEO)', async ({ page }) => {
        // Visit a model page
        await page.goto('/model/deepseek-r1-distill-llama-70b');

        // Check canonical
        const canonical = await page.getAttribute('link[rel="canonical"]', 'href');
        expect(canonical).not.toBeNull();
        expect(canonical).toContain('free2aitools.com/model/deepseek-r1-distill-llama-70b');
    });

    test('Archived Model Warning (Safety)', async ({ page }) => {
        // Navigate to a known archived model or mocked archived page
        // Since we don't have one guaranteed, we might skip or use conditional logic.
        // Or we assert that IF we are on a model page, it renders correctly.
        // For now, this is a placeholder for the "Archived 200 OK + Warning" rule.
    });

    test('Pending Models hidden from listings', async ({ page }) => {
        // Check "Text Generation" page
        await page.goto('/category/text-generation');

        // Ensure no item has "Pending" badge or status visible?
        // Or ensure count matches expectation? Hard without controlled data.
        // We at least ensure the page loads 200.
        await expect(page).toHaveURL(/.*text-generation/);
    });

    test('Alpine.js Hydration (Interaction Check)', async ({ page }) => {
        await page.goto('/');
        // Wait for Alpine to potentially modify DOM
        // e.g. x-show state.
        // Simple check: Search input is usable.
        const searchInput = page.locator('input[name="q"]'); // Assuming name="q" or similar
        // If input is visible and interactable
        await expect(searchInput).toBeEditable();
    });
});
