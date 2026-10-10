import { expect, test, type Locator, type Page } from '@playwright/test';
import { ExpenseType, type RefundPurposeResponse, type RefundPurposeStateResponse, type RefundPurposeSummary } from '@reformaflow/domain';

/**
 * #704 — "Finalidade do crédito" no detalhe da Conta, em 375/390/1280×800 (FE RED v2).
 *
 * CONTRATO DE UI, NÃO JORNADA REAL: rotas reais do app, HTTP de `localhost:3001` falso (declarado
 * abaixo), corpos literais do contrato conformes ao backend (datas ISO 00Z, revisão par no preview,
 * fingerprint 64 hex, `roomId` sempre presente). Nada aqui prova o backend nem finanças.
 *
 * Identidade: a Conta é do projeto `project` (PESSOAL) e a linha é a parcela `credit#2` da compra
 * `credit` do projeto DONO `proj-owner` (id composto + foreignExpenseId + projetoOrigem). Toda
 * chamada de finalidade tem que usar `/projects/proj-owner/expenses/credit/refund-purpose`; qualquer
 * outra rota de finalidade/dono é registrada e derruba o teste (lista explícita, não `throw` mudo).
 * Sem a entrada em produção o teste falha já no CTA; medições/hit-test/escritas são o portão do
 * GREEN. Escape/retorno de foco/nome do diálogo por etapa ficam para o GREEN (sem primitiva global
 * nova). O spec `refund-purpose.spec.ts` (guardas do crédito) NÃO é tocado.
 */
const OWNER = 'proj-owner';
const READ = `/projects/${OWNER}/expenses/credit/refund-purpose`;
const ROOT = `/projects/${OWNER}/expenses/credit`;
const FP = '3f9a1c07d2b84e56a0c3917fd8e24b6a5c10e7d93b8a4f26d1e05c7a9b3f8e21';
const SENTINEL = 'PrismaClientKnownRequestError: Invalid `prisma.expense.update()` invocation';
const SUMMARY: RefundPurposeSummary = {
  sourceExpenseId: 'credit',
  targetProjectId: 'proj-a',
  roomId: null,
  tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
  allocationCents: -12_345_678,
  dataCompra: '2026-05-10T00:00:00.000Z',
  dataPagamento: '2026-09-10T00:00:00.000Z',
  cashFlowDate: '2026-09-12T00:00:00.000Z',
  cardId: 'card-1',
  importId: 'import-1',
};
const assigned = (revision: number, summary: RefundPurposeSummary): RefundPurposeStateResponse => ({
  sourceExpenseId: 'credit',
  assignment: { revision, summary },
  actions: ['UNDO'],
});
const A_DETAIL = '/projects/proj-a';
const HTTP_SENTINEL = SENTINEL;
const PREPARE: RefundPurposeStateResponse = { sourceExpenseId: 'credit', assignment: null, actions: ['PREPARE'] };
const NEGATIVE_123 = /(-\s*R\$\s*123\.456,78|R\$\s*-\s*123\.456,78)/;

type Mode = 'prepare-apply' | 'undo-lost' | 'read-500' | 'undo-room' | 'undo-detail-500' | 'prepare-detail-503-once';
type Write = { method: string; path: string; body: unknown };

/**
 * Alvo tocável: caixa real (sem arredondar 43,6→44) e hit-test do centro + 4 pontos internos nos
 * meios das bordas (dentro também de um alvo redondo, como o X do Modal, cujos cantos ficam fora do círculo).
 */
async function touchTarget(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const m = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const points = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + 4, r.top + r.height / 2],
      [r.right - 4, r.top + r.height / 2],
      [r.left + r.width / 2, r.top + 4],
      [r.left + r.width / 2, r.bottom - 4],
    ];
    // Só o próprio elemento ou um descendente conta: ancestral no ponto = alvo coberto/pointer-events:none.
    const hits = points.map(([x, y]) => {
      const at = document.elementFromPoint(x, y);
      return !!at && (at === el || el.contains(at));
    });
    return { width: r.width, height: r.height, hits };
  });
  expect(m.width, 'largura real do alvo').toBeGreaterThanOrEqual(44);
  expect(m.height, 'altura real do alvo').toBeGreaterThanOrEqual(44);
  expect(m.hits, 'elementFromPoint precisa acertar o alvo (centro e cantos)').toEqual([true, true, true, true, true]);
}

