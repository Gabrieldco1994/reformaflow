import type { Expense } from '@/types';
import { effectiveDate, expandExpenseOccurrences, type ExpenseDateAxis } from './grouping-by-month';
import { isNeutralExpenseType, isSinglePaymentForm } from '@reformaflow/domain';

export interface CrossProjectMeta {
  id: string;
  name: string;
  type: string;
}

/**
 * Mapeamento expenseRemotaId → projeto remoto, vindo do endpoint cross-project.
 * Usado para resolver `linkedExpenseId` em "este gasto pertence ao projeto X".
 */
export type RemoteProjectMap = Map<string, CrossProjectMeta>;

export type OriginKind = 'CARTAO' | 'EXTRATO' | 'MANUAL';

/**
 * Split da base de despesas do projeto PESSOAL (locais + cross-project) em três
 * saídas usadas para separar o mundo "caixa" (movimentos reais da conta) do
 * mundo "lista por projeto" (alvo canônico).
 *
 * Classificação por FORMA do alvo apontado por `linkedExpenseId`:
 * - alvo ausente (fora do limit) ou de pagamento único (`isSinglePaymentForm`)
 *   → `singleTargetIds`: dedup legado; o alvo é REMOVIDO de `mutationsBase`
 *   (o espelho é o registro canônico à-vista).
 * - alvo parcelado/quinzenal → `parceladoTargetIds`: o alvo é MANTIDO em
 *   `mutationsBase` (registro canônico da despesa parcelada); os espelhos também
 *   permanecem para poderem alimentar a caixa.
 */
export interface PersonalExpenseSplit {
  mutationsBase: Expense[];
  parceladoTargetIds: Set<string>;
  singleTargetIds: Set<string>;
}

export function splitPersonalExpenseBase(local: Expense[], cross: Expense[]): PersonalExpenseSplit {
  const crossById = new Map<string, Expense>();
  for (const t of cross) crossById.set(t.id, t);

  const parceladoTargetIds = new Set<string>();
  const singleTargetIds = new Set<string>();

  for (const e of local) {
    if (!e.linkedExpenseId) continue;
    const alvo = crossById.get(e.linkedExpenseId);
    if (!alvo || isSinglePaymentForm(alvo.formaPagamento)) {
      singleTargetIds.add(e.linkedExpenseId);
    } else {
      parceladoTargetIds.add(e.linkedExpenseId);
    }
  }

  // Mantém todos os locais + alvos cross que NÃO são dedup legado (single).
  const mutationsBase = [...local, ...cross.filter((t) => !singleTargetIds.has(t.id))];
  return { mutationsBase, parceladoTargetIds, singleTargetIds };
}

/**
 * Base para o mundo CAIXA (Conta Real / KPIs de controle / total geral):
 * remove o ALVO parcelado (registro MANUAL, sem card/bank) — senão duplicaria os
 * movimentos reais dos espelhos —, mantendo os espelhos.
 */
export function toCaixaBase(filtered: Expense[], parceladoTargetIds: Set<string>): Expense[] {
  return filtered.filter((e) => !parceladoTargetIds.has(e.id));
}

/**
 * Base para a LISTA POR PROJETO: remove os ESPELHOS (conta E cartão) do alvo
 * parcelado; mantém o alvo canônico, os espelhos single (legado) e as demais.
 */
export function toDisplayBase(filtered: Expense[], parceladoTargetIds: Set<string>): Expense[] {
  return filtered.filter(
    (e) => !(e.linkedExpenseId && parceladoTargetIds.has(e.linkedExpenseId)),
  );
}

export interface OriginGroup {
  key: string; // CARTAO:1234 | EXTRATO:5678 | MANUAL
  kind: OriginKind;
  label: string;
  itens: Expense[];
}

export interface TipoGroup {
  tipo: string;
  itens: Expense[];
}

export interface ProjectGroup {
  projectKey: string; // 'self' ou id remoto
  projectName: string;
  projectType: string; // PESSOAL | REFORMA | CASA | CARRO | COMPRA
  itens: Expense[];
  origens: OriginGroup[];
  totalPago: number;
  totalPlanejado: number;
}

function originOf(e: Expense): OriginGroup {
  if (e.cardLast4) {
    return {
      key: `CARTAO:${e.cardLast4}`,
      kind: 'CARTAO',
      label: `Cartão •••• ${e.cardLast4}`,
      itens: [],
    };
  }
  if (e.bankLast4) {
    return {
      key: `EXTRATO:${e.bankLast4}`,
      kind: 'EXTRATO',
      label: `Extrato •••• ${e.bankLast4}`,
      itens: [],
    };
  }
  return { key: 'MANUAL', kind: 'MANUAL', label: 'Manual', itens: [] };
}

/**
 * Período: 'ALL' = ano todo (sem filtro de mês), 'YYYY-MM' = mês específico.
 */
