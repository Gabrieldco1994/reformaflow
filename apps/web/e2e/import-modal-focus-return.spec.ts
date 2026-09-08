import { expect, test, type Page, type TestInfo } from '@playwright/test';

/**
 * Follow-up de #683 (`useFocusTrap` + `trapFocus`). Trava o RETORNO de foco dos
 * modais de importação de **extrato** e **fatura**: ao fechar por Escape,
 * Cancelar, Fechar (X) ou Concluir, `document.activeElement` volta ao acionador
 * lógico que permanece na tela — o botão "Lançar" (`ContaQuickActions`) no
 * desktop e o FAB "Lançar" (`[data-launcher="true"]`) no mobile — **nunca** o
 * `<body>` nem um elemento desmontado pelo seletor de conta/cartão.
 *
 * Já funciona hoje via `launcherReturnFocusRef` de `NovaDespesaLauncher` /
 * `MobileLaunchSheetContainer`; este spec impede regressão (o cleanup
 * `previous?.focus()` do `useFocusTrap` do #683 poderia reintroduzir o bug).
 *
 * Prova de mutação (manual, não versionada): comentar
 * `launcherReturnFocusRef.current?.focus()` em `NovaDespesaLauncher` deixa os
 * casos desktop RED (foco cai no `<body>`).
 *
 * Real components, API mockada. Reaproveita o padrão de
 * `import-cta-touch-target.spec.ts` / `import-modal-focus-trap.spec.ts`.
 */

const PID = 'imfr-pessoal';

const j = (b: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
const MODULES = ['monthlyOverview', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts', 'dashboard', 'schedule', 'pendencias', 'recurringBills', 'reminders'];
const ACCOUNT_VIEW = { mesSelecionado: '2026-09', caixaHoje: 0, carteiraHoje: 0, entrouMes: 0, saiuMes: 0, faltaPagarMes: 0, saidaTotal: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0, devoCartaoTotal: 0, cartoes: [], contas: [], saidas: [], comprasCartao: [], entradas: [], ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null } };
const BANK_PREVIEW = { source: 'OFX', periodLabel: '2026-09', total: 1, duplicated: 0, totalAmountCents: 7000, totalDebits: 1, totalCredits: 0, preview: [{ externalId: 'n1', date: '2026-09-01', merchant: 'Padaria', amountCents: 7000, category: null, duplicate: false, willImport: true }] };
const CARD_PREVIEW = { source: 'CSV_NUBANK', periodLabel: '2026-09', total: 1, duplicated: 0, totalAmountCents: 7000, preview: [{ externalId: 'n1', date: '2026-09-01', merchant: 'Padaria', amountCents: 7000, category: null, installmentCurrent: null, installmentTotal: null, duplicate: false, willImport: true }], possibleDuplicates: [], futureInstallments: [] };

async function mockApi(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: 'rf_token', value: 'imfr', url: baseURL }]);
  await page.route('http://localhost:3001/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (p === '/auth/me') return route.fulfill(j({ id: 'u', username: 'imfr', name: 'IMFR', role: 'USER', isGuest: false, tenantId: 't', allowedModules: [...MODULES], allowedProjects: [PID], allowedProjectTypes: ['PESSOAL'] }));
    if (p === '/auth/config') return route.fulfill(j({ registerEnabled: false, guestEnabled: false }));
    if (p === '/projects') return route.fulfill(j([{ id: PID, name: 'Pessoal', type: 'PESSOAL' }]));
    if (p === `/projects/${PID}`) return route.fulfill(j({ id: PID, name: 'Pessoal', type: 'PESSOAL', onboardedAt: '2026-01-01T00:00:00.000Z' }));
    if (/\/bank-accounts$/.test(p) || p === '/tenant/bank-accounts') return route.fulfill(j([
      { id: 'imfr-a1', projectId: PID, institution: 'ITAU', nickname: 'Conta IMFR', last4: '1111' },
      { id: 'imfr-a2', projectId: PID, institution: 'BB', nickname: 'Conta IMFR Dois', last4: '2222' },
    ]));
    if (/\/credit-cards$/.test(p) || p === '/tenant/credit-cards') return route.fulfill(j([
      { id: 'imfr-c1', projectId: PID, institution: 'NUBANK', brand: 'Mastercard', nickname: 'Roxo', last4: '4242' },
      { id: 'imfr-c2', projectId: PID, institution: 'ITAU', brand: 'Visa', nickname: 'Azul', last4: '5555' },
    ]));
    if (/^\/projects\/[^/]+\/expenses$/.test(p)) return route.fulfill(j({ items: [], total: 0, page: 1, pageSize: 2000, totalPages: 0 }));
    if (/^\/projects\/[^/]+\/expenses\/paid-origins$/.test(p)) return route.fulfill(j({ items: [] }));
    if (p.endsWith('/monthly-overview/account-view')) return route.fulfill(j(ACCOUNT_VIEW));
    if (p.endsWith('/monthly-overview/dre-overview')) return route.fulfill(j({ anual: { saldoAcumuladoSerie: [] } }));
    if (p.endsWith('/monthly-overview/origin-items-yearly')) return route.fulfill(j({ year: 2026, kind: 'all', last4: '', total: 0, items: [] }));
    if (p === '/journeys/eligible') return route.fulfill(j([]));
    if (p.includes('/bank-accounts/') && p.endsWith('/import-statement')) return route.fulfill(j(url.searchParams.get('mode') === 'commit' ? { importId: 'i', source: 'OFX', periodLabel: '2026-09', inserted: 1, duplicated: 0, receiptsInserted: 0, cardPayments: 0, aiReclassified: 0, recurrencesCreated: 0, skipped: 0 } : BANK_PREVIEW));
    if (p.includes('/credit-cards/') && p.endsWith('/import-statement')) return route.fulfill(j(url.searchParams.get('mode') === 'commit' ? { source: 'CSV_NUBANK', periodLabel: '2026-09', inserted: 1, duplicated: 0, settled: 0, importId: 'i' } : CARD_PREVIEW));
    return route.fulfill(j([]));
  });
}

