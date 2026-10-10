/**
 * #704 — "Finalidade do crédito" no detalhe da Conta (FE RED v2, produção ausente).
 *
 * Componentes reais (AuthProvider → MovimentacoesSection → FinancialItemDetail → conteúdo da
 * finalidade); só `@/lib/api` é falso, com corpos JSON LITERAIS (ver RefundPurpose.fixtures.ts).
 * Nenhum tipo/DTO paralelo, nenhum componente copiado: sem a entrada real, tudo abaixo falha já
 * no CTA. As asserções seguintes são o portão do GREEN. Stub prova a UI, não a jornada real.
 *
 * Identidade: a Conta é do projeto `proj-1` (PESSOAL); a compra `credit` pertence a `proj-owner`
 * e a linha traz id COMPOSTO `credit#2` (+ foreignExpenseId). GET/POST/DELETE vão para
 * `/projects/proj-owner/expenses/credit/refund-purpose`, nunca para o id da linha nem para a âncora.
 */
import { QueryClient, QueryClientProvider, focusManager, onlineManager, useQuery } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RefundPurposeAction, RefundPurposeSummary } from '@reformaflow/domain';
import { AuthProvider } from '@/contexts/auth-context';
import { DespesaModal } from './DespesaModal';
import { MovimentacoesSection } from './MovimentacoesSection';
import type { AccountViewResponse, AccountViewSaida } from '../_types';
import {
  ANCHOR,
  AUTH_USER,
  D_CAIXA,
  FP1,
  FP2,
  OPTIONS_FOR_FOREIGN_SOURCE,
  OPTIONS_FOR_OWN_SOURCE,
  OWNER,
  PREPARE_STATE,
  PROJECT_CATALOG,
  PROJECT_DETAILS,
  ROOM_ACTIVE,
  ROOM_DELETED,
  detailPath,
  READ_FOREIGN,
  READ_OWN,
  ROOT_OWN,
  ROOT_FOREIGN,
  SHOWN,
  appliedBody,
  assignedState,
  deferred,
  pairText,
  previewBody,
  settleFor,
  tick,
} from './RefundPurpose.fixtures';

// A Conta faz outros POSTs (sugestão de categoria): só os da finalidade contam nas asserções.
const purposePost = vi.hoisted(() => vi.fn());
const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn((path: string, body: unknown) => (path.endsWith('/refund-purpose') ? purposePost(path, body) : Promise.resolve({}))),
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

// O import vem DEPOIS do mock: erros reais (status + body / timeout), não formas presumidas.
import { ApiResponseError, ApiTimeoutError } from '@/lib/api';

const NEGATIVE_MONEY = /(-\s*R\$\s*123\.456,78|R\$\s*-\s*123\.456,78)/;
const CONSULT_ERROR = /não foi possível consultar a finalidade agora/i;
const LOST_UNDO = 'Não foi possível confirmar se a finalidade foi desfeita.';
const LOST_APPLY = /não foi possível confirmar o resultado/i;
const SENTINEL = 'PrismaClientKnownRequestError: Invalid `prisma.expense.update()` invocation';
const SUCCESS_WORDS = /desfeita com sucesso|finalidade desfeita\.|concluíd|atribuída com sucesso/i;

function httpError(status: number, message = 'erro') {
  return new ApiResponseError(message, status, { message });
}

function credit(overrides: Partial<AccountViewSaida> = {}): AccountViewSaida {
  return {
    id: 'credit-own',
    kind: 'saida',
    descricao: 'Crédito importado',
    data: '2026-06-15T00:00:00.000Z',
    forma: 'cartao',
    valor: -12_345_678,
    expenseIsCredit: true,
    realizado: true,
    status: 'PAGO',
    cardLast4: '1234',
    bankLast4: null,
    tipoDespesa: 'OUTROS',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...overrides,
  };
}
// Ocorrência (parcela #2) de uma compra REAL do projeto dono: id composto só serve de key.
const foreignCredit = (overrides: Partial<AccountViewSaida> = {}) =>
  credit({
    id: 'credit#2',
    foreignExpenseId: 'credit',
    parcelaIndex: 2,
    projetoOrigem: { id: OWNER, name: 'Reforma Dona', type: 'REFORMA' },
    ...overrides,
  });

function response(saidas: AccountViewSaida[], comprasCartao: AccountViewSaida[] = [], cartoes: AccountViewResponse['cartoes'] = []): AccountViewResponse {
  return {
    mesSelecionado: '2026-06',
    caixaHoje: 0,
    carteiraHoje: 0,
    entrouMes: 0,
    saiuMes: 0,
    faltaPagarMes: 0,
    recebimentosPrevistosMes: 0,
    sobraPrevista: 0,
    devoCartaoTotal: 0,
    cartoes,
    contas: [],
    saidas,
    comprasCartao,
    entradas: [],
    ticketMedio: { valor: 0, nCompras: 0, totalCompras: 0, serie6m: [], media6m: 0, deltaVsMediaPct: null },
  };
}

