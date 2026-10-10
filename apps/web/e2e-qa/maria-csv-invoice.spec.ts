import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { isPendingImportQuestion, type ImportSessionViewV1 } from '@reformaflow/domain';
import { JourneyEvidence, assertReadableMoney, assertTouchable, assertUniqueButtonNames } from './helpers/evidence';

const apiURL = process.env.API_URL!;
const fixtures = path.resolve(__dirname, 'fixtures');
const csvCTA = 'Importar fatura de cartão (CSV)';

async function dismissJourney(page: Page) {
  const close = page.getByRole('button', { name: 'Fechar jornada', exact: true });
  if (await close.isVisible()) await close.click();
}

async function openMaria(page: Page) {
  await dismissJourney(page);
  if (page.viewportSize()!.width < 768) {
    await page.getByRole('link', { name: 'Maria', exact: true }).click();
  } else {
    await page.getByRole('button', { name: 'Conversar com a Maria', exact: true }).click();
    await page.getByRole('link', { name: 'Importar fatura CSV com Maria', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/maria(?:\?|$)/);
}

for (const phase of ['upload', 'confirmation'] as const) {
test(phase === 'upload'
  ? 'real signup → visible Maria → CSV consent/dedupe/analysis → reload with no expenses'
  : 'real signup → Maria CSV → explicit subset confirmation → persistent receipt', async ({ page }, info) => {
  const evidence = new JourneyEvidence(page, info);
  let token = '';
  let projectId = '';
  let sessionId = '';
  const headers = () => ({ Authorization: `Bearer ${token}`, 'x-rf-import-ui': '1' });
  const get = async (resource: string) => {
    const response = await page.request.get(`${apiURL.replace(/\/$/, '')}${resource}`, { headers: headers() });
    await evidence.checkApi(response);
    return response.json();
  };
  const view = async (): Promise<ImportSessionViewV1> => get(`/import-sessions/${sessionId}`);
  const expenses = async (): Promise<{ total: number; items: { id: string; titulo: string; valor: number; creditCardId: string | null }[] }> =>
    get(`/projects/${projectId}/expenses?pageSize=2000`);
  const noExpenses = async () => {
    const result = await expenses();
    expect(result.total, 'No financial writes before explicit confirmation').toBe(0);
    expect(result.items).toEqual([]);
  };

  try {
    const expected: { purchases: { title: string; amountCents: number }[]; ignoredPaymentRow: string; declarations: { firstDueDate: string; installmentCount: number } } =
      JSON.parse(await fs.readFile(path.join(fixtures, 'expected.json'), 'utf8'));
    const selectedPurchases = expected.purchases.slice(0, 2);
    expect(selectedPurchases).toHaveLength(2);
    const chosen = selectedPurchases.map(purchase => purchase.title);
    const selectedTotal = selectedPurchases.reduce((sum, purchase) => sum + purchase.amountCents, 0);
    const assertPurchaseProjection = (snapshot: ImportSessionViewV1) => {
      const titles = snapshot.lines.map(line => line.titulo);
      for (const purchase of expected.purchases) {
        expect(titles.filter(title => title === purchase.title), 'Each purchase projected exactly once').toHaveLength(1);
      }
      expect(titles).not.toContain(expected.ignoredPaymentRow);
    };
    const first = await fs.readFile(path.join(fixtures, 'card-invoice.csv'));
    const copy = await fs.readFile(path.join(fixtures, 'card-invoice-copy.csv'));
    expect(first.equals(copy), 'Renamed CSV must have identical bytes').toBe(true);
    expect(first.length).toBeGreaterThan(0);

    await page.goto('/register');
    await expect(page.getByLabel(/^seu nome$/i)).toBeVisible();
    await evidence.capture('register');
    await page.getByLabel(/^seu nome$/i).fill('QA Maria CSV');
    await page.getByLabel(/email/i).fill(`qa-maria-${randomUUID()}@example.com`);
    await page.getByLabel(/^senha$/i).fill(`Qa-${randomUUID()}!`);
    await page.getByRole('checkbox', { name: /organizar minha vida financeira/i }).check();
    await page.getByRole('button', { name: /criar minha conta/i }).click();
    await expect(page).toHaveURL(/\/projects\/?$/);
    token = (await page.context().cookies()).find(cookie => cookie.name === 'rf_token')?.value ?? '';
    expect(token, 'Real signup must issue an authenticated session cookie').not.toBe('');
    evidence.authenticated();
    const projects: { id: string; name: string; type: string }[] = await get('/projects');
    const personal = projects.filter(project => project.type === 'PESSOAL');
    expect(personal, 'Signup must create exactly one PESSOAL project').toHaveLength(1);
    projectId = personal[0].id;
    await expect(page.getByText(personal[0].name, { exact: true })).toBeVisible();
    await evidence.capture('signup-project-created');
    const cardResponse = await page.request.post(`${apiURL.replace(/\/$/, '')}/projects/${projectId}/credit-cards`, {
      headers: headers(),
      data: { institution: 'NUBANK', brand: 'Mastercard', nickname: 'QA CSV Nebulosa', last4: '4242',
        closingDay: 5, dueDay: 10, limitTotalCents: 100000 },
    });
    await evidence.checkApi(cardResponse);
    const card: { id: string } = await cardResponse.json();
    await page.getByText(personal[0].name, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/`));
    await dismissJourney(page);
    await evidence.capture('personal-project-card-created');

    await openMaria(page);
    const cta = page.getByRole('button', { name: csvCTA, exact: true });
    await assertTouchable(cta);
    await expect(cta).toHaveCount(1);
    await assertUniqueButtonNames(page);
    await evidence.capture('maria-visible-csv-cta');
    await cta.click();
    const cardPicker = page.getByLabel('Cartão da fatura', { exact: true });
    await expect(cardPicker).toBeEnabled();
    await expect(cardPicker).toHaveValue('');
    await expect(cardPicker.locator(`option[value="${card.id}"]`)).toContainText(personal[0].name);
    await cardPicker.selectOption(card.id);
    await expect(cardPicker).toHaveValue(card.id);
    await evidence.capture('explicit-card-and-project');

    const picker = page.getByLabel('Selecionar arquivos', { exact: true });
    await picker.setInputFiles([path.join(fixtures, 'card-invoice.csv'), path.join(fixtures, 'card-invoice-copy.csv')]);
    const files = page.getByRole('list', { name: 'Arquivos selecionados', exact: true });
    await expect(files.getByRole('listitem')).toHaveCount(2);
    await expect(files).toContainText('card-invoice.csv');
    await expect(files).toContainText('card-invoice-copy.csv');
    expect(new URL(page.url()).searchParams.has('importSessionId'), 'File selection stays local').toBe(false);
    await noExpenses();
    await evidence.capture('local-file-review-before-consent');
    const consent = page.getByRole('button', { name: 'Analisar e guardar rascunho', exact: true });
    await assertTouchable(consent);
    await consent.click();
    await expect(page.getByText('Este CSV idêntico já está guardado nesta importação; o arquivo repetido foi ignorado.', { exact: true })).toBeVisible();
    sessionId = new URL(page.url()).searchParams.get('importSessionId') ?? '';
    expect(sessionId).not.toBe('');
    await expect.poll(async () => {
      const titles = (await view()).lines.map(line => line.titulo);
      return expected.purchases.every(purchase => titles.includes(purchase.title));
    }).toBe(true);
    const uploaded = await view();
    assertPurchaseProjection(uploaded);
    expect(uploaded.ownerProjectId).toBe(projectId);
    expect(uploaded.cardId).toBe(card.id);
    expect(uploaded.attachments.filter(attachment => attachment.state === 'ATTACHED')).toHaveLength(1);
    await noExpenses();
    await evidence.capture('duplicate-acknowledged-analysis-succeeded');

    await page.reload();
    await expect(page.getByRole('region', { name: 'Conversa da importação', exact: true })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('importSessionId')).toBe(sessionId);
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Analisar e guardar rascunho', exact: true })).toHaveCount(0);
    assertPurchaseProjection(await view());
    await noExpenses();
    await evidence.capture('reload-resumes-uploaded-draft');

    const payment = page.getByRole('group', { name: /^Linha ignorada: .*Pagamento de fatura/i });
    await expect(payment).toBeVisible();
    await expect(payment.getByRole('checkbox')).toHaveCount(0);
    await expect(payment.getByRole('button', { name: /Incluir|Retirar|Confirmar/ })).toHaveCount(0);
    await payment.getByRole('button', { name: 'Ver motivo', exact: true }).click();
    await expect(payment).toContainText('Pagamento de fatura de cartão não é uma compra e não será importado.');
    const draft = await view();
    assertPurchaseProjection(draft);
    await noExpenses();
    await evidence.capture('ignored-payment-no-financial-effects');
    if (phase === 'upload') return;
    const selectedIds = draft.lines.filter(line => chosen.includes(line.titulo ?? '')).map(line => line.id);
    expect(selectedIds).toHaveLength(2);
    for (const line of draft.lines) {
      const row = page.locator(`[data-review-blocker-line="${line.id}"]`).first();
      await expect(row).toBeVisible();
      const wasSelected = (await view()).selectedLineIds.includes(line.id);
      if (selectedIds.includes(line.id) && !wasSelected) {
        await row.getByRole('button', { name: `Incluir compra ${line.id} na revisão`, exact: true }).click();
      } else if (!selectedIds.includes(line.id) && wasSelected) {
        await row.getByRole('button', { name: `Retirar compra ${line.id} da seleção`, exact: true }).click();
      }
      await expect.poll(async () => (await view()).selectedLineIds.includes(line.id)).toBe(selectedIds.includes(line.id));
    }
    await noExpenses();
    await evidence.capture('ignored-payment-and-human-subset');

    // Read-only state identifies the active field; every answer is sent by the actual guided UI.
    for (let attempt = 0; attempt < 30; attempt++) {
      const current = await view();
      const question = current.questions.find(q => isPendingImportQuestion(q) && q.lineIds.some(id => selectedIds.includes(id)));
      if (!question) break;
      await page.getByRole('button', { name: 'Consultar pergunta atual', exact: true }).click();
      const form = page.getByRole('form', { name: question.text, exact: true });
      await expect(form).toBeVisible();
      const answers: Record<string, string> = {
        amountMeaning: 'total da compra', installmentCount: String(expected.declarations.installmentCount),
        firstDueDate: expected.declarations.firstDueDate.split('-').reverse().join('/'),
        targets: 'sem rateio', decision: 'criar compra nova', tipoDespesa: 'OUTROS',
      };
      const answer = answers[question.field];
      expect(answer, `Unexpected fixture question ${question.field}; do not invent documentary facts`).toBeTruthy();
      if (question.field === 'amountMeaning' && await form.getByRole('radio', { name: 'Total da compra', exact: true }).count()) {
        await form.getByRole('radio', { name: 'Total da compra', exact: true }).check();
      } else {
        await form.locator('input:not([type=radio])').fill(answer);
      }
      await evidence.capture(`answer-${attempt + 1}-${question.field}-before-send`);
      if ('subject' in question) {
        await form.getByRole('button', { name: 'Conferir informação', exact: true }).click();
        await expect(form.getByLabel('Prévia da informação', { exact: true })).toBeVisible();
        await form.getByRole('button', { name: 'Guardar informação', exact: true }).click();
      } else {
        await form.getByRole('button', { name: 'Responder à pergunta', exact: true }).click();
      }
      await expect.poll(async () => (await view()).revision, { message: `Answer ${question.field} must persist` }).toBeGreaterThan(current.revision);
      await noExpenses();
      await evidence.capture(`answer-${attempt + 1}-${question.field}-saved`);
    }
    expect((await view()).questions.filter(q => isPendingImportQuestion(q) && q.lineIds.some(id => selectedIds.includes(id)))).toEqual([]);
    await page.getByRole('button', { name: 'Abrir revisão do lote', exact: true }).click();
    const review = page.getByRole('region', { name: 'Revisão do lote', exact: true });
    await expect(review).toBeVisible();
    const purchases = review.getByRole('list', { name: 'Compras do lote', exact: true });
    await expect(purchases.locator(':scope > li')).toHaveCount(2);
    for (const title of chosen) await expect(purchases).toContainText(title);
    await expect(purchases).not.toContainText('Pagamento de fatura');
    await test.step('money readability metric (non-blocking until test end)', async () => {
      await assertReadableMoney(review, true);
    });
    const confirm = review.getByRole('button', { name: 'Confirmar lote', exact: true });
    await assertTouchable(confirm);
    await noExpenses();
    await evidence.capture('review-exact-subset-no-financial-writes');
    await confirm.click();
    const receipt = page.getByTestId('import-receipt');
    await expect(receipt).toBeVisible();
    await expect(receipt.getByRole('heading', { name: 'Comprovante da importação', exact: true })).toBeVisible();
    await expect.poll(async () => (await expenses()).total).toBe(2);
    const applied = await expenses();
    expect(applied.items.map(item => item.titulo).sort()).toEqual([...chosen].sort());
    expect(new Set(applied.items.map(item => item.id)).size).toBe(2);
    expect(applied.items.every(item => item.creditCardId === card.id)).toBe(true);
    expect(applied.items.reduce((sum, item) => sum + item.valor, 0)).toBe(selectedTotal);
    const terminal = await view();
    expect(terminal.state).toBe('APPLIED');
    expect(terminal.receipt).toBeTruthy();
    await assertReadableMoney(receipt, true);
    await evidence.capture('confirmed-receipt-two-purchases');

    await page.reload();
    await expect(page.getByRole('region', { name: 'Conversa da importação', exact: true })).toBeVisible();
    // Terminal reads can require opening the saved result; this is not a new financial consent.
    if (!await receipt.isVisible()) {
      await page.getByRole('button', { name: 'Consultar comprovante', exact: true }).click();
    }
    await expect(receipt).toBeVisible();
    expect((await view()).state).toBe('APPLIED');
    expect((await view()).receipt).toEqual(terminal.receipt);
    await expect(picker).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Analisar documento|Analisar e guardar rascunho|Confirmar lote|Aplicar lote confirmado|Retomar envio/ })).toHaveCount(0);
    expect((await expenses()).items.map(item => item.id).sort()).toEqual(applied.items.map(item => item.id).sort());
    await assertReadableMoney(receipt, true);
    await evidence.capture('terminal-receipt-persists-no-reupload');
  } finally {
    if (!page.isClosed()) await evidence.capture('final-state').catch(() => evidence.persist());
    await evidence.persist();
    evidence.assertClean();
  }
});
}
