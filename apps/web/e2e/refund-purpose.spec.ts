import { expect, test, type Locator, type Page } from '@playwright/test';

// Real routes/components, synthetic HTTP responses. Not an integrated API journey.
async function touchTarget(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  expect(box?.width).toBeGreaterThanOrEqual(44);
  expect(box?.height).toBeGreaterThanOrEqual(44);
}

async function mockCredits(page: Page, projectType: string) {
  const project = { id: 'project', type: projectType, name: 'Projeto sintético', rooms: [], onboardedAt: '2026-01-01' };
  const credit = {
    id: 'credit',
    projectId: 'project',
    titulo: 'Crédito protegido',
    fornecedor: 'Fornecedor sintético',
    tipoDespesa: 'OUTROS',
    valor: -12_345_678,
    valorTotal: -12_345_678,
    quantidade: 1,
    formaPagamento: 'A_VISTA',
    dataPagamento: '2026-09-10',
    status: 'PAGO',
    canDelete: false,
    sourceAvailableCents: 0,
  };
  const expenses = [
    credit,
    { ...credit, id: 'unknown', titulo: 'Crédito sem capacidade', canDelete: undefined },
    { ...credit, id: 'source', titulo: 'Crédito origem', canDelete: true, cardLast4: '1234' },
    { ...credit, id: 'positive', titulo: 'Despesa positiva', valor: 80_000, valorTotal: 80_000, canDelete: undefined },
  ];
  const writes: Array<{ method: string; path: string; body: unknown }> = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let rejectMetadata = true;
  let rejectDelete = true;
  const json = (body: unknown, status = 200) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
  await page.route('http://localhost:3001/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
      });
    if (path === '/merchant-categories/suggest') return route.fulfill(json({ suggestedTipoDespesa: null }));
    if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(request.method())) {
      writes.push({ method: request.method(), path, body: request.postDataJSON() });
      if (request.method() === 'PATCH' && path.endsWith('/expenses/credit')) {
        if (rejectMetadata) {
          rejectMetadata = false;
          return route.fulfill(json({ message: 'Revise os metadados.' }, 422));
        }
        return route.fulfill(json(credit));
      }
      if (request.method() === 'DELETE' && path.endsWith('/expenses/source')) {
        if (rejectDelete) {
          rejectDelete = false;
          return route.fulfill(json({ message: 'Exclusão não autorizada agora.' }, 409));
        }
        expenses.splice(
          expenses.findIndex((item) => item.id === 'source'),
          1,
        );
        return route.fulfill(json({ ok: true }));
      }
      throw new Error(`Unexpected write: ${request.method()} ${path}`);
    }
    if (path === '/auth/me')
      return route.fulfill(
        json({
          id: 'synthetic-user',
          username: 'synthetic',
          name: 'Synthetic',
          role: 'ADMIN',
          tenantId: 'synthetic-704',
          allowedProjects: ['project'],
          allowedModules: [],
          allowedProjectTypes: [projectType],
        }),
      );
    if (path === '/projects') return route.fulfill(json([project]));
    if (path === '/projects/project') return route.fulfill(json(project));
    if (path === '/projects/project/expenses')
      return route.fulfill(json({ items: expenses, total: expenses.length, page: 1, pageSize: 2000, totalPages: 1 }));
    const expense = expenses.find((item) => path === `/projects/project/expenses/${item.id}`);
    if (expense) return route.fulfill(json(expense));
    if (path.endsWith('/paid-origins')) return route.fulfill(json({ items: [] }));
    if (path.endsWith('/rateio')) return route.fulfill(json({ rateado: false }));
    if (path.endsWith('/monthly-overview/dre-overview'))
      return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path.endsWith('/monthly-overview/account-view'))
      return route.fulfill(
        json({
          mesSelecionado: '2026-09',
          caixaHoje: 0,
          carteiraHoje: 0,
          entrouMes: 0,
          saiuMes: -12_345_678,
          faltaPagarMes: 0,
          recebimentosPrevistosMes: 0,
          sobraPrevista: 0,
          devoCartaoTotal: 0,
          cartoes: [],
          contas: [],
          entradas: [],
          comprasCartao: [],
          saidas: expenses
            .filter((item) => item.valor < 0)
            .map((item) => ({
              id: item.id,
              kind: 'saida',
              descricao: item.titulo,
              data: item.dataPagamento,
              forma: 'cartao',
              valor: item.valor,
              realizado: true,
              status: 'PAGO',
              cardLast4: '1234',
              bankLast4: null,
              tipoDespesa: 'OUTROS',
              isInvoice: false,
              editavel: true,
              // Mock of the server root signal (Expense.valorTotal < 0). Not a permission.
              expenseIsCredit: item.valor < 0,
              dueMonth: null,
              projetoOrigem: null,
            })),
          ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
        }),
      );
    return route.fulfill(json([]));
  });
  return { writes, errors };
}