function mockMobile() {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: 390 <= parseInt(query.match(/(\d+)/)?.[1] ?? '0', 10),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

// Respostas por caminho: a última se repete. Uma função pode devolver corpo, Promise ou lançar.
let queues: Record<string, Array<() => unknown>>;
let catalogFails: boolean;
// Fila de respostas do detalhe `GET /projects/:id` por caminho; a última repete. Sem fila: detalhe nativo.
let detailQueues: Record<string, Array<() => unknown>>;
let me: Record<string, unknown>;
const readsOf = (path: string) => apiMock.get.mock.calls.filter(([p]) => p === path).length;
const getPaths = () => apiMock.get.mock.calls.map(([p]) => p as string);
const detailGets = () => getPaths().filter((p) => /^\/projects\/[^/]+$/.test(p));
const nextOf = (path: string) => {
  const q = queues[path];
  return q.length > 1 ? q.shift()!() : q[0]();
};

beforeEach(() => {
  vi.clearAllMocks();
  mockMobile();
  catalogFails = false;
  detailQueues = {};
  me = AUTH_USER;
  queues = { [READ_FOREIGN]: [() => PREPARE_STATE] };
  apiMock.get.mockImplementation(async (path: string) => {
    if (path === '/auth/me') return me;
    if (path === '/projects') {
      if (catalogFails) throw httpError(503, 'Catálogo indisponível');
      return PROJECT_CATALOG;
    }
    if (queues[path]) return nextOf(path);
    const detail = /^\/projects\/([^/]+)$/.exec(path);
    if (detail) {
      const q = detailQueues[path];
      if (q) return q.length > 1 ? q.shift()!() : q[0]();
      if (PROJECT_DETAILS[detail[1]]) return PROJECT_DETAILS[detail[1]];
      throw httpError(404, 'Projeto não encontrado');
    }
    if (path === ROOT_FOREIGN) return { id: 'credit', valorTotal: -12_345_678, canDelete: false };
    if (path.startsWith('/__probe/')) return [];
    return [];
  });
  // `mockReset` também descarta `...Once` deixado por um teste que falhou antes de consumi-lo.
  purposePost.mockReset();
  purposePost.mockResolvedValue({});
  apiMock.deleteWithBody.mockResolvedValue({ revision: 2, alreadyUndone: false });
});
afterEach(() => {
  cleanup();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

// Observadores das chaves canônicas que o helper existente de invalidação de despesa precisa alcançar.
const PROBES = {
  anchor: ['account-view', ANCHOR, '2026-06'],
  owner: ['account-view', OWNER, '2026-06'],
  target: ['account-view', 'proj-a', '2026-06'],
} as const;
function Probes() {
  for (const [name, key] of Object.entries(PROBES)) {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- lista fixa e estável
    useQuery({ queryKey: [...key], queryFn: () => apiMock.get(`/__probe/${name}`), staleTime: Infinity });
  }
  return null;
}
const probeReads = (name: keyof typeof PROBES) => readsOf(`/__probe/${name}`);

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const CREDIT_FORM = {
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
  canDelete: false,
};

function mount(saidas: AccountViewSaida[] = [foreignCredit()], client = newClient(), withForm = false, cards: AccountViewSaida[] = [], view: { originFilter?: string | null; cartoes?: AccountViewResponse['cartoes']; initialItemId?: string | null } = {}) {
  const tree = (rows: AccountViewSaida[], cardRows: AccountViewSaida[]) => (
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Probes />
        {withForm && <DespesaModal open onClose={vi.fn()} projectId={ANCHOR} editExpenseId="credit" targetProjectId={OWNER} targetProjectType="REFORMA" />}
        <MovimentacoesSection
          data={response(rows, cardRows, view.cartoes)}
          projectId={ANCHOR}
          originFilter={view.originFilter ?? null}
          initialItemId={view.initialItemId}
          onClearOrigin={vi.fn()}
          onPayInvoice={vi.fn()}
          onAdjustInvoice={vi.fn()}
          onSettleWithResidual={vi.fn()}
          onUndoPayment={vi.fn()}
          summaryQuickFilter={null}
          onClearSummaryQuickFilter={vi.fn()}
        />
      </AuthProvider>
    </QueryClientProvider>
  );
  const rendered = render(tree(saidas, cards));
  // Novo objeto de dados = o refetch do account-view (mesmas linhas, novas referências).
  return { rerenderWith: (rows: AccountViewSaida[], cardRows: AccountViewSaida[] = []) => rendered.rerender(tree(rows, cardRows)) };
}

const detail = () => screen.getByTestId('financial-detail-sheet');
function detailButtonOf(descricao: string) {
  let el: HTMLElement | null = screen.getByText(descricao);
  while (el && !el.querySelector('[aria-label="Ver detalhe"]')) el = el.parentElement;
  if (!el) throw new Error(`linha sem "Ver detalhe": ${descricao}`);
  return el.querySelector<HTMLElement>('[aria-label="Ver detalhe"]')!;
}
async function openDetail(descricao = 'Crédito importado') {
  await screen.findByText(descricao);
  fireEvent.click(detailButtonOf(descricao));
  return within(detail());
}
const purposeEntry = (scope: ReturnType<typeof within>) => scope.findByRole('button', { name: /finalidade do crédito/i });
async function openPurpose(descricao?: string) {
  const d = await openDetail(descricao);
  fireEvent.click(await purposeEntry(d));
  return screen.findByRole('dialog', { name: /finalidade do crédito/i });
}
const queryBtn = (root: HTMLElement | typeof screen, name: RegExp | string) => within(root as HTMLElement).queryByRole('button', { name });
const optionValues = (select: HTMLElement) =>
  Array.from((select as HTMLSelectElement).options)
    .map((o) => o.value)
    .filter(Boolean);

/** Leitura concluída = texto de consulta sumiu (dependendo de promessa controlada) + um tick. */
async function afterLoad(dialog: HTMLElement) {
  await waitFor(() => expect(within(dialog).queryByText(/consultando finalidade/i)).toBeNull());
  await tick();
}
/** Monta a Conta e abre a finalidade com a leitura RETIDA: prova o estado "consultando" antes de liberar. */
async function openHeld() {
  mount();
  const held = deferred<unknown>();
  queues[READ_FOREIGN] = [() => held.promise];
  const dialog = await openPurpose();
  expect(await within(dialog).findByText(/consultando finalidade/i)).toBeInTheDocument();
  return { dialog, held };
}

describe('F1 — entrada, identidade e orçamento de leitura', () => {
  it('Conta/detalhe fazem zero GET de finalidade; abrir faz UM, na URL do projeto DONO com o id REAL; reabrir consulta de novo sem herdar capacidade', async () => {
    mount();
    const d = await openDetail();
    expect(await purposeEntry(d)).toBeInTheDocument();
    expect(getPaths().filter((p) => p.includes('refund-purpose'))).toEqual([]);

    const first = deferred<unknown>();
    queues[READ_FOREIGN] = [() => first.promise];
    fireEvent.click(await purposeEntry(d));
    let dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    expect(await within(dialog).findByText(/consultando finalidade/i)).toBeInTheDocument();
    first.resolve(PREPARE_STATE);
    expect(await within(dialog).findByRole('button', { name: /verificar prévia/i })).toBeInTheDocument();
    expect(getPaths().filter((p) => p.includes('refund-purpose'))).toEqual([READ_FOREIGN]);

    fireEvent.click(within(dialog).getByRole('button', { name: /^fechar$/i }));
    const second = deferred<unknown>();
    queues[READ_FOREIGN] = [() => second.promise];
    fireEvent.click(await purposeEntry(within(detail())));
    dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    // Capacidade da leitura anterior não vale durante a nova consulta.
    expect(await within(dialog).findByText(/consultando finalidade/i)).toBeInTheDocument();
    expect(queryBtn(dialog, /verificar prévia|desfazer finalidade/i)).toBeNull();
    second.resolve(PREPARE_STATE);
    await within(dialog).findByRole('button', { name: /verificar prévia/i });
    expect(readsOf(READ_FOREIGN)).toBe(2);
    expect(getPaths().filter((p) => p.includes('refund-purpose') && p !== READ_FOREIGN)).toEqual([]);
  });

  it('compra do próprio projeto da Conta usa o id da linha e a âncora como projeto', async () => {
    queues[READ_OWN] = [() => PREPARE_STATE];
    mount([credit()]);
    const d = await openDetail();
    fireEvent.click(await purposeEntry(d));
    await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    await waitFor(() => expect(readsOf(READ_OWN)).toBe(1));
    expect(getPaths().filter((p) => p.includes('refund-purpose'))).toEqual([READ_OWN]);
  });

  it.each([
    ['sinal da ocorrência não decide: parcela POSITIVA de raiz crédito (flag true) oferece a entrada', { valor: 5_000, expenseIsCredit: true }, null, true],
    ['valor<0 com flag false NÃO oferece a entrada e nada é lido', { valor: -12_345_678, expenseIsCredit: false }, null, false],
    ['flag ausente: raiz provada crédito no detalhe REAL do dono (leitura sob demanda) oferece a entrada', { expenseIsCredit: undefined }, { id: 'credit', valorTotal: -12_345_678, canDelete: false }, true],
    ['flag ausente: raiz provada NÃO-crédito no detalhe REAL do dono não oferece a entrada', { valor: -1_000, expenseIsCredit: undefined }, { id: 'credit', valorTotal: 250_000, canDelete: true }, false],
  ])('%s', async (_label, rowOver, root, offered) => {
    if (root) queues[ROOT_FOREIGN] = [() => root];
    mount([foreignCredit(rowOver as Partial<AccountViewSaida>)]);
    await screen.findByText('Crédito importado');
    if (root) {
      fireEvent.focus(detailButtonOf('Crédito importado'));
      await waitFor(() => expect(readsOf(ROOT_FOREIGN)).toBe(1));
    }
    const d = await openDetail();
    if (offered) {
      expect(await purposeEntry(d)).toBeInTheDocument();
    } else {
      expect(within(detail()).getByText(/detalhe do lançamento/i)).toBeInTheDocument();
      await tick();
      expect(d.queryByRole('button', { name: /finalidade do crédito/i })).toBeNull();
    }
    expect(getPaths().filter((p) => p.includes('refund-purpose'))).toEqual([]);
  });

  it('controle: despesa comum (positiva, flag false) não oferece a entrada e nada é lido', async () => {
    mount([foreignCredit({ descricao: 'Despesa comum', valor: 80_000, expenseIsCredit: false })]);
    const d = await openDetail('Despesa comum');
    expect(within(detail()).getByText(/detalhe do lançamento/i)).toBeInTheDocument();
    expect(d.queryByRole('button', { name: /finalidade do crédito/i })).toBeNull();
    expect(getPaths().filter((p) => p.includes('refund-purpose'))).toEqual([]);
  });

  it('leitura tardia de A depois de abrir B não habilita a ação de A no diálogo de B', async () => {
    const READ_B = `/projects/${OWNER}/expenses/credit-b/refund-purpose`;
    mount([
      foreignCredit({ descricao: 'Crédito A' }),
      foreignCredit({ id: 'credit-b#1', foreignExpenseId: 'credit-b', descricao: 'Crédito B' }),
    ]);
    const heldA = deferred<unknown>();
    queues[READ_FOREIGN] = [() => heldA.promise];
    queues[READ_B] = [() => ({ ...PREPARE_STATE, sourceExpenseId: 'credit-b' })];

    const dialogA = await openPurpose('Crédito A');
    expect(await within(dialogA).findByText(/consultando finalidade/i)).toBeInTheDocument();
    fireEvent.click(within(dialogA).getByRole('button', { name: /^fechar$/i }));
    fireEvent.click(within(detail()).getByRole('button', { name: /^fechar$/i }));

    const dialogB = await openPurpose('Crédito B');
    expect(await within(dialogB).findByRole('button', { name: /verificar prévia/i })).toBeInTheDocument();
    heldA.resolve(assignedState(3));
    await tick();
    await tick();
    expect(readsOf(READ_B)).toBe(1);
    expect(within(dialogB).getByRole('button', { name: /verificar prévia/i })).toBeInTheDocument();
    expect(queryBtn(dialogB, /desfazer finalidade/i)).toBeNull();
    expect(apiMock.deleteWithBody).not.toHaveBeenCalled();
  });
});

describe('F2 — capacidades, opacidade e resumo persistido', () => {
  it.each([
    ['actions [] (valor negativo e canDelete não concedem nada)', { ...PREPARE_STATE, actions: [] }, [], [/verificar prévia/i, /desfazer finalidade/i]],
    ['PREPARE: só pedir prévia', PREPARE_STATE, [/verificar prévia/i], [/desfazer finalidade/i]],
    ['UNDO com atribuição: só desfazer', assignedState(3), [/desfazer finalidade/i], [/verificar prévia/i]],
  ])('%s', async (_label, body, present, absent) => {
    const { dialog, held } = await openHeld();
    held.resolve(body);
    await afterLoad(dialog);
    expect(within(dialog).getByRole('button', { name: /^fechar$/i })).toBeInTheDocument();
    for (const name of present) expect(within(dialog).getByRole('button', { name })).toBeInTheDocument();
    for (const name of absent) expect(queryBtn(dialog, name)).toBeNull();
  });

  it('atribuição visível sem ações: resumo persistido com CADA data ligada ao seu rótulo e valor íntegro', async () => {
    const { dialog, held } = await openHeld();
    held.resolve(assignedState(3, {}, []));
    await afterLoad(dialog);
    const compra = pairText(dialog, /data da compra/i);
    const pagamento = pairText(dialog, /pagamento/i);
    const caixa = pairText(dialog, /caixa/i);
    expect(compra).toContain(SHOWN.compra);
    expect(compra).not.toMatch(/15\/06\/2026|20\/06\/2026/);
    expect(pagamento).toContain(SHOWN.pagamento);
    expect(pagamento).not.toMatch(/10\/05\/2026|20\/06\/2026/);
    expect(caixa).toContain(SHOWN.caixa);
    expect(dialog.textContent).toMatch(NEGATIVE_MONEY);
    expect(dialog.textContent).not.toContain(D_CAIXA);
    expect(queryBtn(dialog, /desfazer finalidade|verificar prévia/i)).toBeNull();
  });

  // A revisão persistida pode ser qualquer inteiro que o backend preserve (par, ímpar, zero ou negativo):
  // o leitor não infere estado da paridade e continua mostrando os fatos, sem oferecer ação.
  it.each([0, 2, 4, -1])('assignment com revisão %i e actions []: mantém os fatos, sem CTA financeira e com UMA leitura', async (revision) => {
    const { dialog: reopened, held } = await openHeld();
    held.resolve(assignedState(revision, {}, []));
    await afterLoad(reopened);
    expect(readsOf(READ_FOREIGN)).toBe(1);
    expect(pairText(reopened, /data da compra/i)).toContain(SHOWN.compra);
    expect(pairText(reopened, /pagamento/i)).toContain(SHOWN.pagamento);
    expect(pairText(reopened, /caixa/i)).toContain(SHOWN.caixa);
    expect(reopened.textContent).toMatch(NEGATIVE_MONEY);
    expect(reopened.textContent).not.toMatch(CONSULT_ERROR);
    expect(queryBtn(reopened, /verificar prévia|desfazer finalidade|aplicar|confirmar/i)).toBeNull();
    expect(purposePost).not.toHaveBeenCalled();
    expect(apiMock.deleteWithBody).not.toHaveBeenCalled();
  });

  it('dataCompra null: nenhuma data inventada nem reaproveitada de outro campo', async () => {
    const { dialog, held } = await openHeld();
    held.resolve(assignedState(3, { dataCompra: null }, []));
    await afterLoad(dialog);
    expect(pairText(dialog, /pagamento/i)).toContain(SHOWN.pagamento);
    expect(dialog.textContent).not.toMatch(/invalid|nan|undefined|null|1970|10\/05\/2026/i);
    if (within(dialog).queryByText(/data da compra/i)) {
      expect(pairText(dialog, /data da compra/i)).not.toMatch(/15\/06\/2026|20\/06\/2026/);
    }
  });

  it('assignment null nunca vira "sem finalidade", "nunca atribuída", "oculta" ou "desfeita"', async () => {
    const { dialog, held } = await openHeld();
    held.resolve(PREPARE_STATE);
    await within(dialog).findByRole('button', { name: /verificar prévia/i });
    expect(dialog.textContent).not.toMatch(/sem finalidade|nunca|oculta|desfeit/i);
  });
});

const selectOf = (dialog: HTMLElement) => within(dialog).findByLabelText(/^projeto/i);
async function toPreview(project = 'proj-a', room?: string, descricao?: string) {
  const dialog = await openPurpose(descricao);
  const select = await selectOf(dialog);
  await waitFor(() => expect(optionValues(select)).toContain(project));
  fireEvent.change(select, { target: { value: project } });
  // Os ambientes vêm do detalhe do destino: esperar o ambiente existir e a prévia estar liberada.
  if (room) {
    const roomSelect = await within(dialog).findByLabelText(/ambiente/i);
    await waitFor(() => expect(optionValues(roomSelect)).toContain(room));
    fireEvent.change(roomSelect, { target: { value: room } });
  }
  const verify = within(dialog).getByRole('button', { name: /verificar prévia/i });
  await waitFor(() => expect(verify).toBeEnabled());
  fireEvent.click(verify);
  return dialog;
}
const confirmBtn = (dialog: HTMLElement) => within(dialog).findByRole('button', { name: /confirmar finalidade/i });
const previewBodyOf = (projectId: string, roomId: string | null) => ({ mode: 'preview', targetProjectId: projectId, roomId });

describe('F3 — destinos elegíveis, prévia e confirmação', () => {
  beforeEach(() => {
    purposePost.mockImplementation(async (_path: string, body: { mode: string }) => (body.mode === 'preview' ? previewBody() : appliedBody()));
  });

  it('opções exatas: sem a origem REAL, sem projeto negado/tipo não concedido/sem capacidade `expenses`; a lista real não traz ambientes e nada é lido até escolher um destino', async () => {
    const { dialog, held } = await openHeld();
    held.resolve(PREPARE_STATE);
    const select = await selectOf(dialog);
    await waitFor(() => expect(optionValues(select)).toEqual(OPTIONS_FOR_FOREIGN_SOURCE));
    const names = Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
    expect(names.join('|')).toMatch(/pessoal.*reforma a.*reforma b.*compra c/i);
    for (const excluded of ['proj-owner', 'proj-denied', 'proj-carro', 'proj-plantas']) expect(optionValues(select)).not.toContain(excluded);
    expect(detailGets()).toEqual([]);
  });

  it('compra do próprio PESSOAL: a origem (âncora) sai e o dono externo entra', async () => {
    queues[READ_OWN] = [() => PREPARE_STATE];
    mount([credit()]);
    const d = await openDetail();
    fireEvent.click(await purposeEntry(d));
    const dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    await waitFor(async () => expect(optionValues(await selectOf(dialog))).toEqual(OPTIONS_FOR_OWN_SOURCE));
  });

  it('falha do catálogo é sinal visível, não lista vazia de sucesso, e não habilita a prévia', async () => {
    catalogFails = true;
    const { dialog, held } = await openHeld();
    held.resolve(PREPARE_STATE);
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent?.trim()).not.toBe('');
    expect(dialog.textContent).not.toMatch(/nenhum projeto|sem projetos/i);
    expect(dialog.textContent).not.toMatch(/Catálogo indisponível/);
    const verify = queryBtn(dialog, /verificar prévia/i);
    expect(verify === null || verify.hasAttribute('disabled')).toBe(true);
    expect(purposePost).not.toHaveBeenCalled();
  });

  it('roomId sempre presente: "Sem ambiente" explícito envia null; ambiente escolhido envia a string; sempre na URL do dono', async () => {
    mount();
    let dialog = await toPreview();
    await confirmBtn(dialog);
    expect(purposePost).toHaveBeenCalledWith(READ_FOREIGN, previewBodyOf('proj-a', null));
    expect(within(dialog).getByLabelText(/ambiente/i)).toHaveDisplayValue(/sem ambiente/i);

    cleanup();
    purposePost.mockClear();
    mount();
    dialog = await toPreview('proj-a', 'room-a1');
    await confirmBtn(dialog);
    expect(purposePost).toHaveBeenCalledWith(READ_FOREIGN, previewBodyOf('proj-a', 'room-a1'));
  });

  it('trocar o PROJETO depois de escolher ambiente zera roomId e invalida a prévia; o próximo POST leva roomId null', async () => {
    mount();
    const dialog = await toPreview('proj-a', 'room-a1');
    await confirmBtn(dialog);
    expect(purposePost).toHaveBeenCalledTimes(1);

    fireEvent.change(within(dialog).getByLabelText(/^projeto/i), { target: { value: 'proj-b' } });
    expect(queryBtn(dialog, /confirmar finalidade/i)).toBeNull();
    const during = within(dialog).queryByLabelText(/ambiente/i);
    if (during) expect(optionValues(during)).not.toContain('room-a1'); // ambientes de A nunca servem B
    await waitFor(() => expect(optionValues(within(dialog).getByLabelText(/ambiente/i))).toEqual(['room-b1']));
    const room = within(dialog).getByLabelText(/ambiente/i);
    expect(room).toHaveDisplayValue(/sem ambiente/i);
    expect(purposePost).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByRole('button', { name: /verificar prévia/i }));
    await waitFor(() => expect(purposePost).toHaveBeenCalledTimes(2));
    expect(purposePost).toHaveBeenLastCalledWith(READ_FOREIGN, previewBodyOf('proj-b', null));
    expect(purposePost.mock.calls.every(([path]) => path === READ_FOREIGN)).toBe(true);
  });

  it('trocar o ambiente invalida a prévia sem POST novo', async () => {
    mount();
    const dialog = await toPreview();
    await confirmBtn(dialog);
    const roomSelect = within(dialog).getByLabelText(/ambiente/i);
    await waitFor(() => expect(optionValues(roomSelect)).toContain('room-a1'));
    fireEvent.change(roomSelect, { target: { value: 'room-a1' } });
    expect(queryBtn(dialog, /confirmar finalidade/i)).toBeNull();
    expect(purposePost).toHaveBeenCalledTimes(1);
  });

  it('sem prévia não há confirmação nem "aplicar/atribuir"; a cópia da confirmação só aparece com a prévia', async () => {
    mount();
    const dialog = await openPurpose();
    await within(dialog).findByRole('button', { name: /verificar prévia/i });
    expect(queryBtn(dialog, /confirmar finalidade/i)).toBeNull();
    expect(dialog.textContent).not.toMatch(/aplicar|atribuir/i);
    expect(dialog.textContent).not.toMatch(/não gera novo pagamento/i);
    const select = await selectOf(dialog);
    await waitFor(() => expect(optionValues(select)).toContain('proj-a'));
    fireEvent.change(select, { target: { value: 'proj-a' } });
    const verify = within(dialog).getByRole('button', { name: /verificar prévia/i });
    await waitFor(() => expect(verify).toBeEnabled());
    fireEvent.click(verify);
    await confirmBtn(dialog);
    expect(dialog).toHaveTextContent('Atribui este crédito ao custo do projeto escolhido. Não gera novo pagamento nem novo débito.');
  });

  it.each([0, 2])('confirmar envia exatamente os guardas da prévia (revisão par %i, fingerprint 64 hex); duplo clique gera uma escrita', async (revision) => {
    purposePost.mockImplementation(async (_p: string, body: { mode: string }) =>
      body.mode === 'preview' ? { ...previewBody(), revision } : appliedBody({ revision: revision + 1 }),
    );
    expect(FP1).toMatch(/^[a-f0-9]{64}$/);
    mount();
    const dialog = await toPreview();
    const confirm = await confirmBtn(dialog);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await waitFor(() => expect(purposePost).toHaveBeenCalledTimes(2));
    expect(purposePost).toHaveBeenLastCalledWith(READ_FOREIGN, {
      mode: 'apply',
      targetProjectId: 'proj-a',
      roomId: null,
      expectedRevision: revision,
      expectedFingerprint: FP1,
    });
    await settleFor(30);
    expect(purposePost).toHaveBeenCalledTimes(2);
    expect(apiMock.patch).not.toHaveBeenCalled();
    expect(apiMock.put).not.toHaveBeenCalled();
  });

  it.each([
    ['201 alreadyApplied:false', { alreadyApplied: false }],
    ['201 alreadyApplied:true', { alreadyApplied: true }],
  ])('sucesso %s: relê o estado, mostra Concluir e atualiza Conta/dono/destino pelo helper existente', async (_label, over) => {
    queues[READ_FOREIGN] = [() => PREPARE_STATE, () => assignedState(1)];
    purposePost.mockImplementation(async (_p: string, body: { mode: string }) => (body.mode === 'preview' ? previewBody() : appliedBody(over)));
    mount();
    await waitFor(() => expect(probeReads('anchor')).toBe(1));
    await waitFor(() => expect(probeReads('target')).toBe(1));
    const dialog = await toPreview();
    fireEvent.click(await confirmBtn(dialog));
    expect(await within(dialog).findByRole('button', { name: /^concluir$/i })).toBeInTheDocument();
    await waitFor(() => expect(readsOf(READ_FOREIGN)).toBe(2));
    expect(await within(dialog).findByRole('button', { name: /desfazer finalidade/i })).toBeInTheDocument();
    await waitFor(() => expect(probeReads('anchor')).toBeGreaterThan(1));
    expect(probeReads('owner')).toBeGreaterThan(1);
    expect(probeReads('target')).toBeGreaterThan(1);
  });
});

describe('F6 — erros visíveis, neutros, sem capacidade residual nem sucesso falso', () => {
  it.each([
    ['GET 500 com causa técnica', () => Promise.reject(httpError(500, SENTINEL))],
    ['GET 403', () => Promise.reject(httpError(403, 'Você não tem acesso ao projeto proj-secreto'))],
    ['GET 404', () => Promise.reject(httpError(404, 'Despesa proj-secreto/credit não encontrada'))],
    ['corpo vazio (null)', () => Promise.resolve(null)],
    ['corpo sem forma esperada', () => Promise.resolve({})],
  ])('%s: mensagem neutra, Consultar novamente/Fechar, nenhuma ação, nenhum vazamento', async (_label, read) => {
    queues[READ_FOREIGN] = [read as () => unknown];
    mount();
    const dialog = await openPurpose();
    expect(await within(dialog).findByText(CONSULT_ERROR)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /consultar novamente/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^fechar$/i })).toBeInTheDocument();
    expect(queryBtn(dialog, /verificar prévia|desfazer finalidade|confirmar finalidade/i)).toBeNull();
    for (const text of [dialog.textContent ?? '', document.body.textContent ?? '']) {
      expect(text).not.toMatch(/sem finalidade|nunca/i);
      expect(text).not.toMatch(/prisma|invocation|proj-secreto|acesso ao projeto|não encontrada/i);
    }
    expect(readsOf(READ_FOREIGN)).toBe(1);
  });

  it('falha após dado anterior: o erro vence e a capacidade antiga some; a releitura só por clique', async () => {
    queues[READ_FOREIGN] = [() => assignedState(3), () => Promise.reject(httpError(503)), () => assignedState(3)];
    mount();
    let dialog = await openPurpose();
    await within(dialog).findByRole('button', { name: /desfazer finalidade/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /^fechar$/i }));
    fireEvent.click(await purposeEntry(within(detail())));
    dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    expect(await within(dialog).findByText(CONSULT_ERROR)).toBeInTheDocument();
    expect(queryBtn(dialog, /desfazer finalidade/i)).toBeNull();
    expect(readsOf(READ_FOREIGN)).toBe(2);
    fireEvent.click(within(dialog).getByRole('button', { name: /consultar novamente/i }));
    expect(await within(dialog).findByRole('button', { name: /desfazer finalidade/i })).toBeInTheDocument();
    expect(readsOf(READ_FOREIGN)).toBe(3);
  });

  it.each([
    ['404', httpError(404, 'Projeto de destino proj-secreto inválido')],
    ['403', httpError(403, 'Sem permissão em proj-secreto')],
    ['500 com causa técnica', httpError(500, SENTINEL)],
  ])('prévia %s é neutra: sem destino oculto, sem causa técnica, sem confirmação', async (_label, error) => {
    purposePost.mockRejectedValueOnce(error);
    mount();
    const dialog = await toPreview();
    expect(await within(dialog).findByText('Não foi possível preparar esta finalidade.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/inválido|acesso|oculto|permissão|prisma|invocation|proj-secreto/i);
    expect(queryBtn(dialog, /confirmar finalidade/i)).toBeNull();
  });

  it('prévia 400 mantém o formulário e mostra o erro acionável junto dele', async () => {
    purposePost.mockRejectedValueOnce(httpError(400, 'Ambiente não pertence ao projeto'));
    mount();
    const dialog = await toPreview('proj-a', 'room-a1');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Ambiente não pertence ao projeto');
    expect(within(dialog).getByLabelText(/^projeto/i)).toHaveValue('proj-a');
    expect(within(dialog).getByLabelText(/ambiente/i)).toHaveValue('room-a1');
  });

  it('409 no apply invalida a prévia e oferece releitura explícita, sem repetir o apply nem reler sozinho', async () => {
    purposePost.mockImplementation(async (_p: string, body: { mode: string }) => {
      if (body.mode === 'preview') return previewBody();
      throw httpError(409, 'Conflito');
    });
    mount();
    const dialog = await toPreview();
    fireEvent.click(await confirmBtn(dialog));
    await within(dialog).findByRole('alert');
    expect(queryBtn(dialog, /confirmar finalidade/i)).toBeNull();
    await settleFor(30);
    expect(purposePost).toHaveBeenCalledTimes(2);
    expect(readsOf(READ_FOREIGN)).toBe(1);
    fireEvent.click(within(dialog).getByRole('button', { name: /consultar novamente/i }));
    await waitFor(() => expect(readsOf(READ_FOREIGN)).toBe(2));
    expect(purposePost).toHaveBeenCalledTimes(2);
  });
});

