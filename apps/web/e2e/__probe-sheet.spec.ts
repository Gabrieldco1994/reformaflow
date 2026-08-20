import { expect, test } from '@playwright/test';
test('dump sheet', async ({ page, baseURL }) => {
  await page.context().addCookies([{ name: 'rf_token', value: 'x', url: baseURL! }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const p = new URL(route.request().url()).pathname;
    const j = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/auth/me') return route.fulfill(j({
      id: 'g', username: 'g', name: 'Convidado', role: 'ADMIN', isGuest: true,
      tenantId: 't', allowedModules: ['dashboard','expenses','receipts'],
      allowedProjects: [], allowedProjectTypes: ['PESSOAL','REFORMA'],
    }));
    if (p === '/projects/guest-505-pessoal') return route.fulfill(j({ id: 'guest-505-pessoal', name: 'Pessoal (Demo)', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    return route.fulfill(j([]));
  });
  await page.goto('/projects/guest-505-pessoal/dashboard');
  const sheet = page.getByRole('dialog');
  await expect(async () => {
    await page.getByRole('button', { name: 'Mais opções' }).click();
    await expect(sheet).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15000 });
  console.log('>>> ADMIN LINKS IN SHEET:', await sheet.locator('a[href="/admin/users"]').count());
  console.log('>>> ALL HREFS:', await sheet.locator('a').evaluateAll((n) => n.map((e) => (e as HTMLAnchorElement).getAttribute('href'))));
});
