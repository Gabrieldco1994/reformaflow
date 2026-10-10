/**
 * #704 — corpos JSON LITERAIS do contrato de finalidade do crédito, compartilhados pelos REDs
 * (`RefundPurpose.reader.test.tsx`, `RefundPurpose.form.test.tsx`). Sem DTO paralelo nem lógica
 * de produção: só dados e utilitários de espera. Conformes ao backend:
 *  - datas serializadas com `toISOString()` (00Z), `dataCompra` pode ser `null`;
 *  - revisão do PREVIEW é a atual do source (par); o apply devolve +1 (ímpar = atribuído);
 *  - `fingerprint` = 64 hex; `roomId` sempre presente (string ou null).
 *
 * Os corpos válidos são tipados com os tipos públicos de `@reformaflow/domain`; payload
 * intencionalmente inválido deve ser declarado como `unknown` no ponto de uso do teste.
 */
import { ExpenseType } from '@reformaflow/domain';
import type { RefundPurposeResponse, RefundPurposeStateResponse, RefundPurposeSummary } from '@reformaflow/domain';

type PreviewBody = Extract<RefundPurposeResponse, { mode: 'preview' }>;
type AppliedBody = Extract<RefundPurposeResponse, { mode: 'apply' }>;

export const ANCHOR = 'proj-1'; // projeto da Conta (PESSOAL) — NÃO é o dono da compra externa
export const OWNER = 'proj-owner'; // projeto REAL que possui a despesa `credit`

export const READ_FOREIGN = `/projects/${OWNER}/expenses/credit/refund-purpose`;
export const ROOT_FOREIGN = `/projects/${OWNER}/expenses/credit`;
export const READ_OWN = `/projects/${ANCHOR}/expenses/credit-own/refund-purpose`;
export const ROOT_OWN = `/projects/${ANCHOR}/expenses/credit-own`;

export const FP1 = '3f9a1c07d2b84e56a0c3917fd8e24b6a5c10e7d93b8a4f26d1e05c7a9b3f8e21';
export const FP2 = 'b71e05c93a4d28f6e0197ac5d3b84f2e6a91c07d5e3f8b24a06d1c9e7f35a8b4';

/**
 * Formas NATIVAS (probe HTTP do backend): `GET /projects` traz só colunas de Project, SEM `rooms`;
 * `GET /projects/:id` traz `rooms[{id,projectId,name,order,createdAt,deletedAt}]` na ordem recebida,
 * incluindo Room soft-deleted (`deletedAt` ISO), e `_count`.
 */
const nativeProject = (id: string, type: string, name: string) => ({
  id,
  tenantId: 'tenant-1',
  createdByUserId: null,
  type,
  name,
  description: null,
  startDate: null,
  endDate: null,
  createdAt: '2026-01-01T12:00:00.000Z',
  updatedAt: '2026-01-01T12:00:00.000Z',
  deletedAt: null,
  onboardedAt: null,
});
export const PROJECT_CATALOG = [
  nativeProject('proj-1', 'PESSOAL', 'Pessoal'),
  nativeProject('proj-owner', 'REFORMA', 'Reforma Dona'),
  nativeProject('proj-a', 'REFORMA', 'Reforma A'),
  nativeProject('proj-b', 'REFORMA', 'Reforma B'),
  nativeProject('proj-c', 'COMPRA', 'Compra C'),
  nativeProject('proj-denied', 'REFORMA', 'Reforma Negada'), // fora de allowedProjects
  nativeProject('proj-carro', 'CARRO', 'Carro'), // tipo não concedido
  nativeProject('proj-plantas', 'PLANTAS', 'Plantas'), // sem capacidade `expenses`
];

export const ROOM_ACTIVE = 'room-a1'; // "Cozinha", projeto proj-a
export const ROOM_DELETED = 'room-a-del'; // tombstone de proj-a
export const DELETED_AT = '2026-02-01T12:00:00.000Z';
const nativeRoom = (projectId: string, id: string, name: string, order: number, deletedAt: string | null = null) => ({
  id,
  projectId,
  name,
  order,
  createdAt: '2026-01-01T12:00:00.000Z',
  deletedAt,
});
type NativeRoom = ReturnType<typeof nativeRoom>;
const ROOMS_BY_PROJECT: Array<[string, NativeRoom[]]> = [
  ['proj-1', []],
  ['proj-owner', [nativeRoom('proj-owner', 'room-o1', 'Quarto Dona', 0)]],
  [
    // CONTROLE ADVERSARIAL, não amostra do produtor nativo (o probe veio ordenado por `order`): a ordem
    // recebida aqui não é a de `order` nem a de nome, para provar que o front preserva o array sem reordenar.
    'proj-a',
    [
      nativeRoom('proj-a', 'room-a2', 'Sala de estar', 5),
      nativeRoom('proj-a', ROOM_DELETED, 'Cozinha antiga', 1, DELETED_AT),
      nativeRoom('proj-a', ROOM_ACTIVE, 'Cozinha', 2),
    ],
  ],
  ['proj-b', [nativeRoom('proj-b', 'room-b1', 'Sala', 0)]],
  ['proj-c', []],
  ['proj-plantas', []],
];
function projectDetail(id: string, rooms: NativeRoom[]) {
  const row = PROJECT_CATALOG.find((p) => p.id === id)!;
  return { ...row, rooms, _count: { receipts: 0, expenses: 0, cashFlow: 0 } };
}
export const PROJECT_DETAILS: Record<string, ReturnType<typeof projectDetail>> = Object.fromEntries(
  ROOMS_BY_PROJECT.map(([id, rooms]) => [id, projectDetail(id, rooms)]),
);
export const detailPath = (id: string) => `/projects/${id}`;

