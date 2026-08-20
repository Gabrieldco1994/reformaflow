import { Barcode, Briefcase, CreditCard, Landmark, ReceiptText, RotateCcw, TrendingUp, Wallet, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export function currentMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function addMonthKey(key: string, delta: number) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function monthLabelLong(key: string) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function monthLabelShort(key: string) {
  const [year, month] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, (month || 1) - 1, 1));
  return new Intl.DateTimeFormat('pt-BR', {
    month: 'short',
    timeZone: 'UTC',
  })
    .format(date)
    .replace('.', '');
}

export function groupByMovementDay<T extends { data: string }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const day = item.data.slice(0, 10);
    const group = groups.get(day);
    if (group) group.push(item);
    else groups.set(day, [item]);
  }

  return Array.from(groups, ([day, movements]) => ({
    day,
    label: new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      timeZone: 'UTC',
    }).format(new Date(`${day}T00:00:00.000Z`)),
    movements,
  }));
}

/**
 * Mesmo agrupamento de `groupByMovementDay`, mas por mês — usado na Visão
 * Conta anual (`MovimentacoesSection` no `mode="ano"`) para não duplicar a
 * lista/filtros/mutations em um componente à parte.
 */
export function groupByMovementMonth<T extends { data: string }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const month = item.data.slice(0, 7);
    const group = groups.get(month);
    if (group) group.push(item);
    else groups.set(month, [item]);
  }

  return Array.from(groups, ([month, movements]) => ({
    day: month,
    label: monthLabelLong(month),
    movements,
  }));
}

/**
 * Chave de origem do gráfico anual (`card:1234` / `conta:5678`) → `last4`, que é
 * a moeda de troca do filtro de origem da lista (MovimentacoesSection/CartoesSection).
 * Sem isso, clicar num chip do gráfico não filtra a lista (regressão da
 * DespesasRelacionadas, que buscava os itens já filtrados pela origem).
 */
export function originLast4FromKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const [kind, last4] = key.split(':');
  if ((kind !== 'card' && kind !== 'conta') || !last4) return null;
  return last4;
}

/**
 * Totais da lista de movimentações — extraído do componente para ser testável
 * sozinho (é aqui que mora o invariante "ano == soma dos 12 meses": somar os 12
 * conjuntos mensais tem que dar exatamente o total do conjunto anual).
 * Aporte em INVESTIMENTOS sai da conta, mas não é consumo: fica fora do total de
 * saídas (mesma regra da lista).
 */
export function computeMovementTotals(
  items: Array<
    | { kind: 'saida'; valor: number; tipoDespesa: string }
    | { kind: 'entrada'; valor: number; status: 'EM_CAIXA' | 'PREVISTO' }
  >,
) {
  let totalSaidas = 0;
  let totalEntradasRecebido = 0;
  let totalEntradasPrevisto = 0;
  for (const m of items) {
    if (m.kind === 'saida') {
      if (m.tipoDespesa === 'INVESTIMENTOS') continue;
      totalSaidas += m.valor;
    } else if (m.status === 'EM_CAIXA') totalEntradasRecebido += m.valor;
    else if (m.status === 'PREVISTO') totalEntradasPrevisto += m.valor;
  }
  return { totalSaidas, totalEntradasRecebido, totalEntradasPrevisto };
}

/**
 * Soma das saídas realizadas SEM conta/cartão vinculado (pseudo-origem Carteira,
 * regra de ouro 14). Mesma conta no mês e no ano — por isso mora aqui, não na page.
 */
export function sumSaidasSemConta(
  saidas: Array<{ isInvoice: boolean; cardLast4: string | null; bankLast4: string | null; realizado: boolean; valor: number }>,
) {
  return saidas
    .filter((s) => !s.isInvoice && !s.cardLast4 && !s.bankLast4 && s.realizado)
    .reduce((acc, s) => acc + s.valor, 0);
}

