
import { test, expect } from '@playwright/test';

// Cache bust content
const BASE_URL = 'https://free2aitools.com/explore';

test.describe('Explore Page Live Verification', () => {

    test('should load the page and render model cards', async ({ page }) => {
        // Capture browser logs
        page.on('console', msg => console.log('BROWSER LOG:', msg.text()));
        page.on('pageerror', err => console.log('BROWSER ERROR:', err.message));

        const url = BASE_URL + '?ts=' + Date.now();
        console.log('Navigate to ' + url);
        await page.goto(url);

        // 1. Check Title
        await expect(page).toHaveTitle(/Explore Models/);

        // 2. Wait for Loading Skeleton to disappear
        const skeleton = page.locator('#explore-loading');
        await expect(skeleton).not.toBeVisible({ timeout: 20000 });

        // Debug: Check if error is visible
        const errorEl = page.locator('#explore-error');
        if (await errorEl.isVisible()) {
            console.log('ERROR VISIBLE:', await page.locator('#explore-error-msg').textContent());
        }

        // 3. Check for Model Cards in Grid
        const grid = page.locator('#explore-grid');
        const firstCard = grid.locator('.model-card').first();
        await expect(firstCard).toBeVisible({ timeout: 20000 });

        // 4. Verify Model Data (Text content)
        const cardText = await firstCard.textContent();
        console.log('Found Card:', cardText?.substring(0, 50) + '...');
        expect(cardText).not.toContain('undefined');
    });

    test('should filter results when searching', async ({ page }) => {
        const url = BASE_URL + '?ts=' + Date.now();
        await page.goto(url);

        // Wait for initial load
        await expect(page.locator('#explore-grid .model-card').first()).toBeVisible({ timeout: 20000 });

        // Type in search box
        const searchInput = page.locator('#explore-search');
        await searchInput.fill('llama');

        // Wait for grid update
        await page.waitForTimeout(1000);

        // Check if filtering happened
        const cards = page.locator('.model-card');
        await expect(cards.first()).toBeVisible();

        const firstCardText = await cards.first().textContent();
        expect(firstCardText?.toLowerCase()).toContain('llama');
    });

    test('should apply source filter', async ({ page }) => {
        const url = BASE_URL + '?ts=' + Date.now();
        await page.goto(url);
        await expect(page.locator('#explore-grid .model-card').first()).toBeVisible({ timeout: 20000 });

        // Click "Hugging Face" checkbox
        const hfFilter = page.locator('label').filter({ hasText: 'Hugging Face' }).locator('input');
        await hfFilter.check();

        // Wait for update
        await page.waitForTimeout(1000);

        const badge = page.locator('#active-filters').getByText('huggingface');
        await expect(badge).toBeVisible();

        const cards = page.locator('.model-card');
        expect(await cards.count()).toBeGreaterThan(0);
    });

});
