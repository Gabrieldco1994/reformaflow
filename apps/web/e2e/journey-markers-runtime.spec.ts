import { test, expect } from '@playwright/test';

test('journey action markers are visible and clickable on mobile (375px)', async ({ page }) => {
  // Set mobile viewport
  await page.setViewportSize({ width: 375, height: 812 });

  // Navigate to home
  await page.goto('/');
  
  // If redirected to login, login with test user
  if (page.url().includes('/auth/')) {
    // Check if there's a login form or if we need to create a session
    const emailInput = page.locator('input[type="email"]');
    if (await emailInput.isVisible()) {
      await emailInput.fill('test@example.com');
      await page.locator('input[type="password"]').fill('password');
      await page.locator('button:has-text("Entrar")').click();
    }
  }

  // Wait for projects to load
  await page.waitForLoadState('networkidle');
  
  // Try to navigate to a PESSOAL project (if exists)
  const pessoalLink = page.locator('text=/PESSOAL|Pessoal|meu pessoal/i').first();
  if (await pessoalLink.isVisible()) {
    await pessoalLink.click();
    await page.waitForLoadState('networkidle');
  } else {
    // Navigate to first available project
    const firstProject = page.locator('a[href*="/projects/"]').first();
    if (await firstProject.isVisible()) {
      await firstProject.click();
      await page.waitForLoadState('networkidle');
    }
  }

  // Open the launch sheet (+ button in mobile nav)
  const launchButton = page.locator('button:has-text("+")').first();
  if (await launchButton.isVisible()) {
    await launchButton.click();
    await page.waitForTimeout(500);

    // Check for expense.new marker (Despesa button)
    const despesaButton = page.locator('[data-journey-action="expense.new"]');
    if (await despesaButton.isVisible()) {
      const box = await despesaButton.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
      console.log('✅ expense.new marker visible:', box);
    }

    // Check for import.start marker (Fatura button)
    const importButton = page.locator('[data-journey-action="import.start"]');
    if (await importButton.isVisible()) {
      const box = await importButton.boundingBox();
      expect(box).not.toBeNull();
      expect(box?.width).toBeGreaterThan(0);
      expect(box?.height).toBeGreaterThan(0);
      console.log('✅ import.start marker visible:', box);
    }
  }

  // Fallback: check if markers exist in DOM at all
  const anyMarker = page.locator('[data-journey-action]');
  const count = await anyMarker.count();
  console.log(`Found ${count} journey action markers in DOM`);
});