async function toUndoConfirmation() {
  const dialog = await openPurpose();
  fireEvent.click(await within(dialog).findByRole('button', { name: /desfazer finalidade/i }));
  return dialog;
}
/** A confirmação é um grupo acessível nomeado — escopo por estado, nunca por índice nem por pai direto. */
function confirmUndo(dialog: HTMLElement) {
  const group = within(dialog).getByRole('group', { name: /confirmar desfazer/i });
  return within(group).getByRole('button', { name: /desfazer finalidade/i });
}

const LOSSES: Array<[string, () => unknown]> = [
  ['rede', () => new Error('Failed to fetch')],
  ['timeout', () => new ApiTimeoutError()],
  ['HTTP 502', () => httpError(502, 'Bad Gateway')],
];

describe('F7 — desfazer', () => {
  it('pede confirmação própria (foco em Cancelar) e envia a revisão da leitura ATUAL, pelo transporte com corpo', async () => {
    queues[READ_FOREIGN] = [() => assignedState(3)];
    mount();
    const dialog = await toUndoConfirmation();
    expect(within(dialog).getByRole('button', { name: /^cancelar$/i })).toHaveFocus();
    expect(apiMock.deleteWithBody).not.toHaveBeenCalled();
    fireEvent.click(confirmUndo(dialog));
    await waitFor(() => expect(apiMock.deleteWithBody).toHaveBeenCalledTimes(1));
    expect(apiMock.deleteWithBody).toHaveBeenCalledWith(READ_FOREIGN, { expectedRevision: 3 });
    expect(apiMock.delete).not.toHaveBeenCalled();
  });

  it('Cancelar volta ao resumo com o diálogo aberto, sem DELETE', async () => {
    queues[READ_FOREIGN] = [() => assignedState(3)];
    mount();
    const dialog = await toUndoConfirmation();
    fireEvent.click(within(dialog).getByRole('button', { name: /^cancelar$/i }));
    expect(await within(dialog).findByRole('button', { name: /desfazer finalidade/i })).toBeInTheDocument();
    expect(queryBtn(dialog, /^cancelar$/i)).toBeNull();
    expect(screen.getByRole('dialog', { name: /finalidade do crédito/i })).toBe(dialog);
    expect(apiMock.deleteWithBody).not.toHaveBeenCalled();
  });

  it.each([
    ['200 alreadyUndone:false', { revision: 4, alreadyUndone: false }],
    ['200 alreadyUndone:true', { revision: 4, alreadyUndone: true }],
  ])('sucesso %s: sem aviso de dúvida, relê o estado e atualiza Conta/dono pelo helper existente', async (_label, result) => {
    queues[READ_FOREIGN] = [() => assignedState(3), () => PREPARE_STATE];
    apiMock.deleteWithBody.mockResolvedValueOnce(result);
    mount();
    await waitFor(() => expect(probeReads('anchor')).toBe(1));
    const dialog = await toUndoConfirmation();
    fireEvent.click(confirmUndo(dialog));
    await waitFor(() => expect(readsOf(READ_FOREIGN)).toBe(2));
    expect(await within(dialog).findByRole('button', { name: /verificar prévia/i })).toBeInTheDocument();
    expect(within(dialog).queryByText(LOST_UNDO)).toBeNull();
    await waitFor(() => expect(probeReads('anchor')).toBeGreaterThan(1));
    expect(probeReads('owner')).toBeGreaterThan(1);
  });

  describe.each(LOSSES)('resposta perdida (%s)', (_kind, makeError) => {
    it.each([
      ['a releitura devolve assignment null', () => PREPARE_STATE, /verificar prévia/i],
      ['a releitura devolve a mesma atribuição', () => assignedState(3), /desfazer finalidade/i],
      ['a releitura devolve outra revisão', () => assignedState(5), /desfazer finalidade/i],
    ])('incerto permanece incerto, sem sucesso inferido nem novo DELETE (%s)', async (_label, after, marker) => {
      queues[READ_FOREIGN] = [() => assignedState(3), after];
      apiMock.deleteWithBody.mockRejectedValueOnce(makeError());
      mount();
      const dialog = await toUndoConfirmation();
      fireEvent.click(confirmUndo(dialog));
      expect(await within(dialog).findByText(LOST_UNDO)).toBeInTheDocument();
      expect(dialog.textContent).not.toMatch(SUCCESS_WORDS);
      expect(dialog.textContent).not.toMatch(/não aparece mais para você/i);
      fireEvent.click(within(dialog).getByRole('button', { name: /consultar novamente/i }));
      // Marcador POSITIVO do estado relido antes de qualquer conclusão.
      expect(await within(dialog).findByRole('button', { name: marker })).toBeInTheDocument();
      expect(readsOf(READ_FOREIGN)).toBe(2);
      // Estado atual, não recibo: o aviso da tentativa perdida continua.
      expect(within(dialog).getByText(LOST_UNDO)).toBeInTheDocument();
      expect(dialog.textContent).not.toMatch(SUCCESS_WORDS);
      await settleFor(30);
      expect(apiMock.deleteWithBody).toHaveBeenCalledTimes(1);
      expect(purposePost).not.toHaveBeenCalled();
    });
  });

  it('após reler revisão 5, a NOVA confirmação envia 5 (nunca a revisão antiga) e não há reenvio automático', async () => {
    queues[READ_FOREIGN] = [() => assignedState(3), () => assignedState(5)];
    apiMock.deleteWithBody.mockRejectedValueOnce(new Error('Failed to fetch'));
    mount();
    const dialog = await toUndoConfirmation();
    fireEvent.click(confirmUndo(dialog));
    await within(dialog).findByText(LOST_UNDO);
    fireEvent.click(within(dialog).getByRole('button', { name: /consultar novamente/i }));
    fireEvent.click(await within(dialog).findByRole('button', { name: /desfazer finalidade/i }));
    await settleFor(30);
    expect(apiMock.deleteWithBody).toHaveBeenCalledTimes(1);
    fireEvent.click(confirmUndo(dialog));
    await waitFor(() => expect(apiMock.deleteWithBody).toHaveBeenCalledTimes(2));
    expect(apiMock.deleteWithBody).toHaveBeenLastCalledWith(READ_FOREIGN, { expectedRevision: 5 });
  });
});

