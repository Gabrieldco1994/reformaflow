import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * #704 — resíduos visuais do crédito atribuído, em 375/390/1280×800 (FE RED, TEST-ONLY).
 *
 * CONTRATO DE UI, NÃO JORNADA REAL: rotas reais do app, HTTP de `localhost:3001` falso (declarado
 * aqui), corpos literais conformes ao contrato. Nada aqui prova o backend nem finanças.
 *
 *  A) Edição do crédito rateado (`RateioDetalheSection`): Total/Rateado/Sobra em 375/390 ficam em blocos
 *     verticais (rótulo + valor), valor inteiro numa linha, sem sobreposição/corte/rolagem horizontal;
 *     em 1280 seguem em colunas. Medido por caixas (Range/getBoundingClientRect), não por classe.
 *  B/C) Detalhe do crédito que vem de `comprasCartao`: "Situação na fatura" (valor e ajuda, sem trocar o
 *     status) e "Categoria" no lugar de "Finalidade"; fora desse contexto segue "Status"/"Finalidade".
 */
const OWNER = 'proj-owner';
const ROOT = `/projects/${OWNER}/expenses/credit`;
const RATEIO = `${ROOT}/rateio`;
const NEGATIVE_123 = /(-\s*R\$\s*123\.456,78|R\$\s*-\s*123\.456,78)/;
const INVOICE_HELP = 'Este status acompanha a quitação da fatura, não o status do crédito importado. Atribuir finalidade não quita a fatura.';

type Write = { method: string; path: string };

async function mockApi(page: Page) {
  const writes: Write[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  const anchor = { id: 'project', tenantId: 't-704', createdByUserId: null, type: 'PESSOAL', name: 'Pessoal', description: null, startDate: null, endDate: null, createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z', deletedAt: null, onboardedAt: '2026-01-01T12:00:00.000Z' };
  const row = (over: Record<string, unknown>) => ({
    kind: 'saida', forma: 'cartao', valor: -12_345_678, realizado: true, status: 'PAGO', cardLast4: '1234', bankLast4: null, tipoDespesa: 'OUTROS',
    isInvoice: false, editavel: true, expenseIsCredit: true, dueMonth: null, projetoOrigem: null, ...over,
  });
  // Representação SINTÉTICA de harness (id composto + compra à vista do projeto dono): não é captura comprovada de dados reais.
  const assignedCredit = row({ id: 'credit#2', foreignExpenseId: 'credit', parcelaIndex: 2, descricao: 'Crédito atribuído', data: '2026-09-10T00:00:00.000Z', projetoOrigem: { id: OWNER, name: 'Reforma Dona', type: 'REFORMA' } });
  // Formas do produtor real de `comprasCartao`: PLANEJADO enquanto a fatura não é paga; a fatura é `saidas` com `isInvoice`.
  const cardCredit = row({ id: 'credit-card', descricao: 'Crédito no cartão', data: '2026-09-11T00:00:00.000Z', realizado: false, status: 'PLANEJADO', dueMonth: '2026-09' });
  const accountCredit = row({ id: 'credit-account', descricao: 'Crédito na conta', data: '2026-09-12T00:00:00.000Z', forma: 'pix', cardLast4: null, bankLast4: '9876' });
  const invoice = row({ id: 'inv-1', descricao: 'Fatura Cartão 1234', data: '2026-09-15T00:00:00.000Z', valor: 500_000, expenseIsCredit: undefined, isInvoice: true, realizado: false, status: 'PLANEJADO', dueMonth: '2026-09' });
  await page.route('http://localhost:3001/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === 'OPTIONS')
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    if (path === '/merchant-categories/suggest') return route.fulfill(json({ suggestedTipoDespesa: null }));
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      writes.push({ method, path });
      unexpected.push(`${method} ${path}`);
      return route.fulfill(json({ message: 'Unexpected write' }, 500));
    }
    if (path === '/auth/me')
      return route.fulfill(json({ id: 'u', username: 'synthetic', name: 'S', role: 'ADMIN', tenantId: 't-704', allowedProjects: [], allowedModules: [], allowedProjectTypes: ['PESSOAL', 'REFORMA'] }));
    if (path === '/projects') return route.fulfill(json([anchor]));
    if (path === '/projects/project') return route.fulfill(json({ ...anchor, rooms: [], _count: { receipts: 0, expenses: 0, cashFlow: 0 } }));
    if (path === ROOT)
      return route.fulfill(json({ id: 'credit', projectId: OWNER, titulo: 'Crédito atribuído', fornecedor: 'Fornecedor', tipoDespesa: 'OUTROS', valor: -12_345_678, valorTotal: -12_345_678, quantidade: 1, formaPagamento: 'A_VISTA', dataPagamento: '2026-09-10T00:00:00.000Z', status: 'PAGO', canDelete: false }));
    if (path === RATEIO)
      return route.fulfill(
        json({
          sourceExpenseId: 'credit', rateado: true, totalSourceCents: -12_345_678, rateadoCents: -12_345_678, sobraCents: 0, removedTargetsCount: 0,
          items: [{ targetExpenseId: 't-1', titulo: 'Destino Reforma', fornecedor: null, projectId: 'proj-a', projectName: 'Reforma A', projectType: 'REFORMA', allocationCents: -12_345_678, plannedValorTotalCents: null, status: 'PAGO' }],
        }),
      );
    if (path.endsWith('/monthly-overview/dre-overview')) return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path.endsWith('/monthly-overview/account-view'))
      return route.fulfill(
        json({
          mesSelecionado: '2026-09', caixaHoje: 0, carteiraHoje: 0, entrouMes: 0, saiuMes: 0, faltaPagarMes: 0, recebimentosPrevistosMes: 0, sobraPrevista: 0, devoCartaoTotal: 0,
          cartoes: [], contas: [], entradas: [], saidas: [assignedCredit, accountCredit, invoice], comprasCartao: [cardCredit],
          ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
        }),
      );
    // Leitura da despesa própria (capacidade de excluir): raiz PAGO, para provar que o PAGO da raiz nunca vira o status exibido.
    const own = /^\/projects\/project\/expenses\/([^/]+)$/.exec(path);
    if (own) return route.fulfill(json({ id: own[1], projectId: 'project', titulo: own[1], tipoDespesa: 'OUTROS', valor: -12_345_678, valorTotal: -12_345_678, quantidade: 1, formaPagamento: 'A_VISTA', status: 'PAGO', canDelete: false }));
    if (/^\/projects\/[^/]+\/expenses\//.test(path) || path.includes('refund-purpose')) {
      unexpected.push(`${method} ${path}`);
      return route.fulfill(json({ message: 'Unexpected route' }, 500));
    }
    return route.fulfill(json([]));
  });
  return { writes, unexpected, errors };
}