/**
 * Valores monetários do diálogo: existe pelo menos `min`; cada um (sinal + R$ + número) ocupa UMA
 * linha visual — medido por Range sobre o menor ancestral que contém o valor inteiro, então um "-"
 * em nó separado que quebra sozinho reprova — e cabe dentro do diálogo e do viewport.
 */
async function expectMoney(dialog: Locator, min: number, opts: { negative123?: boolean } = {}) {
  const found = await dialog.evaluate((root, wantSigned) => {
    const box = root.getBoundingClientRect();
    const number = /R\$\s*-?\s*\d[\d.]*,\d{2}/;
    const negative = /(-\s*R\$\s*\d[\d.]*,\d{2}|R\$\s*-\s*\d[\d.]*,\d{2})/;
    const out: Array<{ text: string; lines: number; inside: boolean; signed: boolean }> = [];
    const done = new Set<Element>();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!number.test(node.textContent ?? '')) continue;
      let el: Element = node.parentElement!;
      const wantsSign = wantSigned && /123\.456,78/.test(node.textContent ?? '');
      while (el !== root && (el.textContent ?? '').length <= 80 && !(wantsSign ? negative : number).test(el.textContent ?? '')) {
        el = el.parentElement!;
      }
      if (done.has(el)) continue;
      done.add(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
      const tops = new Set(rects.map((r) => Math.round(r.top)));
      out.push({
        text: (el.textContent ?? '').trim(),
        lines: tops.size,
        inside: rects.every((r) => r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.right <= window.innerWidth + 0.5),
        signed: !wantsSign || negative.test(el.textContent ?? ''),
      });
    }
    return { out, overflow: root.scrollWidth - root.clientWidth };
  }, !!opts.negative123);
  expect(found.out.length, `valores monetários encontrados no diálogo: ${JSON.stringify(found.out)}`).toBeGreaterThanOrEqual(min);
  for (const value of found.out) {
    expect(value.lines, `valor quebrado em linhas: ${value.text}`).toBe(1);
    expect(value.inside, `valor fora do diálogo/viewport: ${value.text}`).toBe(true);
    expect(value.signed, `sinal separado do valor: ${value.text}`).toBe(true);
  }
  expect(found.overflow).toBeLessThanOrEqual(1);
  if (opts.negative123) expect(found.out.some((v) => NEGATIVE_123.test(v.text))).toBe(true);
}

