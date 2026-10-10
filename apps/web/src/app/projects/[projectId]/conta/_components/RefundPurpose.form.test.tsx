/**
 * #704 — entrada secundária "Finalidade do crédito" no formulário de despesa e a fronteira com os
 * metadados (FE RED v2, produção ausente).
 *
 * AuthProvider + DespesaModal + ExpenseFormModal REAIS; só `@/lib/api` é falso (corpos literais,
 * ver RefundPurpose.fixtures.ts). A despesa editada é do projeto DONO (`proj-owner`) exibida na
 * Conta do `proj-1`: GET/POST/DELETE da finalidade usam o dono. Abrir/cancelar/concluir a
 * finalidade nunca escreve metadados, nunca submete o formulário pai, nunca fecha o modal pai e
 * preserva o rascunho descritivo mesmo quando a despesa é relida com outro conteúdo.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '@/contexts/auth-context';
import { DespesaModal } from './DespesaModal';
import {
  ANCHOR,
  AUTH_USER,
  OPTIONS_FOR_FOREIGN_SOURCE,
  OWNER,
  PREPARE_STATE,
  PROJECT_CATALOG,
  PROJECT_DETAILS,
  READ_FOREIGN,
  ROOT_FOREIGN,
  appliedBody,
  assignedState,
  deferred,
  previewBody,
  settleFor,
} from './RefundPurpose.fixtures';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  deleteWithBody: vi.fn(),
}));
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return { ...actual, api: apiMock };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ApiResponseError } from '@/lib/api';

const SENTINEL = 'PrismaClientKnownRequestError: Invalid `prisma.expense.update()` invocation';
const DRAFT = 'Rascunho do usuário';
const CREDIT = {
  id: 'credit',
  projectId: OWNER,
  tipoDespesa: 'OUTROS',
  titulo: 'Título original',
  fornecedor: 'Fornecedor',
  valor: -12_345_678,
  valorTotal: -12_345_678,
  quantidade: 1,
  formaPagamento: 'A_VISTA',
  dataPagamento: '2026-06-15T00:00:00.000Z',
  status: 'PAGO',
  cardLast4: '1234',
  canDelete: true,
};
// Releitura da MESMA despesa com conteúdo materialmente diferente (objeto novo, sem structural sharing).
const CREDIT_REFETCHED = { ...CREDIT, titulo: 'Título vindo do servidor', fornecedor: 'Outro fornecedor', status: 'PLANEJADO', canDelete: false };

let root: unknown;
let readQueue: Array<() => unknown>;
const readsOf = (path: string) => apiMock.get.mock.calls.filter(([p]) => p === path).length;
const purposeReads = () => readsOf(READ_FOREIGN);

beforeEach(() => {
  vi.clearAllMocks();
  root = CREDIT;
  readQueue = [() => PREPARE_STATE];
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/auth/me') return AUTH_USER;
    if (path === '/projects') return PROJECT_CATALOG;
    // Detalhe nativo do destino (ambientes ativos e apagados); a lista acima não traz `rooms`.
    if (/^\/projects\/[^/]+$/.test(path)) return PROJECT_DETAILS[path.split('/')[2]];
    if (path === ROOT_FOREIGN) return root;
    if (path === READ_FOREIGN) return readQueue.length > 1 ? readQueue.shift()!() : readQueue[0]();
    if (path.endsWith('/rateio')) return { rateado: false };
    return [];
  });
  apiMock.post.mockImplementation(async (_p: string, body: { mode: string }) => (body.mode === 'preview' ? previewBody() : appliedBody()));
  apiMock.patch.mockResolvedValue(CREDIT);
  apiMock.put.mockResolvedValue(CREDIT);
});
afterEach(cleanup);

function mount() {
  const onClose = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <DespesaModal open onClose={onClose} projectId={ANCHOR} editExpenseId="credit" targetProjectId={OWNER} targetProjectType="REFORMA" />
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { onClose };
}

const writes = () => apiMock.patch.mock.calls.length + apiMock.put.mock.calls.length;
const openDialogs = () => screen.queryAllByRole('dialog').filter((el) => el.getAttribute('aria-hidden') !== 'true');
const optionValues = (select: HTMLElement) =>
  Array.from((select as HTMLSelectElement).options)
    .map((o) => o.value)
    .filter(Boolean);
const titleField = () => screen.findByLabelText(/título/i);
const entryButton = () => screen.findByRole('button', { name: /finalidade do crédito/i });

async function typeDraftAndOpenPurpose() {
  fireEvent.change(await titleField(), { target: { value: DRAFT } });
  const entry = await entryButton();
  fireEvent.click(entry);
  return screen.findByRole('dialog', { name: /finalidade do crédito/i });
}
async function preview(dialog: HTMLElement) {
  const select = await within(dialog).findByLabelText(/^projeto/i);
  await waitFor(() => expect(optionValues(select)).toContain('proj-a'));
  fireEvent.change(select, { target: { value: 'proj-a' } });
  const verify = within(dialog).getByRole('button', { name: /verificar prévia/i });
  await waitFor(() => expect(verify).toBeEnabled()); // liberada quando o detalhe do destino chega
  fireEvent.click(verify);
  return within(dialog).findByRole('button', { name: /confirmar finalidade/i });
}

describe('F1 — entrada secundária', () => {
  it('é um botão separado de Salvar (type=button); zero GET antes; um GET no dono ao abrir; reabrir consulta de novo; sem polling', async () => {
    mount();
    const title = await titleField();
    fireEvent.change(title, { target: { value: DRAFT } });
    const entry = await entryButton();
    expect(entry).toHaveAttribute('type', 'button');
    expect(entry).not.toBe(screen.getByRole('button', { name: /^salvar$/i }));
    expect(purposeReads()).toBe(0);

    const held = deferred<unknown>();
    readQueue = [() => held.promise];
    fireEvent.click(entry);
    const dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    expect(await within(dialog).findByText(/consultando finalidade/i)).toBeInTheDocument();
    held.resolve(PREPARE_STATE);
    await within(dialog).findByRole('button', { name: /verificar prévia/i });
    await settleFor(30);
    expect(purposeReads()).toBe(1);
    expect(apiMock.get.mock.calls.map(([p]) => p).filter((p) => String(p).includes('refund-purpose'))).toEqual([READ_FOREIGN]);

    fireEvent.click(within(dialog).getByRole('button', { name: /^fechar$/i }));
    fireEvent.click(await entryButton());
    await within(await screen.findByRole('dialog', { name: /finalidade do crédito/i })).findByRole('button', { name: /verificar prévia/i });
    expect(purposeReads()).toBe(2);
    expect(title).toHaveValue(DRAFT);
  });

  it('destinos elegíveis pelo projeto DONO da despesa (mesmas regras do detalhe da Conta)', async () => {
    mount();
    const dialog = await typeDraftAndOpenPurpose();
    const select = await within(dialog).findByLabelText(/^projeto/i);
    await waitFor(() => expect(optionValues(select)).toEqual(OPTIONS_FOR_FOREIGN_SOURCE));
    expect(apiMock.get.mock.calls.map(([p]) => String(p)).filter((p) => /^\/projects\/[^/]+$/.test(p))).toEqual([]);
  });

  it('controle: despesa NÃO crédito não oferece a entrada', async () => {
    root = { ...CREDIT, valor: 80_000, valorTotal: 80_000, canDelete: true };
    mount();
    await titleField();
    await settleFor(30);
    expect(screen.queryByRole('button', { name: /finalidade do crédito/i })).toBeNull();
    expect(purposeReads()).toBe(0);
  });
});

describe('F8 — fronteira com metadados', () => {
  it('abrir → Fechar: zero PATCH/PUT, o pai não é submetido nem fechado, rascunho preservado, um diálogo interativo', async () => {
    const { onClose } = mount();
    const purpose = await typeDraftAndOpenPurpose();
    await within(purpose).findByRole('button', { name: /verificar prévia/i });
    expect(openDialogs()).toHaveLength(1);
    expect(writes()).toBe(0);

    fireEvent.click(within(purpose).getByRole('button', { name: /^fechar$/i }));
    expect(await titleField()).toHaveValue(DRAFT);
    await waitFor(() => expect(screen.getByRole('button', { name: /finalidade do crédito/i })).toHaveFocus());
    expect(writes()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Escape dispensa só a finalidade: o formulário pai continua aberto, com o rascunho, e o foco volta à entrada', async () => {
    const { onClose } = mount();
    const purpose = await typeDraftAndOpenPurpose();
    await within(purpose).findByRole('button', { name: /verificar prévia/i });
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /finalidade do crédito/i })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(await titleField()).toHaveValue(DRAFT);
    expect(openDialogs()).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole('button', { name: /finalidade do crédito/i })).toHaveFocus());
    expect(writes()).toBe(0);
  });

  it('Concluir depois de aplicar, com a despesa RELIDA com outro conteúdo: rascunho do título permanece; zero PATCH/PUT', async () => {
    readQueue = [() => PREPARE_STATE, () => assignedState(1)];
    const { onClose } = mount();
    const purpose = await typeDraftAndOpenPurpose();
    const confirm = await preview(purpose);
    const readsBefore = readsOf(ROOT_FOREIGN);
    root = CREDIT_REFETCHED;
    fireEvent.click(confirm);
    const done = await within(purpose).findByRole('button', { name: /^concluir$/i });
    // Marcador positivo: a releitura da despesa aconteceu e devolveu OBJETO diferente.
    await waitFor(() => expect(readsOf(ROOT_FOREIGN)).toBeGreaterThan(readsBefore));
    fireEvent.click(done);
    expect(await titleField()).toHaveValue(DRAFT);
    expect(screen.queryByDisplayValue('Título vindo do servidor')).toBeNull();
    expect(writes()).toBe(0);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('Desfazer → Cancelar → Fechar: o modal pai continua aberto (sem reset de `open`), rascunho preservado, zero PATCH/PUT/DELETE', async () => {
    readQueue = [() => assignedState(3)];
    const { onClose } = mount();
    const purpose = await typeDraftAndOpenPurpose();
    fireEvent.click(await within(purpose).findByRole('button', { name: /desfazer finalidade/i }));
    fireEvent.click(within(purpose).getByRole('button', { name: /^cancelar$/i }));
    expect(await within(purpose).findByRole('button', { name: /desfazer finalidade/i })).toBeInTheDocument();
    expect(await titleField()).toHaveValue(DRAFT);
    fireEvent.click(within(purpose).getByRole('button', { name: /^fechar$/i }));
    expect(await titleField()).toHaveValue(DRAFT);
    expect(writes()).toBe(0);
    expect(apiMock.deleteWithBody).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['500 com causa técnica', new ApiResponseError(SENTINEL, 500, { message: SENTINEL })],
    ['403', new ApiResponseError('Sem permissão em proj-secreto', 403, {})],
    ['404', new ApiResponseError('Despesa proj-secreto/credit não encontrada', 404, {})],
  ])('prévia %s: mensagem neutra, nenhuma causa técnica/identificador no DOM, rascunho e pai intactos', async (_label, error) => {
    apiMock.post.mockRejectedValueOnce(error);
    mount();
    const purpose = await typeDraftAndOpenPurpose();
    const select = await within(purpose).findByLabelText(/^projeto/i);
    await waitFor(() => expect(optionValues(select)).toContain('proj-a'));
    fireEvent.change(select, { target: { value: 'proj-a' } });
    const verify = within(purpose).getByRole('button', { name: /verificar prévia/i });
    await waitFor(() => expect(verify).toBeEnabled());
    fireEvent.click(verify);
    expect(await within(purpose).findByText('Não foi possível preparar esta finalidade.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/prisma|invocation|proj-secreto|permissão|não encontrada/i);
    expect(await titleField()).toHaveValue(DRAFT);
    expect(writes()).toBe(0);
  });

  it('controle: Salvar continua salvando o rascunho (o mock de escrita enxerga um PATCH real, só metadados)', async () => {
    mount();
    fireEvent.change(await titleField(), { target: { value: DRAFT } });
    fireEvent.click(screen.getByRole('button', { name: /^salvar$/i }));
    await waitFor(() => expect(writes()).toBe(1));
    expect(apiMock.patch).toHaveBeenCalledWith(ROOT_FOREIGN, expect.objectContaining({ titulo: DRAFT }));
  });
});