export type PeriodFilter = 'ALL' | string;

/** Conjunto de meses (YYYY-MM) que uma despesa toca: uma por parcela. */
function expenseMonths(e: Expense, axis: ExpenseDateAxis = 'caixa'): string[] {
  const set = new Set<string>();
  for (const occ of expandExpenseOccurrences(e, axis)) {
    if (occ.occDate) set.add(occ.occDate.slice(0, 7));
  }
  return Array.from(set);
}

export function inPeriod(
  e: Expense,
  period: PeriodFilter,
  year: number,
  axis: ExpenseDateAxis = 'caixa',
): boolean {
  const months = expenseMonths(e, axis);
  if (months.length === 0) return period === 'ALL'; // sem data → só aparece no "ano todo"
  if (period === 'ALL') {
    return months.some((m) => m.slice(0, 4) === String(year));
  }
  return months.includes(period);
}

/**
 * Agrupa despesas (do projeto Pessoal + cross-project) por projeto destino → origem.
 * - Se `e.project` está presente e é diferente do "self" → usa `e.project`.
 * - Senão, se há `linkedExpenseId` resolvível em remoteMap → usa o destino.
 * - Caso contrário → cai em "self" (Pessoal).
 */
export function groupPersonalExpenses(
  expenses: Expense[],
  remoteMap: RemoteProjectMap,
  selfProjectName: string,
  selfProjectId?: string,
): ProjectGroup[] {
  const projects = new Map<string, ProjectGroup>();

  for (const e of expenses) {
    let projectKey = 'self';
    let projectName = selfProjectName;
    let projectType = 'PESSOAL';

    if (e.project && (!selfProjectId || e.project.id !== selfProjectId)) {
      projectKey = e.project.id;
      projectName = e.project.name;
      projectType = e.project.type;
    } else if (e.linkedExpenseId) {
      const remote = remoteMap.get(e.linkedExpenseId);
      if (remote) {
        projectKey = remote.id;
        projectName = remote.name;
        projectType = remote.type;
      }
    }

    if (!projects.has(projectKey)) {
      projects.set(projectKey, {
        projectKey,
        projectName,
        projectType,
        itens: [],
        origens: [],
        totalPago: 0,
        totalPlanejado: 0,
      });
    }
    const g = projects.get(projectKey)!;
    g.itens.push(e);
    // Neutras (pagamento de fatura, transferência interna) NÃO entram no total —
    // mesma regra de `totalsOf`. Contá-las duplicaria os itens do cartão.
    if (isNeutralExpenseType(e.tipoDespesa)) continue;
    if (e.status === 'PAGO') g.totalPago += e.valorTotal;
    else g.totalPlanejado += e.valorTotal;
  }

  // Sort projects: Pessoal primeiro, depois por nome
  const arr = Array.from(projects.values()).sort((a, b) => {
    if (a.projectKey === 'self') return -1;
    if (b.projectKey === 'self') return 1;
    return a.projectName.localeCompare(b.projectName);
  });

  // Por projeto, agrupa por origem
  for (const g of arr) {
    const origens = new Map<string, OriginGroup>();
    for (const e of g.itens) {
      const o = originOf(e);
      if (!origens.has(o.key)) origens.set(o.key, o);
      origens.get(o.key)!.itens.push(e);
    }
    g.origens = Array.from(origens.values()).sort((a, b) => {
      // Cartão primeiro, depois Extrato, depois Manual
      const order = { CARTAO: 0, EXTRATO: 1, MANUAL: 2 };
      if (order[a.kind] !== order[b.kind]) return order[a.kind] - order[b.kind];
      return a.label.localeCompare(b.label);
    });
  }

  return arr;
}

export function groupOrigemByTipo(origem: OriginGroup): TipoGroup[] {
  const map = new Map<string, TipoGroup>();
  for (const e of origem.itens) {
    if (!map.has(e.tipoDespesa)) map.set(e.tipoDespesa, { tipo: e.tipoDespesa, itens: [] });
    map.get(e.tipoDespesa)!.itens.push(e);
  }
  return Array.from(map.values()).sort((a, b) => {
    const sumA = a.itens.reduce((s, x) => s + x.valorTotal, 0);
    const sumB = b.itens.reduce((s, x) => s + x.valorTotal, 0);
    return sumB - sumA;
  });
}

/**
 * Agrupa um grupo de origem por ambiente (room) — para visão de Reforma.
 * Despesas sem room caem em "Sem ambiente".
 */
export interface RoomGroup {
  roomKey: string;
  roomLabel: string;
  itens: Expense[];
}