describe('F7 — apply com resposta perdida', () => {
  async function lostApply(error: unknown, reread: () => unknown) {
    queues[READ_FOREIGN] = [() => PREPARE_STATE, reread];
    purposePost.mockImplementation(async (_p: string, body: { mode: string }) => {
      if (body.mode === 'preview') return previewBody();
      throw error;
    });
    mount();
    const dialog = await toPreview();
    fireEvent.click(await confirmBtn(dialog));
    expect(await within(dialog).findByText(LOST_APPLY)).toBeInTheDocument();
    expect(queryBtn(dialog, /confirmar finalidade/i)).toBeNull();
    await settleFor(30);
    expect(purposePost).toHaveBeenCalledTimes(2);
    return dialog;
  }

  it.each(LOSSES)('%s: mensagem própria, Consultar novamente disponível, sem POST automático', async (_kind, makeError) => {
    const dialog = await lostApply(makeError(), () => PREPARE_STATE);
    expect(within(dialog).getByRole('button', { name: /consultar novamente/i })).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(SUCCESS_WORDS);
  });

  it('releitura null: exige NOVA prévia (fingerprint atual), mantém o aviso e nunca reusa o fingerprint antigo', async () => {
    const dialog = await lostApply(new Error('Failed to fetch'), () => PREPARE_STATE);
    fireEvent.click(within(dialog).getByRole('button', { name: /consultar novamente/i }));
    await within(dialog).findByRole('button', { name: /verificar prévia/i });
    expect(within(dialog).getByText(LOST_APPLY)).toBeInTheDocument();
    expect(queryBtn(dialog, /confirmar finalidade/i)).toBeNull();
    expect(purposePost).toHaveBeenCalledTimes(2);

    purposePost.mockImplementation(async (_p: string, body: { mode: string }) => (body.mode === 'preview' ? previewBody(FP2) : appliedBody({ fingerprint: FP2 })));
    const select = within(dialog).getByLabelText(/^projeto/i);
    await waitFor(() => expect(optionValues(select)).toContain('proj-a'));
    fireEvent.change(select, { target: { value: 'proj-a' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /verificar prévia/i }));
    fireEvent.click(await confirmBtn(dialog));
    await waitFor(() => expect(purposePost).toHaveBeenCalledTimes(4));
    expect(purposePost).toHaveBeenLastCalledWith(READ_FOREIGN, expect.objectContaining({ mode: 'apply', expectedFingerprint: FP2 }));
  });

  it('releitura com atribuição presente é ESTADO ATUAL, não conclusão da tentativa', async () => {
    const dialog = await lostApply(httpError(502, 'Bad Gateway'), () => assignedState(1));
    fireEvent.click(within(dialog).getByRole('button', { name: /consultar novamente/i }));
    await within(dialog).findByRole('button', { name: /desfazer finalidade/i });
    expect(within(dialog).getByText(LOST_APPLY)).toBeInTheDocument();
    expect(dialog.textContent).not.toMatch(SUCCESS_WORDS);
    expect(purposePost).toHaveBeenCalledTimes(2);
  });
});

