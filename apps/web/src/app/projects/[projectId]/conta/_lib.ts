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
 * Traduz as DUAS recusas de identidade em mensagem que o usuário entende, ou
 * `null` quando o erro não é de identidade (aí a mensagem do servidor vale).
 *
 * DELIBERADAMENTE não existe "tenta de novo sem os ids". Reenviar sozinho o
 * payload sem identidade é um caminho de DOWNGRADE DE IDENTIDADE que uma
 * resposta de erro consegue disparar — e, contra a API nova, escreveria no
 * cartão resolvido por último4 logo depois de o cartão resolvido por id ter
 * sido recusado. Erro visível é estritamente melhor que escrita silenciosa no
 * recurso errado.
 */
export function invoiceIdentityErrorMessage(error: unknown): string | null {
  if (errorStatus(error) !== 400) return null;
  const message = errorMessage(error);
  if (/não correspondem/i.test(message)) {
    return 'Os dados do cartão ou da conta mudaram desde que esta tela carregou. Atualize e tente de novo.';
  }
  if (/should not exist/i.test(message)) {
    return 'Este servidor não reconhece a identificação do cartão. Atualize a página e tente de novo.';
  }
  return null;
}
