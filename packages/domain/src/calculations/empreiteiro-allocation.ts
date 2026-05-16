// Rateio de Mão de Obra Empreiteiro entre ambientes
//
// Regra de negócio:
// Despesas de Mão de Obra com categoria EMPREITEIRO representam um custo
// geral da obra (mestre de obras / empreiteiro contratado) e devem ser
// distribuídas entre os ambientes que possuem valor financeiro maior que zero,
// proporcionalmente ao peso de cada ambiente nas demais despesas.
//
// A função `allocateEmpreiteiroExpenses` retorna uma nova lista de despesas
// onde cada despesa de empreiteiro vinculada a um ambiente nulo (sem ambiente)
// é substituída por N "sub-despesas virtuais", uma por ambiente qualificado,
// preservando status, datas e demais metadados. Despesas de empreiteiro já
// vinculadas a um ambiente específico ficam intocadas.

export interface AllocatableExpense {
  id: string;
  tipoDespesa: string;
  categoriaMaoDeObra: string | null;
  valorTotal: number;
  roomId: string | null;
  room?: { id: string; name: string } | null;
  // Quaisquer outros campos são preservados na cópia.
  [key: string]: unknown;
}

interface AllocateOptions {
  /**
   * Quando true, a despesa virtual recebe um id derivado para evitar colisões
   * (`<originalId>::<roomId>`). Default: true.
   */
  derivedIds?: boolean;
}

export function allocateEmpreiteiroExpenses<E extends AllocatableExpense>(
  expenses: readonly E[],
  options: AllocateOptions = {},
): E[] {
  const { derivedIds = true } = options;

  const isEmpreiteiro = (e: AllocatableExpense) =>
    e.tipoDespesa === 'MAO_DE_OBRA' && e.categoriaMaoDeObra === 'EMPREITEIRO';

  // Empreiteiros sem ambiente são candidatos a rateio.
  // Empreiteiros já vinculados a um ambiente específico ficam como estão
  // (o usuário escolheu manualmente onde alocar).
  const unallocatedEmpreiteiros: E[] = [];
  const allocatedExpenses: E[] = [];
  for (const exp of expenses) {
    if (isEmpreiteiro(exp) && !exp.roomId) {
      unallocatedEmpreiteiros.push(exp);
    } else {
      allocatedExpenses.push(exp);
    }
  }

  if (unallocatedEmpreiteiros.length === 0) {
    return [...expenses];
  }

  // Pesos por ambiente: soma das despesas NÃO empreiteiro com roomId definido.
  // Apenas ambientes com valor > 0 qualificam.
  const roomWeights = new Map<string, { weight: number; name?: string }>();
  for (const exp of allocatedExpenses) {
    if (isEmpreiteiro(exp)) continue;
    if (!exp.roomId) continue;
    if (exp.valorTotal <= 0) continue;
    const current = roomWeights.get(exp.roomId) ?? { weight: 0, name: exp.room?.name };
    current.weight += exp.valorTotal;
    if (!current.name && exp.room?.name) current.name = exp.room.name;
    roomWeights.set(exp.roomId, current);
  }

  const totalWeight = Array.from(roomWeights.values()).reduce(
    (sum, r) => sum + r.weight,
    0,
  );

  // Se não houver ambientes qualificados, mantém o empreiteiro como está
  // (sem ambiente) — não temos critério de rateio.
  if (totalWeight === 0) {
    return [...expenses];
  }

  const result: E[] = [...allocatedExpenses];

  for (const empreiteiro of unallocatedEmpreiteiros) {
    const roomIds = Array.from(roomWeights.keys());
    let allocatedSoFar = 0;
    roomIds.forEach((roomId, idx) => {
      const info = roomWeights.get(roomId)!;
      // Última iteração recebe o resto para fechar o valor exato (evita drift).
      const isLast = idx === roomIds.length - 1;
      const portion = isLast
        ? empreiteiro.valorTotal - allocatedSoFar
        : (empreiteiro.valorTotal * info.weight) / totalWeight;
      allocatedSoFar += portion;
      const virtual: E = {
        ...empreiteiro,
        id: derivedIds ? `${empreiteiro.id}::${roomId}` : empreiteiro.id,
        roomId,
        room: { id: roomId, name: info.name ?? roomId },
        valorTotal: portion,
        // Marca metadados informativos. Consumidores podem ignorar.
        _allocatedFromExpenseId: empreiteiro.id,
        _allocatedRoomWeight: info.weight,
      } as unknown as E;
      result.push(virtual);
    });
  }

  return result;
}