async function mockApi(page: Page, mode: Mode, opts: { room?: string | null } = {}) {
  const writes: Write[] = [];
  const reads: string[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  const details: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
  // Formas NATIVAS (probe HTTP): `GET /projects` = colunas de Project, SEM `rooms`; `GET /projects/:id` =
  // colunas + `rooms[{id,projectId,name,order,createdAt,deletedAt}]` (ativos E soft-deleted) + `_count`.
  const column = (id: string, type: string, name: string) => ({
    id, tenantId: 't-704', createdByUserId: null, type, name, description: null, startDate: null, endDate: null,
    createdAt: '2026-01-01T12:00:00.000Z', updatedAt: '2026-01-01T12:00:00.000Z', deletedAt: null, onboardedAt: '2026-01-01T12:00:00.000Z',
  });
  const room = (id: string, name: string, order: number, deletedAt: string | null = null) => ({
    id, projectId: 'proj-a', name, order, createdAt: '2026-01-01T12:00:00.000Z', deletedAt,
  });
  const anchor = column('project', 'PESSOAL', 'Pessoal');
  const projects = [anchor, column(OWNER, 'REFORMA', 'Reforma Dona'), column('proj-a', 'REFORMA', 'Reforma A'), column('proj-plantas', 'PLANTAS', 'Plantas')];
  const count = { receipts: 0, expenses: 0, cashFlow: 0 };
  // Ordem RECEBIDA (nem por `order` nem por nome): o front não reordena nem inventa contrato.
  const projectA = { ...projects[2], rooms: [room('room-a2', 'Sala de estar', 5), room('room-a-del', 'Cozinha antiga', 1, '2026-02-01T12:00:00.000Z'), room('room-a1', 'Cozinha', 2)], _count: count };
  let detail503 = mode === 'prepare-detail-503-once';
  // Estado do servidor falso: revisão da leitura seguinte; undo perdido é seguido de releitura em outra revisão.
  let assignmentRevision: number | null = mode === 'undo-lost' || mode === 'undo-room' || mode === 'undo-detail-500' ? 3 : null;
  // Destino/ambiente PERSISTIDOS: só o apply os muda; a prévia não persiste nada.
  let persisted = { targetProjectId: SUMMARY.targetProjectId, roomId: opts.room ?? null };
  let previewed: { targetProjectId: string; roomId: string | null } | null = null;
  const validDestinations: Record<string, Array<string | null>> = { project: [null], 'proj-a': [null, 'room-a1', 'room-a2'] };
  const summaryOf = (target: { targetProjectId: string; roomId: string | null }): RefundPurposeSummary => ({ ...SUMMARY, ...target });
  let deletes = 0;
  await page.route('http://localhost:3001/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === 'OPTIONS')
      return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
    if (path === '/merchant-categories/suggest') return route.fulfill(json({ suggestedTipoDespesa: null }));
    if (path === READ) {
      if (method === 'GET') {
        reads.push(path);
        if (mode === 'read-500') return route.fulfill(json({ message: SENTINEL, statusCode: 500 }, 500));
        return route.fulfill(json(assignmentRevision === null ? PREPARE : assigned(assignmentRevision, summaryOf(persisted))));
      }
      const body = request.postDataJSON() as { mode?: string; targetProjectId?: string; roomId?: string | null; expectedRevision?: number; expectedFingerprint?: string };
      writes.push({ method, path, body });
      if (method === 'DELETE') {
        deletes += 1;
        if (deletes === 1) {
          assignmentRevision = 5; // desfez e reaplicou enquanto a resposta se perdia
          return route.abort('failed');
        }
        assignmentRevision = null;
        return route.fulfill(json({ revision: 6, alreadyUndone: false }));
      }
      // Corpo fora do contrato público (modo, destino, ambiente, guardas do apply) falha explícito, não vira sucesso.
      const target = { targetProjectId: body.targetProjectId ?? '', roomId: body.roomId === undefined ? ('<ausente>' as string) : body.roomId };
      const allowedRooms = validDestinations[target.targetProjectId];
      const coherent = !!allowedRooms && allowedRooms.includes(target.roomId);
      const isApply = body.mode === 'apply' && body.expectedRevision === 0 && body.expectedFingerprint === FP && previewed?.targetProjectId === target.targetProjectId && previewed.roomId === target.roomId;
      if (!coherent || (body.mode !== 'preview' && !isApply)) {
        unexpected.push(`${method} ${path} ${JSON.stringify(body)}`);
        return route.fulfill(json({ message: 'Unexpected payload' }, 400));
      }
      if (body.mode === 'preview') {
        previewed = target;
        const preview: RefundPurposeResponse = { mode: 'preview', revision: 0, fingerprint: FP, summary: summaryOf(target) };
        return route.fulfill(json(preview, 201));
      }
      persisted = target;
      assignmentRevision = 1;
      const applied: RefundPurposeResponse = { mode: 'apply', revision: 1, fingerprint: FP, summary: summaryOf(target), targetExpenseId: 't-1', alreadyApplied: false };
      return route.fulfill(json(applied, 201));
    }
    if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
      writes.push({ method, path, body: request.postDataJSON() });
      unexpected.push(`${method} ${path}`);
      return route.fulfill(json({ message: 'Unexpected write' }, 500));
    }
    if (path.includes('refund-purpose') || (path.startsWith(`/projects/${OWNER}/`) && path !== ROOT)) {
      unexpected.push(`${method} ${path}`);
      return route.fulfill(json({ message: 'Unexpected route' }, 500));
    }
    if (path === '/auth/me')
      return route.fulfill(json({ id: 'u', username: 'synthetic', name: 'S', role: 'ADMIN', tenantId: 't-704', allowedProjects: [], allowedModules: [], allowedProjectTypes: ['PESSOAL', 'REFORMA'] }));
    if (path === '/projects') return route.fulfill(json(projects));
    if (path === '/projects/project') return route.fulfill(json({ ...anchor, rooms: [], _count: count }));
    const detailOf = /^\/projects\/([^/]+)$/.exec(path);
    if (detailOf) {
      details.push(path);
      if (path === A_DETAIL) {
        if (mode === 'undo-detail-500') return route.fulfill(json({ message: HTTP_SENTINEL, statusCode: 500 }, 500));
        if (detail503) {
          detail503 = false;
          return route.fulfill(json({ message: HTTP_SENTINEL, statusCode: 503 }, 503));
        }
        return route.fulfill(json(projectA));
      }
      unexpected.push(`${method} ${path}`);
      return route.fulfill(json({ message: 'Unexpected project detail' }, 500));
    }
    if (path === ROOT) return route.fulfill(json({ id: 'credit', projectId: OWNER, titulo: 'Crédito importado', tipoDespesa: 'OUTROS', valor: -12_345_678, valorTotal: -12_345_678, quantidade: 1, formaPagamento: 'A_VISTA', dataPagamento: '2026-09-10T00:00:00.000Z', status: 'PAGO', canDelete: false }));
    if (path.endsWith('/monthly-overview/dre-overview')) return route.fulfill(json({ anual: { saldoAcumuladoSerie: [] } }));
    if (path.endsWith('/monthly-overview/account-view'))
      return route.fulfill(
        json({
          mesSelecionado: '2026-09', caixaHoje: 0, carteiraHoje: 0, entrouMes: 0, saiuMes: -12_345_678, faltaPagarMes: 0,
          recebimentosPrevistosMes: 0, sobraPrevista: 0, devoCartaoTotal: 0, cartoes: [], contas: [], entradas: [], comprasCartao: [],
          saidas: [{ id: 'credit#2', foreignExpenseId: 'credit', parcelaIndex: 2, kind: 'saida', descricao: 'Crédito importado', data: '2026-09-10T00:00:00.000Z', forma: 'cartao', valor: -12_345_678, realizado: true, status: 'PAGO', cardLast4: '1234', bankLast4: null, tipoDespesa: 'OUTROS', isInvoice: false, editavel: true, expenseIsCredit: true, dueMonth: null, projetoOrigem: { id: OWNER, name: 'Reforma Dona', type: 'REFORMA' } }],
          ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
        }),
      );
    return route.fulfill(json([]));
  });
  return { writes, reads, errors, unexpected, details };
}

