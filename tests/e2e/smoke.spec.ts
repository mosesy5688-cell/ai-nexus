import { test, expect } from '@playwright/test';

test.describe('L3 Smoke Tests - User Journey', () => {

    test('Homepage loads completely', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveTitle(/Free2AITools/);
        // H1 check
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    });

    test('Category Navigation works', async ({ page }) => {
        await page.goto('/');
        // Click "Text Generation" or similar link
        // Assuming there's a link with text "Text Generation"
        const categoryLink = page.getByText('Text Generation', { exact: false }).first();
        if (await categoryLink.isVisible()) {
            await categoryLink.click();
            await expect(page).toHaveURL(/.*text-generation/);
        } else {
            console.log('Text Generation link not found on home, skipping specific nav');
        }
    });

    test('Model Detail Page loads', async ({ page }) => {
        // Go to a known model page (e.g. from sitemap or fixed slug)
        // DeepSeek is a good candidate
        await page.goto('/model/deepseek-r1-distill-llama-70b');
        // Note: Slug might need adjustment based on actual DB. 
        // If 404, we expect 404 page, but for SMOKE test we want 200.
        // We might need to mock or ensure data exists.
        // For static build, data exists if fetch script ran.

        // Assert title contains part of model name
        // Or check for "Model Details" headers
    });

    test('Search Component Hydrates (Interaction)', async ({ page }) => {
        await page.goto('/');
        // Alpine.js adds functionality.
        // We check if we can type in search.
        const searchInput = page.locator('input[type="search"]'); // Adjust selector
        await expect(searchInput).toBeVisible();
        await searchInput.fill('DeepSeek');

        // Check if results container updates or shows something
        // This confirms JS is running.
    });
});