describe('sessão e orçamento de leitura', () => {
  it('troca de sessão: nada da finalidade do ator anterior é visível para o outro, e a consulta é a do contexto atual', async () => {
    const client = newClient();
    queues[READ_FOREIGN] = [() => assignedState(3)];
    mount([foreignCredit()], client);
    let dialog = await openPurpose();
    await within(dialog).findByRole('button', { name: /desfazer finalidade/i });
    expect(dialog.textContent).toMatch(NEGATIVE_MONEY);
    cleanup();

    // Outro ator no MESMO cache do navegador; a leitura dele fica retida.
    me = { ...AUTH_USER, id: 'user-2', username: 'joao', name: 'João' };
    const held = deferred<unknown>();
    queues[READ_FOREIGN] = [() => held.promise];
    mount([foreignCredit()], client);
    dialog = await openPurpose();
    expect(await within(dialog).findByText(/consultando finalidade/i)).toBeInTheDocument();
    expect(queryBtn(dialog, /desfazer finalidade|verificar prévia/i)).toBeNull();
    expect(dialog.textContent).not.toMatch(NEGATIVE_MONEY);
    held.resolve(PREPARE_STATE);
    expect(await within(dialog).findByRole('button', { name: /verificar prévia/i })).toBeInTheDocument();
    expect(queryBtn(dialog, /desfazer finalidade/i)).toBeNull();
    expect(readsOf(READ_FOREIGN)).toBe(2);
  });

  it('as duas entradas montadas juntas: zero GET de finalidade; abrir faz um; fechar e reabrir consulta de novo', async () => {
    apiMock.get.mockImplementation(async (path: string) => {
      if (path === '/auth/me') return me;
      if (path === '/projects') return PROJECT_CATALOG;
      if (path === ROOT_FOREIGN) return CREDIT_FORM;
      if (queues[path]) return nextOf(path);
      return [];
    });
    mount([foreignCredit()], newClient(), true);
    const formEntry = await screen.findByRole('button', { name: /finalidade do crédito/i });
    const d = await openDetail();
    const detailEntry = await purposeEntry(d);
    await settleFor(30);
    expect(readsOf(READ_FOREIGN)).toBe(0);
    expect(formEntry).not.toBe(detailEntry);

    fireEvent.click(formEntry);
    let dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    await within(dialog).findByRole('button', { name: /verificar prévia/i });
    expect(readsOf(READ_FOREIGN)).toBe(1);
    fireEvent.click(within(dialog).getByRole('button', { name: /^fechar$/i }));
    await settleFor(30);
    expect(readsOf(READ_FOREIGN)).toBe(1);

    fireEvent.click(detailEntry);
    dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    await within(dialog).findByRole('button', { name: /verificar prévia/i });
    expect(readsOf(READ_FOREIGN)).toBe(2);
  });
});

describe('raiz sem prova de crédito e identidade estável durante o fluxo', () => {
  const noFlag = () => foreignCredit({ expenseIsCredit: undefined });

  it.each([
    ['leitura da raiz ainda em curso', () => new Promise(() => undefined)],
    ['leitura da raiz falhou', () => Promise.reject(httpError(503))],
  ])('desconhecido não oferece a entrada: %s', async (_label, root) => {
    queues[ROOT_FOREIGN] = [root as () => unknown];
    mount([noFlag()]);
    const d = await openDetail();
    await waitFor(() => expect(readsOf(ROOT_FOREIGN)).toBe(1));
    await settleFor(30);
    expect(d.queryByRole('button', { name: /finalidade do crédito/i })).toBeNull();
    expect(getPaths().filter((p) => p.includes('refund-purpose'))).toEqual([]);
  });

  it('a releitura da raiz disparada pela confirmação não fecha o diálogo nem some com o resultado', async () => {
    const heldRoot = deferred<unknown>();
    const root = { id: 'credit', valorTotal: -12_345_678, canDelete: false };
    queues[ROOT_FOREIGN] = [() => root, () => heldRoot.promise];
    queues[READ_FOREIGN] = [() => PREPARE_STATE, () => assignedState(1)];
    purposePost.mockImplementation(async (_p: string, body: { mode: string }) => (body.mode === 'preview' ? previewBody() : appliedBody()));
    mount([noFlag()]);
    await screen.findByText('Crédito importado');
    fireEvent.focus(detailButtonOf('Crédito importado'));
    await waitFor(() => expect(readsOf(ROOT_FOREIGN)).toBe(1));
    const dialog = await toPreview();
    fireEvent.click(await confirmBtn(dialog));
    await waitFor(() => expect(readsOf(ROOT_FOREIGN)).toBe(2)); // raiz recarregando: prova temporariamente ausente
    expect(await within(dialog).findByRole('button', { name: /^concluir$/i })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: /finalidade do crédito/i })).toBe(dialog);
    heldRoot.resolve(root);
    await tick();
    expect(within(dialog).getByRole('button', { name: /^concluir$/i })).toBeInTheDocument();
  });
});

/**
 * #704 — catálogo REAL: `GET /projects` (lista) não traz `rooms`; os ambientes e o nome do destino de
 * um assignment vêm de `GET /projects/:id` do destino ABERTO/SELECIONADO, só com o diálogo aberto.
 * Orçamento: GET de finalidade = 1 por abertura ativa e 0 por linha; GET de detalhe é separado
 * (0 na abertura em PREPARE, 1 por destino selecionado, 1 por abertura com assignment visível).
 */