for (const width of [375, 390, 1280]) {
  for (const surface of ['category', 'general', 'CASA', 'CARRO', 'conta']) {
    test(`signed credit and guarded actions: ${surface} at ${width}px`, async ({ page, baseURL }, info) => {
      test.skip(info.project.name !== 'desktop', 'Explicit responsive viewports');
      await page.setViewportSize({ width, height: 844 });
      await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
      await page.context().addCookies([{ name: 'rf_token', value: 'synthetic-704', url: baseURL! }]);
      const avulsas = surface === 'CASA' || surface === 'CARRO';
      const conta = surface === 'conta';
      const { writes, errors } = await mockCredits(page, avulsas ? surface : conta ? 'PESSOAL' : 'REFORMA');
      await page.goto(conta ? '/projects/project/conta?mes=2026-09' : `/projects/project/expenses?view=${surface}`);
      if (avulsas) await expect(page).toHaveURL(/\/bills\?tab=avulsas$/);
      const rowFor = (title: string) =>
        conta
          ? page.getByTestId('movimentacao-row').filter({ hasText: title })
          : avulsas
            ? width < 768
              ? page.getByRole('article', { name: title })
              : page.getByRole('row').filter({ hasText: title })
            : page.getByRole('group', { name: title, exact: true });
      const row = rowFor('Crédito protegido');
      const money = row.getByText('-R$ 123.456,78', { exact: true });
      await expect(money).toBeVisible();
      expect(
        await money.evaluate((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          return new Set(Array.from(range.getClientRects()).map((r) => Math.round(r.top))).size;
        }),
      ).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await expect(row.getByRole('button', { name: 'Excluir', exact: true })).toHaveCount(0);
      await expect(rowFor('Crédito sem capacidade').getByRole('button', { name: 'Excluir', exact: true })).toHaveCount(
        0,
      );
      await expect(
        row.getByRole('button', { name: /Copiar|Editar rápido|Ratear|Vincular|Paga|Quitar|Clique para alternar/ }),
      ).toHaveCount(0);
      if (!conta)
        await expect(rowFor('Despesa positiva').getByRole('button', { name: 'Excluir', exact: true })).toBeVisible();
      if (conta && width < 768) {
        const more = row.getByRole('button', { name: 'Mais ações' });
        await touchTarget(more);
        await more.click();
        await expect(page.getByRole('button', { name: /Ratear|Vincular|Excluir/, exact: true })).toHaveCount(0);
      }
      const edit =
        conta && width < 768
          ? page.getByRole('button', { name: 'Editar', exact: true }).filter({ visible: true })
          : row.getByRole('button', { name: avulsas || conta ? 'Editar' : 'Editar completo', exact: true });
      await touchTarget(edit);
      await edit.click();
      const title = page.locator('input[name="titulo"]');
      await expect(title).toHaveValue('Crédito protegido');
      await expect(page.getByRole('region', { name: 'Aplicar débito existente' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Ratear compra', exact: true })).toHaveCount(0);
      for (const field of ['tipoDespesa', 'valor', 'formaPagamento', 'dataPagamento']) {
        await expect(page.locator(`[name="${field}"]`)).toBeDisabled();
      }
      await title.fill('Descrição corrigida');
      const save = page.getByRole('button', { name: 'Salvar', exact: true });
      await touchTarget(save);
      await save.click();
      await expect(page.getByText('Revise os metadados.', { exact: true }).first()).toBeVisible();
      await expect(title).toHaveValue('Descrição corrigida');
      await save.click();
      await expect(title).toHaveCount(0);
      const metadata = {
        titulo: 'Descrição corrigida',
        fornecedor: 'Fornecedor sintético',
        ...(!avulsas ? { link: null, imageUrl: null } : {}),
      };
      expect(writes).toEqual([
        { method: 'PATCH', path: '/projects/project/expenses/credit', body: metadata },
        { method: 'PATCH', path: '/projects/project/expenses/credit', body: metadata },
      ]);
      const source = rowFor('Crédito origem');
      if (conta && width < 768) await source.getByRole('button', { name: 'Mais ações' }).click();
      const remove =
        conta && width < 768
          ? page.getByRole('button', { name: 'Excluir', exact: true }).filter({ visible: true })
          : source.getByRole('button', { name: 'Excluir', exact: true });
      await touchTarget(remove);
      page.on('dialog', (dialog) => dialog.accept());
      await remove.click();
      await expect(page.getByText(/Exclusão não autorizada agora/)).toBeVisible();
      expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/projects/project/expenses/source', body: null });
      expect(writes).toHaveLength(3);
      if (conta && width < 768) await source.getByRole('button', { name: 'Mais ações' }).click();
      await remove.click();
      await expect(source).toHaveCount(0);
      expect(writes.at(-1)).toEqual({ method: 'DELETE', path: '/projects/project/expenses/source', body: null });
      expect(writes).toHaveLength(4);
      expect(errors).toEqual([]);
    });
  }
}
