import type { MonthlyEntry } from '../_types';
import { entryIsNeutral, isNeutralAccountSettlement } from './neutral';

/**
 * Árvore de gastos do PESSOAL: total → origem de pagamento (cartão/conta) →
 * tipo de despesa → valor. Mesma base do `spendByOrigin`, mas com o nível extra
 * de tipo de despesa, para a "árvore de gastos" do cockpit (mês e ano).
 *
 * Regras de neutro/eixo e escopo PESSOAL são idênticas ao `spendByOrigin` (ver
 * comentário lá): assim os totais por origem batem exatamente com o widget
 * "Quanto gastei" e com a Visão Conta.
 *
 * `statusMode`:
 * - **'real'** (padrão): só despesas realizadas (PAGO/EM_CAIXA) — dinheiro que
 *   efetivamente saiu, incluindo espelhos cross-project já quitados.
 * - **'realPlus'**: realizado + planejado do PESSOAL (despesas ainda não pagas
 *   que já têm cartão/conta definidos). Parcela cross-project não quitada não
 *   entra: não tem origem pessoal definida, logo não cabe num ramo por origem.
 */

export interface SpendTreeTipo {
  /** Rótulo do tipo de despesa (categoria já amigável do cockpit). */
  tipo: string;
  /** Valor em centavos. */
  valor: number;
}

export interface SpendTreeOrigin {
  kind: 'card' | 'account';
  last4: string;
  /** Soma de todos os tipos desta origem (centavos). */
  total: number;
  /** Tipos de despesa desta origem, ordenados por valor desc. */
  tipos: SpendTreeTipo[];
}

export interface SpendTree {
  /** Soma de todas as origens (centavos). */
  total: number;
  /** Origens (cartões + contas), ordenadas por total desc. */
  origins: SpendTreeOrigin[];
}

/** Modo de status: só realizado (dinheiro que saiu) ou realizado + planejado. */
export type SpendTreeStatusMode = 'real' | 'realPlus';

/** Realizado = despesa efetivamente paga (ou em caixa). Igual ao `isRealized` do derive. */
function isRealizedStatus(status: string): boolean {
  return status === 'PAGO' || status === 'EM_CAIXA';
}

export function spendTree(
  entries: MonthlyEntry[],
  opts: {
    keepCardSettlement?: boolean;
    pessoalProjectId?: string;
    statusMode?: SpendTreeStatusMode;
  } = {},
): SpendTree {
  const { keepCardSettlement = false, pessoalProjectId, statusMode = 'real' } = opts;

  // key `${kind}:${last4}` → agregador da origem.
  const byOrigin = new Map<
    string,
    { kind: 'card' | 'account'; last4: string; total: number; tipos: Map<string, number> }
  >();

  for (const e of entries) {
    if (e.tipo !== 'DESPESA') continue;
    if (statusMode === 'real' && !isRealizedStatus(e.status)) continue;
    if (pessoalProjectId && e.projectId !== pessoalProjectId) continue;
    if (keepCardSettlement ? isNeutralAccountSettlement(e) : entryIsNeutral(e)) continue;

    let kind: 'card' | 'account';
    let last4: string;
    if (e.cardLast4) {
      kind = 'card';
      last4 = e.cardLast4;
    } else if (e.bankLast4) {
      kind = 'account';
      last4 = e.bankLast4;
    } else {
      continue; // sem origem identificável → fora da árvore por origem
    }

    const key = `${kind}:${last4}`;
    const origin =
      byOrigin.get(key) ?? { kind, last4, total: 0, tipos: new Map<string, number>() };
    const tipoLabel = e.categoria?.trim() || 'Outros';
    origin.total += e.valor;
    origin.tipos.set(tipoLabel, (origin.tipos.get(tipoLabel) ?? 0) + e.valor);
    byOrigin.set(key, origin);
  }

  const origins: SpendTreeOrigin[] = Array.from(byOrigin.values())
    .map((o) => ({
      kind: o.kind,
      last4: o.last4,
      total: o.total,
      tipos: Array.from(o.tipos.entries())
        .map(([tipo, valor]) => ({ tipo, valor }))
        .filter((t) => t.valor > 0)
        .sort((a, b) => b.valor - a.valor),
    }))
    .filter((o) => o.total > 0)
    .sort((a, b) => b.total - a.total);

  const total = origins.reduce((s, o) => s + o.total, 0);
  return { total, origins };
}