const DEST = /^projeto de destino$/i;
const AMB = /^ambiente$/i;
const RETRY = /recarregar/i;
const A_DETAIL = detailPath('proj-a');
const without = (obj: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
const roomOf = (dialog: HTMLElement) => within(dialog).queryByLabelText(/ambiente/i);
const optionTexts = (select: HTMLElement) => Array.from((select as HTMLSelectElement).options).map((o) => o.textContent);
const NEUTRAL_ONLY = /prisma|failed to fetch|invocation/i;

async function pickDestination(dialog: HTMLElement, id: string) {
  const select = await selectOf(dialog);
  await waitFor(() => expect(optionValues(select)).toContain(id));
  fireEvent.change(select, { target: { value: id } });
}
/** Sem ação possível: prévia e ambiente ausentes ou desabilitados; nunca "Sem ambiente" como padrão silencioso. */
function expectNotActionable(dialog: HTMLElement) {
  const verify = queryBtn(dialog, /verificar prévia/i);
  expect(verify === null || verify.hasAttribute('disabled')).toBe(true);
  const room = roomOf(dialog);
  expect(room === null || room.hasAttribute('disabled')).toBe(true);
}
async function openAssigned(over: Partial<RefundPurposeSummary> = {}, actions: RefundPurposeAction[] = [], read = () => assignedState(3, over, actions) as unknown) {
  queues[READ_FOREIGN] = [read];
  mount();
  const dialog = await openPurpose();
  await afterLoad(dialog);
  return dialog;
}
const factsPresent = (dialog: HTMLElement) => {
  expect(pairText(dialog, /data da compra/i)).toContain(SHOWN.compra);
  expect(dialog.textContent).toMatch(NEGATIVE_MONEY);
};

const ROOM_A = PROJECT_DETAILS['proj-a'].rooms[2];
const FAILURES: Array<[string, () => unknown]> = [
  ['403', () => Promise.reject(httpError(403, SENTINEL))],
  ['404', () => Promise.reject(httpError(404, SENTINEL))],
  ['503', () => Promise.reject(httpError(503, SENTINEL))],
  ['falha de rede', () => Promise.reject(new Error('Failed to fetch'))],
];
const MALFORMED: Array<[string, () => unknown]> = [
  ['rooms ausente', () => without(PROJECT_DETAILS['proj-a'], 'rooms')],
  ['rooms objeto', () => ({ ...PROJECT_DETAILS['proj-a'], rooms: {} })],
  ['rooms null', () => ({ ...PROJECT_DETAILS['proj-a'], rooms: null })],
  ['room sem deletedAt', () => ({ ...PROJECT_DETAILS['proj-a'], rooms: [without(ROOM_A, 'deletedAt')] })],
  ['room sem id', () => ({ ...PROJECT_DETAILS['proj-a'], rooms: [without(ROOM_A, 'id')] })],
  ['room sem name', () => ({ ...PROJECT_DETAILS['proj-a'], rooms: [without(ROOM_A, 'name')] })],
  ['id de OUTRO projeto no corpo', () => PROJECT_DETAILS['proj-b']],
  ['corpo é lista', () => []],
  ['corpo nulo', () => null],
];

describe('F3b — PREPARE: ambientes do detalhe do destino selecionado', () => {
  beforeEach(() => {
    purposePost.mockImplementation(async (_path: string, body: { mode: string }) => (body.mode === 'preview' ? previewBody() : appliedBody()));
  });

  it('a lista real de projetos não traz `rooms` (fixture nativa) e o detalhe traz ativo e apagado', () => {
    expect(PROJECT_CATALOG.some((p) => 'rooms' in p)).toBe(false);
    expect(PROJECT_DETAILS['proj-a'].rooms.map((r) => r.deletedAt !== null)).toEqual([false, true, false]);
  });

  it('zero GET de detalhe ao abrir; ao selecionar o destino, UM GET dele; opções = só ambientes ATIVOS na ordem recebida; body leva o roomId escolhido', async () => {
    mount();
    const dialog = await openPurpose();
    await pickDestinationReady(dialog);
    expect(detailGets()).toEqual([]);
    await pickDestination(dialog, 'proj-a');
    const room = await within(dialog).findByLabelText(/ambiente/i);
    await waitFor(() => expect(optionValues(room)).toEqual(['room-a2', ROOM_ACTIVE]));
    expect(optionTexts(room)).toEqual(['Sem ambiente', 'Sala de estar', 'Cozinha']);
    expect(dialog.textContent).not.toContain('Cozinha antiga');
    expect(detailGets()).toEqual([A_DETAIL]);
    fireEvent.change(room, { target: { value: ROOM_ACTIVE } });
    fireEvent.click(within(dialog).getByRole('button', { name: /verificar prévia/i }));
    await confirmBtn(dialog);
    expect(purposePost).toHaveBeenCalledTimes(1);
    expect(purposePost).toHaveBeenCalledWith(READ_FOREIGN, previewBodyOf('proj-a', ROOM_ACTIVE));
  });

  it('controle: destino legitimamente sem ambientes (rooms []) não é erro; só "Sem ambiente" e roomId null', async () => {
    mount();
    const dialog = await openPurpose();
    await pickDestination(dialog, 'proj-c');
    await waitFor(() => expect(detailGets()).toEqual([detailPath('proj-c')]));
    const room = await within(dialog).findByLabelText(/ambiente/i);
    await waitFor(() => expect(optionTexts(room)).toEqual(['Sem ambiente']));
    expect(within(dialog).queryByRole('alert')).toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: /verificar prévia/i }));
    await confirmBtn(dialog);
    expect(purposePost).toHaveBeenCalledWith(READ_FOREIGN, previewBodyOf('proj-c', null));
  });

  it('carregando: marcador positivo, prévia e ambiente indisponíveis, nenhuma escrita; ao chegar libera', async () => {
    const held = deferred<unknown>();
    detailQueues[A_DETAIL] = [() => held.promise];
    mount();
    const dialog = await openPurpose();
    await pickDestination(dialog, 'proj-a');
    expect(await within(dialog).findByText(/carregando ambientes/i)).toBeInTheDocument();
    expectNotActionable(dialog);
    const verify = queryBtn(dialog, /verificar prévia/i);
    if (verify) fireEvent.click(verify);
    expect(purposePost).not.toHaveBeenCalled();
    held.resolve(PROJECT_DETAILS['proj-a']);
    await waitFor(() => expect(optionValues(within(dialog).getByLabelText(/ambiente/i))).toEqual(['room-a2', ROOM_ACTIVE]));
    expect(within(dialog).getByRole('button', { name: /verificar prévia/i })).toBeEnabled();
    expect(within(dialog).queryByText(/carregando ambientes/i)).toBeNull();
  });

  it.each([...FAILURES, ...MALFORMED])('detalhe inválido (%s): aviso neutro visível, sem ambientes, sem prévia, sem silêncio nem padrão "Sem ambiente"; retry visível', async (_label, response) => {
    detailQueues[A_DETAIL] = [response];
    mount();
    const dialog = await openPurpose();
    await pickDestination(dialog, 'proj-a');
    const alert = await within(dialog).findByRole('alert');
    expect(alert.textContent?.trim()).not.toBe('');
    expect(dialog.textContent).not.toContain(SENTINEL);
    expect(dialog.textContent).not.toMatch(NEUTRAL_ONLY);
    expect(dialog.textContent).not.toMatch(/\bSala\b|Sala de estar|Cozinha/);
    expectNotActionable(dialog);
    expect(within(dialog).getByRole('button', { name: RETRY })).toBeInTheDocument();
    expect(purposePost).not.toHaveBeenCalled();
  });

  it.each(FAILURES.slice(0, 3))('retry após %s: nova consulta SÓ do detalhe (a leitura de finalidade não repete); ambientes aparecem e o aviso some', async (_label, failure) => {
    detailQueues[A_DETAIL] = [failure, () => PROJECT_DETAILS['proj-a']];
    mount();
    const dialog = await openPurpose();
    await pickDestination(dialog, 'proj-a');
    fireEvent.click(await within(dialog).findByRole('button', { name: RETRY }));
    await waitFor(() => expect(optionValues(within(dialog).getByLabelText(/ambiente/i))).toEqual(['room-a2', ROOM_ACTIVE]));
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(detailGets()).toEqual([A_DETAIL, A_DETAIL]);
    expect(readsOf(READ_FOREIGN)).toBe(1);
  });

  it('resposta tardia de A depois de escolher B nunca serve ambientes nem corpo de A a B', async () => {
    const heldA = deferred<unknown>();
    detailQueues[A_DETAIL] = [() => heldA.promise];
    mount();
    const dialog = await openPurpose();
    await pickDestination(dialog, 'proj-a');
    await waitFor(() => expect(detailGets()).toEqual([A_DETAIL]));
    await pickDestination(dialog, 'proj-b');
    await waitFor(() => expect(optionValues(within(dialog).getByLabelText(/ambiente/i))).toEqual(['room-b1']));
    heldA.resolve(PROJECT_DETAILS['proj-a']);
    await tick();
    await tick();
    expect(optionValues(within(dialog).getByLabelText(/ambiente/i))).toEqual(['room-b1']);
    expect(dialog.textContent).not.toMatch(/Sala de estar|Cozinha/);
    fireEvent.change(within(dialog).getByLabelText(/ambiente/i), { target: { value: 'room-b1' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /verificar prévia/i }));
    await confirmBtn(dialog);
    expect(purposePost).toHaveBeenCalledWith(READ_FOREIGN, previewBodyOf('proj-b', 'room-b1'));
  });

  it('trocar de projeto com o detalhe do novo ainda em curso: ambientes do anterior somem, prévia indisponível, roomId zerado', async () => {
    const heldB = deferred<unknown>();
    detailQueues[detailPath('proj-b')] = [() => heldB.promise];
    mount();
    const dialog = await openPurpose();
    await pickDestination(dialog, 'proj-a');
    const roomA = await within(dialog).findByLabelText(/ambiente/i);
    await waitFor(() => expect(optionValues(roomA)).toContain(ROOM_ACTIVE));
    fireEvent.change(roomA, { target: { value: ROOM_ACTIVE } });
    await pickDestination(dialog, 'proj-b');
    const during = roomOf(dialog);
    if (during) {
      expect(optionValues(during)).not.toContain(ROOM_ACTIVE);
      expect(during).not.toHaveValue(ROOM_ACTIVE);
    }
    expectNotActionable(dialog);
    heldB.resolve(PROJECT_DETAILS['proj-b']);
    await waitFor(() => expect(optionValues(within(dialog).getByLabelText(/ambiente/i))).toEqual(['room-b1']));
    expect(within(dialog).getByLabelText(/ambiente/i)).toHaveDisplayValue(/sem ambiente/i);
  });

  it('a prévia mostra destino e ambiente ESCOLHIDOS (nome do detalhe), não linhas omitidas', async () => {
    purposePost.mockImplementation(async (_p: string, body: { mode: string }) => (body.mode === 'preview' ? previewBody(FP1, { roomId: ROOM_ACTIVE }) : appliedBody()));
    mount();
    const dialog = await toPreview('proj-a', ROOM_ACTIVE);
    await confirmBtn(dialog);
    expect(pairText(dialog, DEST)).toContain('Reforma A');
    expect(pairText(dialog, AMB)).toContain('Cozinha');
  });

  it('orçamento: fechar e reabrir não herda ambientes; novo GET de finalidade e, só ao selecionar, novo GET de detalhe', async () => {
    mount();
    let dialog = await openPurpose();
    await pickDestination(dialog, 'proj-a');
    await waitFor(() => expect(optionValues(within(dialog).getByLabelText(/ambiente/i))).toContain(ROOM_ACTIVE));
    expect(detailGets()).toEqual([A_DETAIL]);
    fireEvent.click(within(dialog).getByRole('button', { name: /^fechar$/i }));
    fireEvent.click(await purposeEntry(within(detail())));
    dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    await selectOf(dialog);
    await settleFor(30);
    expect(readsOf(READ_FOREIGN)).toBe(2);
    expect(detailGets()).toEqual([A_DETAIL]);
    expect(roomOf(dialog)?.hasAttribute('disabled') ?? true).toBe(true);
    await pickDestination(dialog, 'proj-a');
    await waitFor(() => expect(detailGets()).toEqual([A_DETAIL, A_DETAIL]));
  });

  it('foco da janela e reconexão não refazem leitura, catálogo nem detalhe, nem descartam o ambiente escolhido durante a edição', async () => {
    mount();
    const dialog = await openPurpose();
    await pickDestination(dialog, 'proj-a');
    const room = await within(dialog).findByLabelText(/ambiente/i);
    await waitFor(() => expect(optionValues(room)).toContain(ROOM_ACTIVE));
    fireEvent.change(room, { target: { value: ROOM_ACTIVE } });
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    onlineManager.setOnline(false);
    onlineManager.setOnline(true);
    await settleFor(30);
    expect(detailGets()).toEqual([A_DETAIL]);
    expect(readsOf(READ_FOREIGN)).toBe(1);
    expect(readsOf('/projects')).toBe(1); // o catálogo também não se refaz sozinho durante a edição
    expect(within(dialog).getByLabelText(/ambiente/i)).toHaveValue(ROOM_ACTIVE);
  });
});