export function formatDeltaPct(value: number | null) {
  if (value == null) return '—';
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded.toLocaleString('pt-BR', {
    minimumFractionDigits: Math.abs(rounded) < 10 && rounded % 1 !== 0 ? 1 : 0,
    maximumFractionDigits: 1,
  })}%`;
}

export function averageReading(deltaVsMediaPct: number | null) {
  if (deltaVsMediaPct == null) return 'Ainda não há histórico suficiente para comparar.';
  if (deltaVsMediaPct > 5) return 'suas compras estão maiores que o normal';
  if (deltaVsMediaPct < -5) return 'suas compras estão menores que o normal';
  return 'suas compras estão perto do seu ritmo normal';
}

export function movementMeta(kind: 'cartao' | 'pix' | 'debito' | 'boleto' | 'ted' | string): {
  label: string;
  icon: LucideIcon;
  badgeClass: string;
  iconClass: string;
} {
  switch (kind) {
    case 'cartao':
      return {
        label: 'cartão',
        icon: CreditCard,
        badgeClass: 'bg-slate-100 text-slate-700',
        iconClass: 'bg-slate-100 text-slate-700',
      };
    case 'pix':
      return {
        label: 'pix',
        icon: Zap,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    case 'boleto':
      return {
        label: 'boleto',
        icon: Barcode,
        badgeClass: 'bg-amber-100 text-amber-800',
        iconClass: 'bg-amber-100 text-amber-800',
      };
    case 'ted':
      return {
        label: 'ted',
        icon: Landmark,
        badgeClass: 'bg-sky-100 text-sky-700',
        iconClass: 'bg-sky-100 text-sky-700',
      };
    case 'salario':
      return {
        label: 'salário',
        icon: Wallet,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    case 'reembolso':
      return {
        label: 'reembolso',
        icon: RotateCcw,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    case 'rendimento':
    case 'juros_renda_fixa':
    case 'dividendos':
      return {
        label: 'rendimento',
        icon: TrendingUp,
        badgeClass: 'bg-emerald-100 text-emerald-700',
        iconClass: 'bg-emerald-100 text-emerald-700',
      };
    default:
      return {
        label: humanizeKey(kind),
        icon: ReceiptText,
        badgeClass: 'bg-slate-100 text-slate-700',
        iconClass: 'bg-slate-100 text-slate-700',
      };
  }
}

export function entryMeta(tipo: string) {
  if (tipo === 'salario' || tipo === 'adiantamento_salario') {
    return {
      label: tipo === 'salario' ? 'salário' : 'adiantamento',
      icon: Wallet,
    };
  }
  if (tipo === 'reembolso') {
    return { label: 'reembolso', icon: RotateCcw };
  }
  if (tipo === 'juros_renda_fixa' || tipo === 'dividendos' || tipo === 'bonus') {
    return { label: 'rendimento', icon: TrendingUp };
  }
  if (tipo === 'freelance') {
    return { label: 'freelance', icon: Briefcase };
  }
  return { label: humanizeKey(tipo), icon: ReceiptText };
}

function humanizeKey(value: string) {
  return value
    .replace(/_/g, ' ')
    .trim()
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Identidades explícitas de fatura — W1 (#448)
//
// B1a tornou `cardId`/`accountId` ADITIVOS e OPCIONAIS nas mutações de dinheiro
// `pay-invoice` / `undo-invoice-payment`: quando presentes, resolvem o
// cartão/conta estritamente por `{id, tenantId, projectId}` e têm PRECEDÊNCIA
// sobre o último4; mismatch contra o último4 (ou id cross-tenant) é 400 ANTES
// da ACL. O último4 legado continua determinístico.
//
// Contrato mixed-version (os dois deploys NÃO são atômicos):
//  - bundle novo + API antiga: o `@Body()` daquelas rotas é objeto inline
//    (metatype `Object`), então o `ValidationPipe` global (`whitelist` +
//    `forbidNonWhitelisted`) NÃO roda nelas e as chaves desconhecidas são
//    ignoradas — a API antiga resolve pelo último4 e a ação COMPLETA.
//  - por isso mandamos SEMPRE o último4 legado E o id quando existir. Nunca só
//    o id (API antiga responderia "Cartão obrigatório") e nunca `null`/`''`
//    (API nova trataria como chave de busca).
//
// INVARIANTE que torna isso seguro sem reescrever o estado das telas para ser
// chaveado por id: o id vem SEMPRE do MESMO objeto de linha que o diálogo
// recebeu (`AccountViewCardSummary` / `AccountViewConta`), então ele nunca
// diverge do último4 que o usuário está vendo na tela. Quem for chavear
// `payCardLast4`/`undoCardLast4` por id um dia precisa preservar essa
// propriedade.
// ─────────────────────────────────────────────────────────────────────────────

/** Verbos de fatura que o servidor autoriza por linha (`actions`, B1a/B1b). */
export type InvoiceAction = 'pay' | 'undo';

/** Qualquer linha de fatura (cartão da Visão Conta ou saída) com capabilities. */
export interface InvoiceCapabilitySource {
  actions?: InvoiceAction[] | null;
}

/**
 * A CTA só existe se a regra local E o servidor concordarem.
 *
 * `actions` é VETO, nunca concessão:
 *  - ausente/`null` (API antiga) → devolve `legacyAllowed` intacto, então o
 *    comportamento fica byte-a-byte o de hoje contra servidor velho;
 *  - presente → a CTA precisa estar na lista. Nada na lista RESSUSCITA uma CTA
 *    que a regra local nega (a lista pode conter verbos que esta tela não
 *    renderiza).
 *
 * Por que isto virou obrigatório no B1b (#448): uma fatura de último4 AMBÍGUO
 * (>1 cartão ativo com aquele final no projeto) passa a vir com `actions: []` e
 * `cardId: null`, porque `payInvoice`/`undoInvoicePayment` respondem 409 nesse
 * caso em vez de pagar o cartão que o banco devolvesse primeiro. Sem o veto, o
 * web continuaria desenhando "Pagar fatura" e "Desfazer pagamento" em cima de
 * uma linha cuja única resposta possível é erro — exatamente o CTA morto que
 * este issue existe para não produzir. O `onError` dos diálogos continua
 * tratando o 409 porque a tela pode estar velha (duplicata criada depois do
 * carregamento): veto na renderização, erro honesto na execução.
 */
export function invoiceActionAllowed(
  source: InvoiceCapabilitySource | null | undefined,
  action: InvoiceAction,
  legacyAllowed: boolean,
): boolean {
  if (!legacyAllowed) return false;
  const actions = source?.actions;
  if (!Array.isArray(actions)) return true;
  return actions.includes(action);
}

/**
 * Por que "Pagar fatura" não está sendo oferecida — ou `null` quando não há
 * nada de POSITIVO a dizer (API antiga, ou 'pay' autorizado).
 *
 * Vetar sem explicar é um beco sem saída: o usuário vê a fatura em aberto e o
 * botão sumiu. Mas a explicação precisa ser VERDADEIRA, e o servidor omite
 * 'pay' por dois motivos distintos (ver `computeAccountView` no B1b):
 *   1. `pending <= 0` — não há o que pagar (fila/tela velha);
 *   2. último4 ambíguo — >1 cartão ativo com aquele final no projeto.
 * O web distingue os dois com `faturaPendente`, que É o `invoice.pending` que o
 * servidor testa. Publicar "mais de um cartão com esse final" no caso 1 seria
 * inventar um problema de cadastro que não existe.
 *
 * Isto NÃO é metadata protegida: a duplicidade é do cadastro do próprio
 * usuário, na mesma lente que ele já enxerga, e sem contagem.
 */
export function invoicePayBlockedReason(
  source: (InvoiceCapabilitySource & { faturaPendente?: number | null }) | null | undefined,
): string | null {
  if (!source) return null;
  if (invoiceActionAllowed(source, 'pay', true)) return null;
  if ((source.faturaPendente ?? 0) <= 0) {
    return 'Esta fatura já consta paga nesta visão. Atualize a página.';
  }
  return 'Mais de um cartão com esse final — ajuste o cadastro para pagar.';
}

/** Cartão da fatura, como a Visão Conta o entrega (`cardId` só na API nova). */
export interface InvoiceCardIdentity {
  cardId?: string | null;
  last4: string;
  dueMonth: string;
}

/** Conta de débito do pagamento (`accountId` só na API nova). */
export interface InvoiceAccountIdentity {
  accountId?: string | null;
  last4: string;
}

export interface PayInvoicePayload {
  cardId?: string;
  cardLast4: string;
  month: string;
  amountCents: number;
  accountId?: string;
  bankLast4: string;
  paymentDate: string;
}

export interface UndoInvoicePaymentPayload {
  cardId?: string;
  cardLast4: string;
  dueMonth: string;
}

/** Id utilizável, ou `undefined` — nunca `null`, nunca string vazia/branca. */
function explicitId(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed === '' ? undefined : trimmed;
}

export function buildPayInvoicePayload(input: {
  card: InvoiceCardIdentity;
  account: InvoiceAccountIdentity;
  amountCents: number;
  paymentDate: string;
  month?: string;
}): PayInvoicePayload {
  const cardId = explicitId(input.card.cardId);
  const accountId = explicitId(input.account.accountId);
  return {
    // Espalhamento condicional: a chave não existe quando não há id, então o
    // JSON enviado é byte-a-byte o payload legado.
    ...(cardId ? { cardId } : {}),
    cardLast4: input.card.last4,
    month: input.month ?? input.card.dueMonth,
    amountCents: input.amountCents,
    ...(accountId ? { accountId } : {}),
    bankLast4: input.account.last4,
    paymentDate: input.paymentDate,
  };
}

export function buildUndoInvoicePaymentPayload(
  card: InvoiceCardIdentity,
): UndoInvoicePaymentPayload {
  const cardId = explicitId(card.cardId);
  return {
    ...(cardId ? { cardId } : {}),
    cardLast4: card.last4,
    dueMonth: card.dueMonth,
  };
}

function errorStatus(error: unknown): number | null {
  if (error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number') {
    return (error as { status: number }).status;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message;
  }
  return '';
}

/**
 * Traduz as recusas de IDENTIDADE em mensagem que o usuário entende, ou `null`
 * quando o erro não é de identidade (aí a mensagem do servidor vale).
 *
 * DELIBERADAMENTE não existe "tenta de novo sem os ids". Reenviar sozinho o
 * payload sem identidade é um caminho de DOWNGRADE DE IDENTIDADE que uma
 * resposta de erro consegue disparar — e, contra a API nova, escreveria no
 * cartão resolvido por último4 logo depois de o cartão resolvido por id ter
 * sido recusado. Erro visível é estritamente melhor que escrita silenciosa no
 * recurso errado.
 */
export function invoiceIdentityErrorMessage(error: unknown): string | null {
  const status = errorStatus(error);
  const message = errorMessage(error);

  // 409 (B1b #448): o último4 legado casa com mais de um cartão/conta ativo do
  // projeto e o servidor recusa em vez de adivinhar. A saída do usuário é
  // desfazer a duplicidade no cadastro — ou usar uma tela já atualizada, que
  // manda o id exato e nem passa por essa resolução. A mensagem repete o que o
  // servidor já disse ("ambíguo") sem acrescentar QUANTAS duplicatas existem:
  // contagem é metadata que o servidor decidiu não publicar.
  if (status === 409) {
    if (/cart[ãa]o amb/i.test(message)) {
      return 'Este projeto tem mais de um cartão com esse final, então não dá para saber qual pagar. Ajuste a duplicidade no cadastro de cartões e tente de novo.';
    }
    if (/conta amb/i.test(message)) {
      return 'Este projeto tem mais de uma conta com esse final, então não dá para saber de qual debitar. Ajuste a duplicidade no cadastro de contas e tente de novo.';
    }
    return null;
  }

  if (status !== 400) return null;
  if (/não correspondem/i.test(message)) {
    return 'Os dados do cartão ou da conta mudaram desde que esta tela carregou. Atualize e tente de novo.';
  }
  if (/should not exist/i.test(message)) {
    return 'Este servidor não reconhece a identificação do cartão. Atualize a página e tente de novo.';
  }
  return null;
}
