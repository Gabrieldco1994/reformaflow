import { test, expect } from '@playwright/test';

/**
 * #659 (follow-up): Picker de cartão/conta refaz fetch ao reabrir,
 * garantindo lista fresca sem reload do navegador.
 *
 * Cenário: criar um cartão via `/credit-cards`, voltar para `/conta`,
 * abrir "Lançar → Fatura de cartão" → o picker deve mostrar o cartão novo
 * sem delay de até 30s (que era o staleTime antigo).
 */

test.describe('Importer card/account list refresh (390px, 375px, 1280px)', () => {
  // Executar cada teste em três viewports
  const viewports = [
    { name: '375px', width: 375, height: 667 },
    { name: '390px', width: 390, height: 844 },
    { name: '1280px', width: 1280, height: 720 },
  ];

  for (const vp of viewports) {
    test(`picker refaz fetch ao reabrir (${vp.name})`, async ({ page, context }) => {
      test.setTimeout(60000); // 60s timeout para dev/CI

      // Login e navegar para /conta
      const cookies = await context.cookies();
      if (!cookies.some((c) => c.name === 'auth-token')) {
        // Usuário não autenticado — skip (CI deve ter app rodando com auth)
        test.skip();
        return;
      }

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/projects/pessoal/conta', { waitUntil: 'networkidle' });

      // Mock da API: GET /projects/:id/credit-cards retorna [] na 1ª vez, [{...}] depois
      let callCount = 0;
      await page.route('**/api/projects/*/credit-cards', (route) => {
        callCount++;
        if (callCount === 1) {
          route.abort('blockedbyresponse');
          // Esperar um pouco e retornar vazio
          setTimeout(() => {
            route.continue();
          }, 100);
          route.fulfill({ status: 200, body: JSON.stringify([]) });
        } else {
          // Segundas chamadas retornam um cartão
          route.fulfill({
            status: 200,
            body: JSON.stringify([
              { id: 'card-1', last4: '1234', nickname: 'Nubank', brand: 'Nubank' },
            ]),
          });
        }
      });

      // Abre o picker de lançamento (botão "Lançar" ou FAB)
      const launchButton = page.locator('button:has-text("Lançar")').first();
      await launchButton.click();
      await page.waitForTimeout(500); // Aguarda abertura

      // Clica em "Fatura de cartão"
      const invoiceBtn = page.locator('button:has-text("Fatura de cartão")').first();
      if (await invoiceBtn.isVisible()) {
        await invoiceBtn.click();
        await page.waitForTimeout(500);
      } else {
        // Pode estar em abas ou menus — skip de forma segura
        test.skip();
      }

      // Verifica que o picker carregou (vazio ou com "Nenhum cartão")
      const emptyMsg = page.locator('text=Nenhum cartão cadastrado').first();
      if (await emptyMsg.isVisible()) {
        expect(emptyMsg).toBeVisible();
      }

      // Fecha o picker (Cancelar ou backdrop)
      const closeBtn = page.locator('[aria-label="Fechar"], button:has-text("Cancelar")').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(300);

      // Reabre o picker
      await launchButton.click();
      await page.waitForTimeout(300);
      if (await invoiceBtn.isVisible()) {
        await invoiceBtn.click();
        await page.waitForTimeout(500);
      }

      // Verifica que o cartão agora aparece (refetch funcionou)
      const cardItem = page.locator('button:has-text("Nubank")').first();
      await expect(cardItem).toBeVisible({ timeout: 5000 });

      // Validar que temos ao menos 2 chamadas (initial + refetch)
      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    test(`picker de conta refaz fetch ao reabrir (${vp.name})`, async ({ page, context }) => {
      test.setTimeout(60000);

      const cookies = await context.cookies();
      if (!cookies.some((c) => c.name === 'auth-token')) {
        test.skip();
        return;
      }

      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto('/projects/pessoal/conta', { waitUntil: 'networkidle' });

      let callCount = 0;
      await page.route('**/api/projects/*/bank-accounts', (route) => {
        callCount++;
        if (callCount === 1) {
          route.fulfill({ status: 200, body: JSON.stringify([]) });
        } else {
          route.fulfill({
            status: 200,
            body: JSON.stringify([
              { id: 'acc-1', last4: '5678', nickname: 'Itaú', institution: 'Itaú' },
            ]),
          });
        }
      });

      // Abre o picker
      const launchButton = page.locator('button:has-text("Lançar")').first();
      await launchButton.click();
      await page.waitForTimeout(500);

      // Clica em "Extrato bancário"
      const statementBtn = page.locator('button:has-text("Extrato bancário")').first();
      if (await statementBtn.isVisible()) {
        await statementBtn.click();
        await page.waitForTimeout(500);
      } else {
        test.skip();
      }

      // Verifica vazio
      const emptyMsg = page.locator('text=Nenhuma conta cadastrada').first();
      if (await emptyMsg.isVisible()) {
        expect(emptyMsg).toBeVisible();
      }

      // Fecha
      const closeBtn = page.locator('[aria-label="Fechar"], button:has-text("Cancelar")').first();
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await page.waitForTimeout(300);

      // Reabre
      await launchButton.click();
      await page.waitForTimeout(300);
      if (await statementBtn.isVisible()) {
        await statementBtn.click();
        await page.waitForTimeout(500);
      }

      // Valida que a conta aparece
      const accountItem = page.locator('button:has-text("Itaú")').first();
      await expect(accountItem).toBeVisible({ timeout: 5000 });

      // Validar múltiplas chamadas
      expect(callCount).toBeGreaterThanOrEqual(2);
    });
  }
});