async function pickDestinationReady(dialog: HTMLElement) {
  const select = await selectOf(dialog);
  await waitFor(() => expect(optionValues(select)).toContain('proj-a'));
}

describe('F2b — assignment: destino e ambiente sempre presentes, lidos do detalhe do destino', () => {
  const CASES: Array<[string, string | null, string]> = [
    ['ambiente ativo', ROOM_ACTIVE, 'Cozinha'],
    ['roomId null', null, 'Sem ambiente'],
    ['roomId ausente no detalhe', 'room-zzz', 'Ambiente indisponível'],
    ['ambiente soft-deleted', ROOM_DELETED, 'Ambiente indisponível'],
  ];
  const ACTIONS: Array<[string, RefundPurposeAction[]]> = [
    ['actions []', []],
    ['actions [UNDO]', ['UNDO']],
  ];

  describe.each(ACTIONS)('%s', (_actionsLabel, actions) => {
    it.each(CASES)('%s', async (_label, roomId, expected) => {
      const dialog = await openAssigned({ roomId }, actions);
      await waitFor(() => expect(pairText(dialog, AMB)).toContain(expected));
      expect(pairText(dialog, DEST)).toContain('Reforma A');
      const ambiente = pairText(dialog, AMB);
      for (const leaked of ['room-zzz', ROOM_DELETED, 'Cozinha antiga']) expect(ambiente).not.toContain(leaked);
      if (expected === 'Ambiente indisponível') expect(ambiente).not.toMatch(/Cozinha|Sem ambiente/);
      factsPresent(dialog);
      expect(detailGets()).toEqual([A_DETAIL]);
      expect(readsOf(READ_FOREIGN)).toBe(1);
      // As ações vêm só do servidor; nome/ambiente não criam nem removem verbo.
      expect(queryBtn(dialog, /desfazer finalidade/i) !== null).toBe(actions.includes('UNDO'));
      expect(queryBtn(dialog, /verificar prévia|confirmar|aplicar/i)).toBeNull();
    });
  });

  it('projeto de destino sem capacidade `expenses` (PLANTAS) continua nomeado: o assignment persistido não é ocultado por capacidade', async () => {
    const dialog = await openAssigned({ targetProjectId: 'proj-plantas', roomId: null }, []);
    await waitFor(() => expect(pairText(dialog, DEST)).toContain('Plantas'));
    expect(pairText(dialog, AMB)).toContain('Sem ambiente');
    expect(detailGets()).toEqual([detailPath('proj-plantas')]);
  });

  it('o catálogo `/projects` falhar não apaga destino/ambiente do assignment (o resumo não depende dele)', async () => {
    catalogFails = true;
    const dialog = await openAssigned({ roomId: ROOM_ACTIVE }, ['UNDO']);
    await waitFor(() => expect(pairText(dialog, AMB)).toContain('Cozinha'));
    expect(pairText(dialog, DEST)).toContain('Reforma A');
    expect(queryBtn(dialog, /desfazer finalidade/i)).not.toBeNull();
  });

  it('carregando: linha de ambiente presente com marcador de carregamento (sem padrão), fatos e UNDO intactos; depois resolve', async () => {
    const held = deferred<unknown>();
    detailQueues[A_DETAIL] = [() => held.promise];
    const dialog = await openAssigned({ roomId: ROOM_ACTIVE }, ['UNDO']);
    await waitFor(() => expect(pairText(dialog, AMB)).toMatch(/carregando/i));
    expect(pairText(dialog, AMB)).not.toMatch(/sem ambiente|indispon/i);
    factsPresent(dialog);
    expect(queryBtn(dialog, /desfazer finalidade/i)).not.toBeNull();
    held.resolve(PROJECT_DETAILS['proj-a']);
    await waitFor(() => expect(pairText(dialog, AMB)).toContain('Cozinha'));
    expect(pairText(dialog, DEST)).toContain('Reforma A');
  });

  it.each([...FAILURES, ...MALFORMED])('detalhe inválido (%s): linhas presentes com erro explícito, distinto de carregando e de "Ambiente indisponível"; fatos e UNDO intactos; sem verbo novo', async (_label, response) => {
    detailQueues[A_DETAIL] = [response];
    const dialog = await openAssigned({ roomId: ROOM_ACTIVE }, ['UNDO']);
    await waitFor(() => expect(pairText(dialog, AMB)).toMatch(/não foi possível/i));
    expect(pairText(dialog, AMB)).not.toMatch(/carregando|ambiente indisponível/i);
    expect(pairText(dialog, DEST)).toMatch(/não foi possível/i);
    expect(dialog.textContent).not.toContain(SENTINEL);
    expect(dialog.textContent).not.toMatch(NEUTRAL_ONLY);
    factsPresent(dialog);
    expect(queryBtn(dialog, /desfazer finalidade/i)).not.toBeNull();
    expect(queryBtn(dialog, /verificar prévia|confirmar|aplicar/i)).toBeNull();
    expect(within(dialog).getByRole('button', { name: RETRY })).toBeInTheDocument();
    expect(apiMock.deleteWithBody).not.toHaveBeenCalled();
  });

  it('retry do detalhe em UNDO: só o detalhe é consultado de novo (finalidade 1 GET), e os nomes aparecem', async () => {
    detailQueues[A_DETAIL] = [() => Promise.reject(httpError(503, SENTINEL)), () => PROJECT_DETAILS['proj-a']];
    const dialog = await openAssigned({ roomId: ROOM_ACTIVE }, ['UNDO']);
    fireEvent.click(await within(dialog).findByRole('button', { name: RETRY }));
    await waitFor(() => expect(pairText(dialog, AMB)).toContain('Cozinha'));
    expect(detailGets()).toEqual([A_DETAIL, A_DETAIL]);
    expect(readsOf(READ_FOREIGN)).toBe(1);
    expect(queryBtn(dialog, /desfazer finalidade/i)).not.toBeNull();
  });

  it('resposta tardia do destino de A (crédito A) nunca serve nomes ao diálogo do crédito B', async () => {
    const READ_B = `/projects/${OWNER}/expenses/credit-b/refund-purpose`;
    const heldA = deferred<unknown>();
    detailQueues[A_DETAIL] = [() => heldA.promise];
    queues[READ_FOREIGN] = [() => assignedState(3, { roomId: ROOM_ACTIVE }, ['UNDO'])];
    queues[READ_B] = [() => ({ ...assignedState(3, { targetProjectId: 'proj-b', roomId: 'room-b1', sourceExpenseId: 'credit-b' }, ['UNDO']), sourceExpenseId: 'credit-b' })];
    mount([
      foreignCredit({ descricao: 'Crédito A' }),
      foreignCredit({ id: 'credit-b#1', foreignExpenseId: 'credit-b', descricao: 'Crédito B' }),
    ]);
    const dialogA = await openPurpose('Crédito A');
    await afterLoad(dialogA);
    await waitFor(() => expect(pairText(dialogA, AMB)).toMatch(/carregando/i));
    fireEvent.click(within(dialogA).getByRole('button', { name: /^fechar$/i }));
    fireEvent.click(within(detail()).getByRole('button', { name: /^fechar$/i }));

    const dialogB = await openPurpose('Crédito B');
    await afterLoad(dialogB);
    await waitFor(() => expect(pairText(dialogB, AMB)).toContain('Sala'));
    expect(pairText(dialogB, DEST)).toContain('Reforma B');
    heldA.resolve(PROJECT_DETAILS['proj-a']);
    await tick();
    await tick();
    expect(pairText(dialogB, AMB)).toContain('Sala');
    expect(pairText(dialogB, AMB)).not.toContain('Cozinha');
    expect(pairText(dialogB, DEST)).not.toContain('Reforma A');
  });

  it('troca de sessão: o outro ator não vê o destino/ambiente lidos para o anterior e a consulta de detalhe é dele', async () => {
    const client = newClient();
    queues[READ_FOREIGN] = [() => assignedState(3, { roomId: ROOM_ACTIVE }, ['UNDO'])];
    mount([foreignCredit()], client);
    let dialog = await openPurpose();
    await afterLoad(dialog);
    await waitFor(() => expect(pairText(dialog, AMB)).toContain('Cozinha'));
    cleanup();

    me = { ...AUTH_USER, id: 'user-2', username: 'joao', name: 'João' };
    const held = deferred<unknown>();
    detailQueues[A_DETAIL] = [() => held.promise];
    mount([foreignCredit()], client);
    dialog = await openPurpose();
    await afterLoad(dialog);
    await waitFor(() => expect(pairText(dialog, AMB)).toMatch(/carregando/i));
    expect(dialog.textContent).not.toMatch(/Cozinha|Reforma A/);
    expect(detailGets()).toEqual([A_DETAIL, A_DETAIL]);
    held.resolve(PROJECT_DETAILS['proj-a']);
    await waitFor(() => expect(pairText(dialog, AMB)).toContain('Cozinha'));
  });
});