/** Caixas reais dos três blocos (rótulo + valor) do detalhe do rateio, estrutura-agnóstico. */
async function rateioBlocks(box: Locator) {
  return box.evaluate((root) => {
    const money = /^\s*(-\s*)?R\$\s*(-\s*)?\d[\d.]*,\d{2}\s*$|^\s*—\s*$/;
    const texts: Text[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) if ((walker.currentNode.textContent ?? '').trim()) texts.push(walker.currentNode as Text);
    const rectsOf = (node: Text) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
      const box = rects.reduce((a, r) => ({ left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      return { ...box, lines: new Set(rects.map((r) => Math.round(r.top))).size };
    };
    const out: Record<string, unknown> = {};
    for (const name of ['Total', 'Rateado', 'Sobra']) {
      const at = texts.findIndex((t) => (t.textContent ?? '').trim().toLowerCase() === name.toLowerCase());
      if (at < 0) return { missing: name };
      const valueNode = texts.slice(at + 1).find((t) => money.test(t.textContent ?? ''));
      if (!valueNode) return { missing: `${name}: valor` };
      const style = getComputedStyle(valueNode.parentElement!);
      out[name] = { label: rectsOf(texts[at]), value: rectsOf(valueNode), text: (valueNode.textContent ?? '').trim(), fontSize: style.fontSize, fontWeight: style.fontWeight, whiteSpace: style.whiteSpace };
    }
    const container = root.getBoundingClientRect();
    // Nenhum ancestral (do detalhe até o body) pode rolar na horizontal.
    let scrollOverflow = 0;
    for (let el: Element | null = root; el; el = el.parentElement) scrollOverflow = Math.max(scrollOverflow, el.scrollWidth - el.clientWidth);
    return { blocks: out, container: { left: container.left, right: container.right }, scrollOverflow, viewport: window.innerWidth };
  });
}

type Rect = { left: number; top: number; right: number; bottom: number; lines: number };
type Block = { label: Rect; value: Rect; text: string; fontSize: string; fontWeight: string; whiteSpace: string };
const intersects = (a: Rect, b: Rect) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const ORDER = ['Total', 'Rateado', 'Sobra'] as const;
type Measured = { blocks: Record<(typeof ORDER)[number], Block>; container: { left: number; right: number }; scrollOverflow: number; viewport: number };

/** Valores íntegros, numa linha, dentro do host e do viewport, sem sobreposição nem rolagem horizontal. */
async function measureIntegrity(box: Locator): Promise<Measured> {
  const m = await rateioBlocks(box);
  expect('missing' in m ? m.missing : null, 'rótulos/valores de Total, Rateado e Sobra presentes').toBeNull();
  const { blocks, container, scrollOverflow, viewport } = m as Measured;
  expect(blocks.Total.text).toMatch(NEGATIVE_123);
  expect(blocks.Rateado.text).toMatch(NEGATIVE_123);
  expect(blocks.Sobra.text).toMatch(/^R\$\s*0,00$/);
  for (const name of ORDER) {
    const b = blocks[name];
    expect(b.value.lines, `${name}: valor quebrado em linhas`).toBe(1);
    expect(b.value.left, `${name}: valor cortado à esquerda`).toBeGreaterThanOrEqual(container.left - 0.5);
    expect(b.value.right, `${name}: valor cortado à direita`).toBeLessThanOrEqual(Math.min(container.right, viewport) + 0.5);
    // Mesma tipografia de hoje (sem reduzir a fonte para caber).
    expect([b.fontSize, b.fontWeight, b.whiteSpace], `${name}: fonte monetária`).toEqual(['14px', '600', 'nowrap']);
  }
  const rects = ORDER.flatMap((name) => [blocks[name].label, blocks[name].value]);
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) expect(intersects(rects[i], rects[j]), `caixas ${i} e ${j} se sobrepõem`).toBe(false);
  expect(scrollOverflow, 'rolagem horizontal').toBeLessThanOrEqual(1);
  return m as Measured;
}

async function openCreditEdit(page: Page, width: number) {
  await page.goto('/projects/project/conta?mes=2026-09');
  const row = page.getByTestId('movimentacao-row').filter({ hasText: 'Crédito atribuído' });
  await expect(row).toBeVisible();
  if (width < 768) {
    await row.getByRole('button', { name: 'Mais ações' }).click();
    await page.getByRole('button', { name: 'Editar', exact: true }).filter({ visible: true }).click();
  } else {
    await row.getByRole('button', { name: 'Editar', exact: true }).click();
  }
  const box = page.getByTestId('rateio-detalhe');
  await expect(box).toBeVisible();
  await expect(box).toContainText('Compra rateada'); // marcador positivo: rateio resolvido
  await box.scrollIntoViewIfNeeded();
  return box;
}

for (const width of [375, 390, 1280]) {
  test.describe(`Resíduos visuais do crédito atribuído (#704) — ${width}px`, () => {
    test.beforeEach(async ({ page, baseURL }, info) => {
      test.skip(info.project.name !== 'desktop', 'Viewports explícitos');
      await page.setViewportSize({ width, height: 800 });
      await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
      await page.context().addCookies([{ name: 'rf_token', value: 'synthetic-704', url: baseURL! }]);
    });

    test('A: edição do crédito rateado — Total/Rateado/Sobra sem colisão; blocos verticais no celular e colunas no desktop; valores íntegros', async ({ page }) => {
      const { writes, unexpected, errors } = await mockApi(page);
      const box = await openCreditEdit(page, width);
      const { blocks } = await measureIntegrity(box);
      const order = ORDER;
      if (width < 768) {
        // Três blocos verticais: rótulo acima do valor, e cada bloco abaixo do anterior.
        order.forEach((name, i) => {
          expect(blocks[name].value.top, `${name}: valor abaixo do rótulo`).toBeGreaterThanOrEqual(blocks[name].label.bottom - 1);
          if (i > 0) expect(blocks[name].label.top, `${name}: bloco abaixo do anterior`).toBeGreaterThanOrEqual(blocks[order[i - 1]].value.bottom - 1);
        });
      } else {
        // 1280: as três colunas seguem lado a lado, na mesma faixa.
        expect(blocks.Rateado.label.left).toBeGreaterThan(blocks.Total.label.left);
        expect(blocks.Sobra.label.left).toBeGreaterThan(blocks.Rateado.label.left);
        expect(Math.abs(blocks.Rateado.label.top - blocks.Total.label.top)).toBeLessThanOrEqual(2);
        expect(Math.abs(blocks.Sobra.label.top - blocks.Total.label.top)).toBeLessThanOrEqual(2);
      }
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });

    // Só em 1280: o host é ESTREITADO no harness (constraint TEST-ONLY, 300px) para provar que o layout responde à largura
    // efetiva do bloco e não ao viewport. Nada em produção define essa largura.
    if (width === 1280) {
      test('A (1280, host estreitado a 300px no harness): sem colisão, valores íntegros numa linha e sem rolagem horizontal', async ({ page }) => {
        const { writes, unexpected, errors } = await mockApi(page);
        const box = await openCreditEdit(page, width);
        await box.evaluate((el) => {
          (el as HTMLElement).style.width = '300px';
          (el as HTMLElement).style.maxWidth = '300px';
        });
        expect(await box.evaluate((el) => Math.round(el.getBoundingClientRect().width))).toBe(300);
        await measureIntegrity(box);
        expect(writes).toEqual([]);
        expect(unexpected).toEqual([]);
        expect(errors).toEqual([]);
      });
    }

    test('B/C: crédito de comprasCartao — "Situação na fatura" com ajuda visível e "Categoria"; o status Planejado segue o da fatura', async ({ page }) => {
      const { writes, unexpected, errors } = await mockApi(page);
      await page.goto('/projects/project/conta?mes=2026-09');
      await page.getByTitle('Ver compras da fatura').click();
      const nested = page.getByTestId('movimentacao-row').filter({ hasText: 'Crédito no cartão' });
      await expect(nested).toBeVisible();
      await nested.getByLabel('Ver detalhe').click();
      await expect(page.getByText('Detalhe do lançamento')).toBeVisible();
      const cta = page.getByRole('button', { name: /finalidade do crédito/i });
      await expect(cta).toBeVisible(); // marcador positivo: contexto de crédito resolvido
      const detail = page.locator('[data-testid="financial-detail-sheet"], [data-testid="financial-detail-drawer"]');
      const term = (label: string) => detail.locator('dt', { hasText: new RegExp(`^${label}$`) });
      const valueOf = (label: string) => term(label).locator('xpath=following::dd[1]');

      await expect(term('Situação na fatura')).toBeVisible();
      await expect(valueOf('Situação na fatura')).toHaveText('Planejado');
      await expect(term('Status')).toHaveCount(0);
      await expect(term('Categoria')).toBeVisible();
      await expect(valueOf('Categoria')).toHaveText('Outros');
      await expect(term('Finalidade')).toHaveCount(0);
      const help = detail.getByText(INVOICE_HELP);
      await expect(help).toBeVisible();
      // A ajuda cabe na largura do detalhe e fica entre "Situação na fatura" e o próximo termo.
      const geometry = await detail.evaluate((root, helpText) => {
        const rect = (el: Element) => el.getBoundingClientRect();
        const helpEl = Array.from(root.querySelectorAll('*')).find((el) => el.children.length === 0 && el.textContent?.trim() === helpText)!;
        const statusTerm = Array.from(root.querySelectorAll('dt')).find((el) => el.textContent?.trim() === 'Situação na fatura')!;
        const box = rect(root);
        return { helpLeft: rect(helpEl).left, helpRight: rect(helpEl).right, boxLeft: box.left, boxRight: Math.min(box.right, window.innerWidth), afterStatus: rect(helpEl).top >= rect(statusTerm).top, overflow: root.scrollWidth - root.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth };
      }, INVOICE_HELP);
      expect(geometry.helpLeft).toBeGreaterThanOrEqual(geometry.boxLeft - 0.5);
      expect(geometry.helpRight).toBeLessThanOrEqual(geometry.boxRight + 0.5);
      expect(geometry.afterStatus).toBe(true);
      expect(geometry.overflow).toBeLessThanOrEqual(1);
      expect(geometry.page).toBeLessThanOrEqual(0);
      // Valor monetário do crédito íntegro numa linha; o CTA da finalidade continua com alvo ≥ 44px.
      const money = detail.getByText(NEGATIVE_123).first();
      await expect(money).toBeVisible();
      expect(await money.evaluate((n) => { const r = document.createRange(); r.selectNodeContents(n); return new Set(Array.from(r.getClientRects()).map((x) => Math.round(x.top))).size; })).toBe(1);
      const size = await cta.boundingBox();
      expect(size!.height).toBeGreaterThanOrEqual(44);
      expect(size!.width).toBeGreaterThanOrEqual(44);
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('CONTROLE: o mesmo tipo de crédito numa saída de conta (fora de comprasCartao) mantém "Status" e "Finalidade", sem ajuda de fatura', async ({ page }) => {
      const { writes, unexpected, errors } = await mockApi(page);
      await page.goto('/projects/project/conta?mes=2026-09');
      const accountRow = page.getByTestId('movimentacao-row').filter({ hasText: 'Crédito na conta' });
      await expect(accountRow).toBeVisible();
      await accountRow.getByLabel('Ver detalhe').click();
      await expect(page.getByText('Detalhe do lançamento')).toBeVisible();
      await expect(page.getByRole('button', { name: /finalidade do crédito/i })).toBeVisible();
      const detail = page.locator('[data-testid="financial-detail-sheet"], [data-testid="financial-detail-drawer"]');
      const term = (label: string) => detail.locator('dt', { hasText: new RegExp(`^${label}$`) });
      await expect(term('Status')).toHaveCount(1);
      await expect(term('Finalidade')).toHaveCount(1);
      await expect(term('Situação na fatura')).toHaveCount(0);
      await expect(term('Categoria')).toHaveCount(0);
      await expect(detail.getByText(INVOICE_HELP)).toHaveCount(0);
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}