const isMobile = (ti: TestInfo) => ti.project.name === 'mobile';

/** Abre o modal de importação com a preview carregada, via launcher real. */
async function openImportModal(page: Page, kind: 'extrato' | 'fatura', mobile: boolean) {
  await page.goto(`/projects/${PID}/conta`);
  await page.getByRole('button', { name: 'Lançar', exact: true }).first().click();
  if (mobile) await page.getByRole('button', { name: /Fatura \/ Extrato/i }).click();
  if (kind === 'extrato') {
    await page.getByRole('button', { name: /Extrato bancário/i }).click();
    // dispatchEvent: o botão do picker desmonta no mesmo commit em que o modal monta.
    await page.locator('[data-mobile-sheet="modal"]').filter({ hasText: 'Para qual conta é esse extrato?' })
      .getByRole('button', { name: /Conta IMFR.*1111/ }).dispatchEvent('click');
  } else {
    await page.getByRole('button', { name: /Fatura (de|do) cart/i }).click();
    await page.locator('[data-mobile-sheet="modal"]').filter({ hasText: 'Para qual cartão é essa fatura?' })
      .getByRole('button', { name: /Roxo/ }).dispatchEvent('click');
  }
  const dialog = page.locator('[data-mobile-sheet="modal"]').filter({ hasText: /Importar (fatura|extrato)/ });
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({ name: 'x.ofx', mimeType: 'text/plain', buffer: Buffer.from('dummy') });
  await dialog.getByRole('button', { name: /Pré-visualizar/i }).click();
  await expect(dialog.getByText(/Após confirmar:/i)).toBeVisible();
  return dialog;
}

/** É o acionador "Lançar" (ContaQuickActions no desktop, FAB no mobile)? */
async function focusIsOnLauncher(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el.tagName === 'BODY') return { ok: false, where: el?.tagName?.toLowerCase() ?? 'null' };
    if (!document.body.contains(el)) return { ok: false, where: 'detached' };
    if (el.closest('[data-mobile-sheet="modal"]')) return { ok: false, where: 'ainda no modal' };
    const isLauncher =
      el.getAttribute('data-launcher') === 'true' ||
      (el.tagName === 'BUTTON' && (el.getAttribute('aria-label') === 'Lançar' || /^\s*Lançar\s*$/.test(el.textContent || '')));
    return { ok: isLauncher, where: isLauncher ? 'Lançar' : `${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 20)}"` };
  });
}

for (const kind of ['extrato', 'fatura'] as const) {
  for (const via of ['Escape', 'Cancelar', 'Fechar', 'Concluir'] as const) {
    test(`${kind} · fechar por ${via} devolve o foco ao "Lançar"`, async ({ page, baseURL }, ti) => {
      const mobile = isMobile(ti);
      await page.setViewportSize(mobile ? { width: 375, height: 812 } : { width: 1280, height: 800 });
      await mockApi(page, baseURL!);
      const dialog = await openImportModal(page, kind, mobile);

      if (via === 'Escape') {
        await page.keyboard.press('Escape');
      } else if (via === 'Cancelar') {
        await dialog.getByRole('button', { name: /^Cancelar$/ }).click();
      } else if (via === 'Fechar') {
        await dialog.getByRole('button', { name: 'Fechar' }).first().click();
      } else {
        await dialog.getByRole('button', { name: /Confirmar importação/i }).click();
        await dialog.getByRole('button', { name: /^(Concluir|Fechar)$/ }).last().click();
      }

      await expect(dialog).not.toBeVisible();
      await expect
        .poll(async () => (await focusIsOnLauncher(page)).ok, { timeout: 2000, message: `${kind}/${via}: foco não voltou ao "Lançar"` })
        .toBe(true);
    });
  }
}
