export interface NeutroItem {
  id: string;
  kind: 'entrada' | 'saida';
  tipo: string;
  tipoLabel: string;
  descricao: string;
  /** Valor total (centavos). */
  valorTotal: number;
  /** Valor unitário (centavos) — base para editar em despesas com quantidade. */
  valorUnitario: number;
  quantidade: number;
  data: string;
  status: string;
  cardLast4: string | null;
  bankLast4: string | null;
  /** true = movimenta o caixa (aporte/resgate/transferência); false = settlement (fatura). */
  afetaCaixa: boolean;
}

export interface NeutrosResponse {
  year: number;
  totalEntradas: number;
  totalSaidas: number;
  totalLiquido: number;
  itens: NeutroItem[];
}