export function groupOrigemByRoom(origem: OriginGroup): RoomGroup[] {
  const map = new Map<string, RoomGroup>();
  for (const e of origem.itens) {
    const key = e.room?.id || e.roomId || 'sem-ambiente';
    const label = e.room?.name || (e.roomId ? 'Ambiente' : 'Sem ambiente');
    if (!map.has(key)) map.set(key, { roomKey: key, roomLabel: label, itens: [] });
    map.get(key)!.itens.push(e);
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.roomKey === 'sem-ambiente') return 1;
    if (b.roomKey === 'sem-ambiente') return -1;
    return a.roomLabel.localeCompare(b.roomLabel);
  });
}

/**
 * Lista de meses (YYYY-MM) presentes nas despesas, ordenados cronologicamente.
 */
export function listPeriods(expenses: Expense[], year: number): string[] {
  const set = new Set<string>();
  for (const e of expenses) {
    for (const m of expenseMonths(e)) {
      if (m.slice(0, 4) === String(year)) set.add(m);
    }
  }
  return Array.from(set).sort();
}

const MES_LABEL = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

export function periodLabel(p: PeriodFilter): string {
  if (p === 'ALL') return 'Ano todo';
  const [yy, mm] = p.split('-').map(Number);
  return `${MES_LABEL[mm - 1]} ${yy}`;
}

export function currentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, '0')}`;
}

export function totalsOf(items: Expense[]): { pago: number; planejado: number } {
  let pago = 0;
  let planejado = 0;
  for (const e of items) {
    // Movimentação interna e pagamento de fatura não contam no total — são
    // movimentações neutras (não representam consumo nem entrada nova).
    if (isNeutralExpenseType(e.tipoDespesa)) continue;
    if (e.status === 'PAGO') pago += e.valorTotal;
    else planejado += e.valorTotal;
  }
  return { pago, planejado };
}

// ───── Agrupamentos para os modos Categoria / Mês ─────────────────

export interface MonthGroup {
  ym: string; // 'YYYY-MM' ou 'sem-data'
  label: string;
  projects: ProjectGroup[];
  totalPago: number;
  totalPlanejado: number;
  count: number;
}

const MES_LABEL_CURTO = MES_LABEL;

export function groupByMonth(
  expenses: Expense[],
  remoteMap: RemoteProjectMap,
  selfProjectName: string,
  selfProjectId?: string,
): MonthGroup[] {
  const buckets = new Map<string, Expense[]>();
  for (const e of expenses) {
    const dt = effectiveDate(e);
    let ym = 'sem-data';
    // Fatia a string ISO (UTC) — usar new Date()/getMonth() converteria para o
    // fuso local e jogaria datas em UTC-00:00 (ex.: 2026-06-01T00:00Z) para o mês
    // anterior em BRT (maio).
    if (dt && typeof dt === 'string' && /^\d{4}-\d{2}/.test(dt)) {
      ym = dt.slice(0, 7);
    }
    if (!buckets.has(ym)) buckets.set(ym, []);
    buckets.get(ym)!.push(e);
  }
  const arr: MonthGroup[] = Array.from(buckets.entries()).map(([ym, itens]) => {
    const projects = groupPersonalExpenses(itens, remoteMap, selfProjectName, selfProjectId);
    const { pago, planejado } = totalsOf(itens);
    let label = 'Sem data';
    if (ym !== 'sem-data') {
      const [yy, mm] = ym.split('-').map(Number);
      label = `${MES_LABEL_CURTO[mm - 1]} ${yy}`;
    }
    return { ym, label, projects, totalPago: pago, totalPlanejado: planejado, count: itens.length };
  });
  return arr.sort((a, b) => {
    if (a.ym === 'sem-data') return 1;
    if (b.ym === 'sem-data') return -1;
    return b.ym.localeCompare(a.ym);
  });
}

export interface TipoTopGroup {
  tipo: string;
  label: string;
  projects: ProjectGroup[];
  totalPago: number;
  totalPlanejado: number;
  count: number;
}

export function groupByTipo(
  expenses: Expense[],
  remoteMap: RemoteProjectMap,
  selfProjectName: string,
  tipoLabel: (t: string) => string,
  selfProjectId?: string,
): TipoTopGroup[] {
  const buckets = new Map<string, Expense[]>();
  for (const e of expenses) {
    const k = e.tipoDespesa || 'OUTROS';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k)!.push(e);
  }
  const arr: TipoTopGroup[] = Array.from(buckets.entries()).map(([tipo, itens]) => {
    const projects = groupPersonalExpenses(itens, remoteMap, selfProjectName, selfProjectId);
    const { pago, planejado } = totalsOf(itens);
    return { tipo, label: tipoLabel(tipo), projects, totalPago: pago, totalPlanejado: planejado, count: itens.length };
  });
  // Maior gasto primeiro
  return arr.sort((a, b) => (b.totalPago + b.totalPlanejado) - (a.totalPago + a.totalPlanejado));
}