// Concessões reais lidas pelo AuthProvider (`/auth/me`), papel SEM acesso total.
export const AUTH_USER = {
  id: 'user-1',
  username: 'maria',
  name: 'Maria',
  role: 'USER',
  tenantId: 'tenant-1',
  isGuest: false,
  allowedModules: ['expenses', 'creditCards', 'bankAccounts', 'monthlyOverview'],
  allowedProjects: ['proj-1', 'proj-owner', 'proj-a', 'proj-b', 'proj-c', 'proj-carro', 'proj-plantas'],
  allowedProjectTypes: ['PESSOAL', 'REFORMA', 'COMPRA', 'PLANTAS'],
};

// Destinos válidos, na ordem do catálogo, para uma compra cujo dono é `proj-owner`.
export const OPTIONS_FOR_FOREIGN_SOURCE = ['proj-1', 'proj-a', 'proj-b', 'proj-c'];
// Para uma compra do próprio PESSOAL, a origem real (proj-1) sai e o dono externo entra.
export const OPTIONS_FOR_OWN_SOURCE = ['proj-owner', 'proj-a', 'proj-b', 'proj-c'];

// Três datas distintas, todas em ISO com hora.
export const D_COMPRA = '2026-05-10T00:00:00.000Z';
export const D_PAGAMENTO = '2026-06-15T00:00:00.000Z';
export const D_CAIXA = '2026-06-20T00:00:00.000Z';
export const SHOWN = { compra: '10/05/2026', pagamento: '15/06/2026', caixa: '20/06/2026' };

export function summary(overrides: Partial<RefundPurposeSummary> = {}, sourceExpenseId = 'credit'): RefundPurposeSummary {
  return {
    sourceExpenseId,
    targetProjectId: 'proj-a',
    roomId: null,
    tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
    allocationCents: -12_345_678,
    dataCompra: D_COMPRA,
    dataPagamento: D_PAGAMENTO,
    cashFlowDate: D_CAIXA,
    cardId: 'card-1',
    importId: 'import-1',
    ...overrides,
  };
}

export const PREPARE_STATE: RefundPurposeStateResponse = { sourceExpenseId: 'credit', assignment: null, actions: ['PREPARE'] };
export const assignedState = (
  revision = 1,
  over: Partial<RefundPurposeSummary> = {},
  actions: RefundPurposeStateResponse['actions'] = ['UNDO'],
): RefundPurposeStateResponse => ({
  sourceExpenseId: 'credit',
  assignment: { revision, summary: summary(over) },
  actions,
});
export const previewBody = (fingerprint = FP1, over: Partial<RefundPurposeSummary> = {}): PreviewBody => ({
  mode: 'preview',
  revision: 0,
  fingerprint,
  summary: summary(over),
});
export const appliedBody = (over: Partial<Omit<AppliedBody, 'mode'>> = {}): AppliedBody => ({
  mode: 'apply',
  revision: 1,
  fingerprint: FP1,
  summary: summary(),
  targetExpenseId: 'target-1',
  alreadyApplied: false,
  ...over,
});

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
export const settleFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Texto do PAR rótulo/valor pela associação ACESSÍVEL de lista de definição: o `dd` que descreve o
 * `dt` com o rótulo. Não depende de wrappers ou de "mesmo pai direto".
 */
export function pairText(root: HTMLElement, label: RegExp): string {
  const terms = Array.from(root.querySelectorAll<HTMLElement>('dt')).filter((el) => label.test(el.textContent ?? ''));
  if (terms.length !== 1) throw new Error(`rótulo ${label} deve casar exatamente um termo, casou ${terms.length}`);
  const definition = terms[0].nextElementSibling;
  if (definition?.tagName !== 'DD') throw new Error(`termo sem definição associada: ${label}`);
  return `${terms[0].textContent} ${definition.textContent}`;
}