describe('F1b — orçamento de detalhe fora do diálogo', () => {
  it('finalidade já atribuída (sem PREPARE): o catálogo /projects não é consultado; só o detalhe do destino', async () => {
    queues[READ_FOREIGN] = [() => assignedState(3, { roomId: ROOM_ACTIVE }, ['UNDO'])];
    mount([foreignCredit()]);
    const dialog = await openPurpose();
    await afterLoad(dialog);
    await waitFor(() => expect(pairText(dialog, AMB)).toContain('Cozinha'));
    expect(readsOf('/projects')).toBe(0);
    expect(detailGets()).toEqual([A_DETAIL]);
  });

  it('lista e detalhe do lançamento (várias linhas) fazem zero GET de finalidade e zero GET de detalhe de projeto', async () => {
    mount([
      foreignCredit({ descricao: 'Crédito A' }),
      foreignCredit({ id: 'credit-b#1', foreignExpenseId: 'credit-b', descricao: 'Crédito B' }),
      credit({ descricao: 'Crédito próprio' }),
    ]);
    const d = await openDetail('Crédito A');
    await purposeEntry(d);
    await settleFor(30);
    expect(getPaths().filter((p) => p.includes('refund-purpose'))).toEqual([]);
    expect(detailGets()).toEqual([]);
  });
});

// ── Detalhe do crédito vindo de `comprasCartao` (status é o da FATURA, não o do crédito) ─────────
const INVOICE_HELP = 'Este status acompanha a quitação da fatura, não o status do crédito importado. Atribuir finalidade não quita a fatura.';
// Forma do produtor real de `comprasCartao` (monthly-overview): PLANEJADO enquanto a fatura não é paga.
const cardCredit = (overrides: Partial<AccountViewSaida> = {}) =>
  credit({ realizado: false, status: 'PLANEJADO', dueMonth: '2026-06', ...overrides });
// Origem por cartão (filtro do cartão): as compras da fatura viram linhas da lista, com detalhe.
const CARD_VIEW = {
  originFilter: '1234',
  cartoes: [
    {
      nickname: 'Cartão 1234', last4: '1234', faturaAtual: 0, faturaPendente: 0, faturaPaga: 0, residualDeclarado: 0,
      possuiIntervencaoManual: false, ajusteManualTotal: 0, dueMonth: '2026-06', vencimento: '2026-06-10', status: 'a pagar' as const,
      limiteUsadoPct: null, limiteUsado: null, limiteTotal: null,
    },
  ],
};
const ROOT_PAGO = () => ({ id: 'credit-own', valorTotal: -12_345_678, status: 'PAGO', canDelete: false });

/** Valor (`dd`) do termo (`dt`) de rótulo EXATO: o primeiro `dd` depois do `dt` e antes do próximo `dt`. */
function termValue(scope: HTMLElement, label: string): string | null {
  const terms = Array.from(scope.querySelectorAll('dt')).filter((el) => el.textContent?.trim() === label);
  if (terms.length === 0) return null;
  if (terms.length > 1) throw new Error(`rótulo "${label}" repetido`);
  const all = Array.from(scope.querySelectorAll('dt, dd'));
  const next = all[all.indexOf(terms[0]) + 1];
  if (next?.tagName !== 'DD') throw new Error(`termo "${label}" sem definição`);
  return next.textContent?.trim() ?? '';
}
/** A ajuda pertence ao termo de status: o menor ancestral comum a ambos não contém outro termo. */
function helpBelongsToStatus(scope: HTMLElement) {
  const term = Array.from(scope.querySelectorAll('dt')).find((el) => el.textContent?.trim() === 'Situação na fatura')!;
  const help = within(scope).getByText(INVOICE_HELP);
  let common: Element | null = term;
  while (common && !common.contains(help)) common = common.parentElement;
  expect(common).not.toBeNull();
  expect(common!.querySelectorAll('dt')).toHaveLength(1);
  expect(help.closest('[aria-hidden="true"]')).toBeNull();
}
const noWrites = () => {
  expect(apiMock.patch).not.toHaveBeenCalled();
  expect(apiMock.put).not.toHaveBeenCalled();
  expect(apiMock.delete).not.toHaveBeenCalled();
  expect(purposePost).not.toHaveBeenCalled();
};

describe('G — detalhe do crédito de compra no cartão: "Situação na fatura" e "Categoria"', () => {
  beforeEach(() => {
    queues[READ_OWN] = [() => PREPARE_STATE];
    queues[ROOT_OWN] = [ROOT_PAGO];
  });

  it('crédito de comprasCartao PLANEJADO com a despesa raiz PAGO: rótulo "Situação na fatura", valor Planejado, ajuda visível, sem "Status"', async () => {
    mount([], newClient(), false, [cardCredit()], CARD_VIEW);
    const d = await openDetail();
    const scope = detail();
    await purposeEntry(d); // marcador positivo do contexto de crédito resolvido
    expect(termValue(scope, 'Situação na fatura')).toBe('Planejado');
    expect(termValue(scope, 'Status')).toBeNull();
    helpBelongsToStatus(scope);
    expect(termValue(scope, 'Categoria')).toBe('Outros');
    expect(termValue(scope, 'Finalidade')).toBeNull();
    expect(scope.textContent).not.toMatch(/Pago\b/); // o PAGO da raiz nunca substitui o da fatura
    noWrites();
  });

  it('a mesma linha ausente da flag: a raiz prova o crédito e o contexto do detalhe é o mesmo (proveniência não depende da raiz)', async () => {
    mount([], newClient(), false, [cardCredit({ expenseIsCredit: undefined })], CARD_VIEW);
    const d = await openDetail();
    await purposeEntry(d);
    const scope = detail();
    expect(termValue(scope, 'Situação na fatura')).toBe('Planejado');
    expect(termValue(scope, 'Categoria')).toBe('Outros');
    expect(termValue(scope, 'Status')).toBeNull();
    expect(termValue(scope, 'Finalidade')).toBeNull();
    helpBelongsToStatus(scope);
    expect(readsOf(ROOT_OWN)).toBe(1);
  });

  it('refetch da Conta (novas referências), fechar/reabrir e voltar da finalidade mantêm o contexto, sem escrita', async () => {
    const view = mount([], newClient(), false, [cardCredit()], CARD_VIEW);
    const d = await openDetail();
    await purposeEntry(d);
    view.rerenderWith([], [cardCredit()]);
    await tick();
    expect(termValue(detail(), 'Situação na fatura')).toBe('Planejado');

    const dialogEntry = await purposeEntry(within(detail()));
    fireEvent.click(dialogEntry);
    const dialog = await screen.findByRole('dialog', { name: /finalidade do crédito/i });
    await afterLoad(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: /fechar/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /finalidade do crédito/i })).toBeNull());
    expect(termValue(detail(), 'Situação na fatura')).toBe('Planejado');
    helpBelongsToStatus(detail());

    fireEvent.click(within(detail()).getByRole('button', { name: /^fechar$/i }));
    await waitFor(() => expect(screen.queryByTestId('financial-detail-sheet')).toBeNull());
    await openDetail();
    expect(termValue(detail(), 'Situação na fatura')).toBe('Planejado');
    expect(termValue(detail(), 'Categoria')).toBe('Outros');
    noWrites();
  });

  it('mesma proveniência pela fatura expandida (sem filtro de cartão): a compra aninhada abre o detalhe com o mesmo contexto', async () => {
    const invoice = credit({ id: 'inv-1', descricao: 'Fatura Cartão 1234', valor: 500_000, expenseIsCredit: undefined, isInvoice: true, realizado: false, status: 'PLANEJADO', dueMonth: '2026-06' });
    mount([invoice], newClient(), false, [cardCredit()]);
    fireEvent.click(await screen.findByTitle('Ver compras da fatura'));
    const d = await openDetail();
    await purposeEntry(d);
    const scope = detail();
    expect(termValue(scope, 'Situação na fatura')).toBe('Planejado');
    expect(termValue(scope, 'Categoria')).toBe('Outros');
    helpBelongsToStatus(scope);
  });

  it('deep-link (initialItemId) de um crédito que já está em comprasCartao, sem clique: mesmo contexto, com a raiz PAGO e a projeção PLANEJADO', async () => {
    mount([], newClient(), false, [cardCredit()], { initialItemId: 'credit-own' });
    const sheet = await screen.findByTestId('financial-detail-sheet');
    await purposeEntry(within(sheet)); // marcador positivo: detalhe aberto pelo deep-link com o crédito provado
    expect(termValue(sheet, 'Situação na fatura')).toBe('Planejado');
    expect(termValue(sheet, 'Categoria')).toBe('Outros');
    expect(termValue(sheet, 'Status')).toBeNull();
    expect(termValue(sheet, 'Finalidade')).toBeNull();
    helpBelongsToStatus(sheet);
    noWrites();
  });

  it('CONTROLE: o mesmo crédito numa saída de conta (fora de comprasCartao) mantém "Status" e "Finalidade", sem ajuda de fatura', async () => {
    mount([credit()], newClient(), false, [], CARD_VIEW);
    const d = await openDetail();
    await purposeEntry(d);
    const scope = detail();
    expect(termValue(scope, 'Status')).toBe('Pago');
    expect(termValue(scope, 'Finalidade')).toBe('Outros');
    expect(termValue(scope, 'Situação na fatura')).toBeNull();
    expect(termValue(scope, 'Categoria')).toBeNull();
    expect(scope.textContent).not.toContain(INVOICE_HELP);
  });

  it('CONTROLE: despesa positiva de comprasCartao (não é crédito) mantém "Status" e "Finalidade", sem ajuda de fatura', async () => {
    mount([], newClient(), false, [cardCredit({ id: 'buy-1', descricao: 'Compra no cartão', valor: 250_000, expenseIsCredit: false })], CARD_VIEW);
    await openDetail('Compra no cartão');
    const scope = detail();
    expect(termValue(scope, 'Status')).toBe('Planejado');
    expect(termValue(scope, 'Finalidade')).toBe('Outros');
    expect(termValue(scope, 'Situação na fatura')).toBeNull();
    expect(scope.textContent).not.toContain(INVOICE_HELP);
    expect(within(scope).queryByRole('button', { name: /finalidade do crédito/i })).toBeNull();
  });
});