async function openPurpose(page: Page, baseURL: string) {
  await page.context().addCookies([{ name: 'rf_token', value: 'synthetic-704', url: baseURL }]);
  await page.goto('/projects/project/conta?mes=2026-09');
  await page.getByLabel('Ver detalhe').first().click();
  // O detalhe abriu de fato (rota, linha e drawer/sheet reais) antes de exigir a entrada.
  await expect(page.getByText('Detalhe do lançamento')).toBeVisible();
  const entry = page.getByRole('button', { name: /finalidade do crédito/i });
  await expect(entry).toBeVisible();
  await touchTarget(entry);
  await entry.click();
  const dialog = page.getByRole('dialog', { name: /finalidade do crédito/i });
  await expect(dialog).toBeVisible();
  return dialog;
}

const summaryRow = (dialog: Locator, label: string) => dialog.locator('dt', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::dd[1]');
const optionValues = (select: Locator) => select.evaluate((el) => Array.from((el as HTMLSelectElement).options).map((o) => o.value).filter(Boolean));

for (const width of [375, 390, 1280]) {
  test.describe(`Finalidade do crédito (#704) — ${width}px`, () => {
    test.beforeEach(async ({ page }, info) => {
      test.skip(info.project.name !== 'desktop', 'Viewports explícitos');
      await page.setViewportSize({ width, height: 800 });
      await page.clock.setFixedTime(new Date('2026-09-15T12:00:00Z'));
    });

    test('atribuir: URL do projeto dono, destinos elegíveis, roomId zerado ao trocar projeto, prévia, confirmação, resultado e concluir, com alvos 44px', async ({ page, baseURL }) => {
      const { writes, reads, errors, unexpected, details } = await mockApi(page, 'prepare-apply');
      const dialog = await openPurpose(page, baseURL!);
      const preview = dialog.getByRole('button', { name: /verificar prévia/i });
      await expect(preview).toBeVisible(); // marcador positivo: leitura resolvida com PREPARE
      expect(reads).toEqual([READ]);

      const project = dialog.getByLabel(/^projeto/i);
      await expect.poll(() => optionValues(project)).toEqual(['project', 'proj-a']);
      await touchTarget(project);
      expect(details, 'abrir não lê detalhe de projeto').toEqual([]);
      await project.selectOption('proj-a');
      const room = dialog.getByLabel(/ambiente/i);
      // Ambientes vêm do detalhe NATIVO do destino: só ativos, na ordem recebida (o soft-deleted não entra).
      await expect.poll(() => optionValues(room)).toEqual(['room-a2', 'room-a1']);
      await expect(room.locator('option')).toHaveText(['Sem ambiente', 'Sala de estar', 'Cozinha']);
      expect(details).toEqual([A_DETAIL]);
      await room.selectOption('room-a1');
      await project.selectOption('project');
      await expect(room).toHaveValue('');
      await project.selectOption('proj-a');
      await expect.poll(() => optionValues(room)).toEqual(['room-a2', 'room-a1']);
      await expect(room).toHaveValue('');
      await room.selectOption('room-a1');
      await touchTarget(room);
      await touchTarget(preview);
      await preview.click();

      const confirm = dialog.getByRole('button', { name: /confirmar finalidade/i });
      await expect(confirm).toBeVisible();
      // O resumo da PRÉVIA mostra o destino e o ambiente efetivamente enviados (nomes do detalhe nativo).
      await expect(summaryRow(dialog, 'Projeto de destino')).toHaveText('Reforma A');
      await expect(summaryRow(dialog, 'Ambiente')).toHaveText('Cozinha');
      await expectMoney(dialog, 1, { negative123: true });
      await touchTarget(confirm);
      await confirm.click();
      const done = dialog.getByRole('button', { name: /^concluir$/i });
      await expect(done).toBeVisible();
      // Marcador POSITIVO do estado relido (atribuição atual) antes de medir o valor dele.
      await expect(dialog.getByRole('button', { name: /desfazer finalidade/i })).toBeVisible();
      // O estado RELIDO após o apply reflete o que foi persistido, não a resposta antiga.
      await expect(summaryRow(dialog, 'Projeto de destino')).toHaveText('Reforma A');
      await expect(summaryRow(dialog, 'Ambiente')).toHaveText('Cozinha');
      await expectMoney(dialog, 1, { negative123: true });
      await touchTarget(done);
      await expect.poll(() => reads.length).toBe(2); // releitura do estado após confirmar
      await done.click();

      expect(writes.map((w) => [w.method, w.path, w.body])).toEqual([
        ['POST', READ, { mode: 'preview', targetProjectId: 'proj-a', roomId: 'room-a1' }],
        ['POST', READ, { mode: 'apply', targetProjectId: 'proj-a', roomId: 'room-a1', expectedRevision: 0, expectedFingerprint: FP }],
      ]);
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    });

    test('undo com resposta perdida: incerto, sem DELETE extra, releitura em outra revisão e nova confirmação com a revisão atual', async ({ page, baseURL }) => {
      const { writes, reads, unexpected } = await mockApi(page, 'undo-lost');
      const dialog = await openPurpose(page, baseURL!);
      const undo = dialog.getByRole('button', { name: /desfazer finalidade/i });
      await expect(undo).toBeVisible();
      await expectMoney(dialog, 1, { negative123: true });
      await touchTarget(undo);
      await undo.click();
      const cancel = dialog.getByRole('button', { name: /^cancelar$/i });
      await expect(cancel).toBeFocused();
      await touchTarget(cancel);
      // A confirmação é um grupo acessível nomeado: escopo por estado, nunca `.last()` nem pai direto.
      const confirmation = dialog.getByRole('group', { name: /confirmar desfazer/i });
      const confirmUndo = confirmation.getByRole('button', { name: /desfazer finalidade/i });
      await touchTarget(confirmUndo);
      await confirmUndo.click();
      await expect(dialog.getByText('Não foi possível confirmar se a finalidade foi desfeita.')).toBeVisible();
      await expectMoney(dialog, 0);
      const again = dialog.getByRole('button', { name: /consultar novamente/i });
      await touchTarget(again);
      await touchTarget(dialog.getByRole('button', { name: /^fechar$/i }));
      expect(writes.filter((w) => w.method === 'DELETE')).toHaveLength(1);
      expect(writes[0].body).toEqual({ expectedRevision: 3 });

      await again.click();
      await expect.poll(() => reads.length).toBe(2);
      const undoAgain = dialog.getByRole('button', { name: /desfazer finalidade/i });
      await expect(undoAgain).toBeVisible();
      await expect(dialog.getByText('Não foi possível confirmar se a finalidade foi desfeita.')).toBeVisible();
      expect(writes.filter((w) => w.method === 'DELETE')).toHaveLength(1);
      await undoAgain.click();
      await dialog.getByRole('group', { name: /confirmar desfazer/i }).getByRole('button', { name: /desfazer finalidade/i }).click();
      await expect.poll(() => writes.filter((w) => w.method === 'DELETE').length).toBe(2);
      expect(writes.map((w) => [w.method, w.path, w.body])).toEqual([
        ['DELETE', READ, { expectedRevision: 3 }],
        ['DELETE', READ, { expectedRevision: 5 }],
      ]);
      expect(unexpected).toEqual([]);
    });

    for (const [roomId, expected] of [
      ['room-a1', 'Cozinha'],
      [null, 'Sem ambiente'],
      ['room-a-del', 'Ambiente indisponível'],
    ] as const) {
      test(`assignment (roomId ${roomId}): destino e ambiente lidos do detalhe nativo, "${expected}", sem GET por linha`, async ({ page, baseURL }) => {
        const { reads, writes, unexpected, details } = await mockApi(page, 'undo-room', { room: roomId });
        const dialog = await openPurpose(page, baseURL!);
        await expect(dialog.getByRole('button', { name: /desfazer finalidade/i })).toBeVisible();
        const term = (label: string) => dialog.locator('dt', { hasText: new RegExp(`^${label}$`) });
        await expect(term('Projeto de destino').locator('xpath=following-sibling::dd[1]')).toHaveText('Reforma A');
        await expect(term('Ambiente').locator('xpath=following-sibling::dd[1]')).toHaveText(expected);
        await expect(dialog).not.toContainText('Cozinha antiga');
        await expectMoney(dialog, 1, { negative123: true });
        expect(reads).toEqual([READ]);
        expect(details).toEqual([A_DETAIL]);
        expect(writes).toEqual([]);
        expect(unexpected).toEqual([]);
      });
    }

    test('assignment com o detalhe do destino em 500 técnico: causa fora do DOM, erro explícito nas linhas, fatos e Desfazer intactos, retry com alvo 44px', async ({ page, baseURL }) => {
      const { reads, writes, unexpected, details } = await mockApi(page, 'undo-detail-500', { room: 'room-a1' });
      const dialog = await openPurpose(page, baseURL!);
      const undo = dialog.getByRole('button', { name: /desfazer finalidade/i });
      await expect(undo).toBeVisible();
      const term = (label: string) => dialog.locator('dt', { hasText: new RegExp(`^${label}$`) });
      await expect(term('Ambiente').locator('xpath=following-sibling::dd[1]')).toContainText(/não foi possível/i);
      await expect(term('Ambiente').locator('xpath=following-sibling::dd[1]')).not.toContainText(/ambiente indisponível/i);
      expect(await page.locator('body').innerText()).not.toMatch(/prisma|invocation/i);
      await expectMoney(dialog, 1, { negative123: true });
      await touchTarget(undo);
      const retry = dialog.getByRole('button', { name: /recarregar/i });
      await touchTarget(retry);
      await retry.click();
      await expect.poll(() => details.length).toBe(2);
      expect(reads, 'retry do detalhe não repete a leitura de finalidade').toEqual([READ]);
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
    });

    test('PREPARE com o detalhe do destino em 503: aviso neutro, sem prévia nem "Sem ambiente" silencioso; retry libera os ambientes', async ({ page, baseURL }) => {
      const { writes, unexpected, details } = await mockApi(page, 'prepare-detail-503-once');
      const dialog = await openPurpose(page, baseURL!);
      const project = dialog.getByLabel(/^projeto/i);
      await expect.poll(() => optionValues(project)).toEqual(['project', 'proj-a']);
      await project.selectOption('proj-a');
      await expect(dialog.getByRole('alert')).toBeVisible();
      expect(await page.locator('body').innerText()).not.toMatch(/prisma|invocation/i);
      await expect(dialog.getByRole('button', { name: /verificar prévia/i })).toBeDisabled();
      const retry = dialog.getByRole('button', { name: /recarregar/i });
      await touchTarget(retry);
      await retry.click();
      await expect.poll(() => optionValues(dialog.getByLabel(/ambiente/i))).toEqual(['room-a2', 'room-a1']);
      await expect(dialog.getByRole('alert')).toHaveCount(0);
      expect(details).toEqual([A_DETAIL, A_DETAIL]);
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
    });

    test('Escape e Fechar dispensam só o diálogo da finalidade e devolvem o foco à entrada, sem escrita', async ({ page, baseURL }) => {
      const { writes, reads, unexpected } = await mockApi(page, 'prepare-apply');
      const dialog = await openPurpose(page, baseURL!);
      await expect(dialog.getByRole('button', { name: /verificar prévia/i })).toBeVisible();
      const entry = page.getByRole('button', { name: /finalidade do crédito/i });

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByText('Detalhe do lançamento')).toBeVisible();
      await expect(entry).toBeFocused();

      await entry.click();
      const reopened = page.getByRole('dialog', { name: /finalidade do crédito/i });
      await expect(reopened.getByRole('button', { name: /verificar prévia/i })).toBeVisible();
      await reopened.getByRole('button', { name: /^fechar$/i }).click();
      await expect(reopened).toBeHidden();
      await expect(entry).toBeFocused();
      expect(reads).toEqual([READ, READ]); // fechar e reabrir consulta de novo
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
    });

    test('GET 500 com causa técnica: erro neutro visível, causa fora do DOM, e o PRIMEIRO toque em Consultar novamente/Fechar acerta o alvo', async ({ page, baseURL }) => {
      const { reads, writes, unexpected } = await mockApi(page, 'read-500');
      const dialog = await openPurpose(page, baseURL!);
      await expect(dialog.getByText(/não foi possível consultar a finalidade agora/i)).toBeVisible();
      expect(await dialog.getByRole('button', { name: /verificar prévia|desfazer finalidade/i }).count()).toBe(0);
      expect(await page.locator('body').innerText()).not.toMatch(/prisma|invocation/i);
      const retry = dialog.getByRole('button', { name: /consultar novamente/i });
      await touchTarget(retry);
      await touchTarget(dialog.getByRole('button', { name: /^fechar$/i }));
      await retry.click();
      await expect.poll(() => reads.length).toBe(2);
      expect(writes).toEqual([]);
      expect(unexpected).toEqual([]);
    });
  });
}
