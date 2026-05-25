export interface ProjectionEntry {
  data: string; // YYYY-MM-DD
  valor: number; // cents
}

export interface ProjectionGroup {
  groupId: string;
  totalValor: number; // cents
  entries: ProjectionEntry[];
  isMulti: boolean;
}

export interface ProjectionPayConfig {
  mode?: 'avista' | 'parcelado';
  inicio?: string; // YYYY-MM
  parcelas?: string;
  valor?: string; // reais (decimal string)
}

export interface ProjectionExtra {
  valor: number; // reais
  mode: 'avista' | 'parcelado';
  parcelas: string;
  inicio?: string; // YYYY-MM
}

export interface ProjectMonthlyExpensesInput {
  monthList: string[]; // YYYY-MM, sorted asc
  groups: ProjectionGroup[];
  excludes: Set<string>;
  payConfigs: Record<string, ProjectionPayConfig>;
  extras?: ProjectionExtra[];
}

const toMonth = (dateStr: string) => dateStr.slice(0, 7);

/**
 * Distribui despesas pelos meses no `monthList` reproduzindo a projeção da
 * tela de simulação. Quando o grupo não tem `payConfig` ativo, usa as
 * datas/valores reais dos entries (Projetado == Real). Quando tem override,
 * redistribui o total em N parcelas iguais a partir do mês de início.
 */
export function projectMonthlyExpenses(input: ProjectMonthlyExpensesInput): Record<string, number> {
  const { monthList, groups, excludes, payConfigs, extras = [] } = input;
  const result: Record<string, number> = {};
  for (const m of monthList) result[m] = 0;
  const firstMonth = monthList[0];

  const addTo = (month: string | undefined, amount: number) => {
    if (month === undefined) return;
    if (result[month] === undefined) return;
    result[month] += amount;
  };

  for (const group of groups) {
    if (excludes.has(group.groupId)) continue;

    const cfg = payConfigs[group.groupId];
    const hasOverride = !!cfg && (
      cfg.mode !== undefined ||
      cfg.inicio !== undefined ||
      cfg.parcelas !== undefined ||
      (cfg.valor !== undefined && cfg.valor !== '')
    );

    if (!hasOverride) {
      for (const e of group.entries) {
        addTo(toMonth(e.data), e.valor);
      }
      continue;
    }

    const firstEntry = group.entries[0];
    const mode = cfg?.mode || (group.isMulti ? 'parcelado' : 'avista');
    const inicio = cfg?.inicio || (firstEntry ? toMonth(firstEntry.data) : firstMonth);
    const parcelas = mode === 'parcelado'
      ? Math.max(1, Math.min(12, parseInt(cfg?.parcelas || String(group.entries.length)) || 1))
      : 1;

    const valorStr = cfg?.valor;
    const valorParsed = parseFloat(valorStr || '');
    const totalValor = valorStr && !isNaN(valorParsed) ? Math.round(valorParsed * 100) : group.totalValor;

    const startIdx = inicio ? monthList.indexOf(inicio) : -1;
    if (startIdx === -1) {
      addTo(firstMonth, totalValor);
      continue;
    }

    const valorParcela = Math.floor(totalValor / parcelas);
    const resto = totalValor - valorParcela * parcelas;

    for (let i = 0; i < parcelas; i++) {
      const mIdx = startIdx + i;
      if (mIdx >= monthList.length) break;
      addTo(monthList[mIdx], valorParcela + (i === parcelas - 1 ? resto : 0));
    }
  }

  for (const extra of extras) {
    const totalValor = Math.round(extra.valor * 100);
    if (totalValor <= 0) continue;
    const parcelas = extra.mode === 'parcelado' ? Math.max(1, Math.min(12, parseInt(extra.parcelas) || 1)) : 1;
    const inicio = extra.inicio || firstMonth;
    const startIdx = inicio ? monthList.indexOf(inicio) : -1;
    if (startIdx === -1) { addTo(firstMonth, totalValor); continue; }
    const valorParcela = Math.floor(totalValor / parcelas);
    const resto = totalValor - valorParcela * parcelas;
    for (let i = 0; i < parcelas; i++) {
      const mIdx = startIdx + i;
      if (mIdx >= monthList.length) break;
      addTo(monthList[mIdx], valorParcela + (i === parcelas - 1 ? resto : 0));
    }
  }

  return result;
}
