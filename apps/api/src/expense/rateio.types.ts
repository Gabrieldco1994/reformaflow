/** Uma linha do rateio: uma alocação da compra-fonte para uma planejada de outro projeto. */
export interface RateioDetalheItem {
  /** Expense alvo (PK da alocação — @@unique, serve de chave de lista e de ordenação). */
  targetExpenseId: string;
  /** Título CRU do alvo. O fallback para `fornecedor` é apresentação (web). */
  titulo: string | null;
  fornecedor: string | null;
  /** Projeto DONO do alvo (referência estável de identidade, nunca a relação deletável). */
  projectId: string;
  projectName: string;
  projectType: string;
  /** Centavos alocados a este alvo (RateioAllocation.allocation). */
  allocationCents: number;
  /**
   * Valor total ORIGINAL do alvo antes do rateio sobrescrever seu cronograma
   * (snapshot RateioAllocation.plannedValorTotal). `null` em rateios legados,
   * criados antes do snapshot existir — NUNCA normalizar para 0.
   */
  plannedValorTotalCents: number | null;
  /** Status ATUAL do alvo (PLANEJADO | PAGO) — não o snapshot. */
  status: string;
}

export interface RateioDetalhe {
  sourceExpenseId: string;
  /** true ⟺ existe ≥1 alocação (incluindo as de alvo removido). */
  rateado: boolean;
  /** source.valorTotal em centavos. */
  totalSourceCents: number;
  /** Σ allocationCents dos itens EXIBIDOS (alvos ativos). */
  rateadoCents: number;
  /** totalSourceCents - rateadoCents. ≠ 0 sinaliza divergência — exibir, não esconder. */
  sobraCents: number;
  /** Alocações cujo alvo foi soft-deletado. Explica um sobraCents ≠ 0. */
  removedTargetsCount: number;
  /** Ordem determinística: createdAt asc, targetExpenseId asc (desempate total). */
  items: RateioDetalheItem[];
}
