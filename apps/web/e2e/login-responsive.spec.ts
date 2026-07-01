import { test, expect } from '@playwright/test';

/**
 * Responsividade da tela de login (renderiza sem autenticação → CI-safe).
 * Valida o layout em breakpoints reais (desktop + mobile via os projects).
 */
test.describe('Login — responsivo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading', { name: 'Entrar' })).toBeVisible();
  });

  test('renderiza logo, formulário e botão (labels acessíveis)', async ({ page }) => {
    await expect(page.getByText('LifeOne').first()).toBeVisible();
    await expect(page.getByLabel('Usuário')).toBeVisible();
    await expect(page.getByLabel('Senha')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Entrar' })).toBeVisible();
  });

  test('sem overflow horizontal na viewport', async ({ page }) => {
    const scrollW = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientW = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollW).toBeLessThanOrEqual(clientW + 1);
  });

  test('campo Usuário recebe foco automático', async ({ page }) => {
    const ac = await page.evaluate(() => document.activeElement?.getAttribute('autocomplete'));
    expect(ac).toBe('username');
  });
});

/**
 * Guarda de rota — sem sessão, rota interna redireciona para /login (middleware).
 * CI-safe (não requer API).
 */
test.describe('Guarda de rota', () => {
  test('rota protegida sem sessão redireciona para /login', async ({ page }) => {
    await page.goto('/projects');
    await expect(page).toHaveURL(/\/login/);
  });
});
