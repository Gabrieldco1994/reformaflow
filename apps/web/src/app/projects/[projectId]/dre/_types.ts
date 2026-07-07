export interface DreLine {
  label: string;
  valor: number;
  sub?: string;
}

export interface DreGroup {
  group: string;
  icon: string;
  color: string;
  items: DreLine[];
}

export interface DreMensal {
  mes: string;
  resultado: number;
  deltaVsMesAnterior: number;
  totalEntrou: number;
  totalSaiuMaisGuardou: number;
  receitaTotal: number;
  despesaTotal: number;
  margemPct: number;
  entradas: DreLine[];
  entradasConta: DreLine[];
  saidas: DreGroup[];
  saidasCaixa: DreGroup[];
  guardado: DreLine[];
  contaCorrente: {
    caixaHoje: number;
    entrouMes: number;
    saiuMes: number;
    faltaPagarMes: number;
    recebimentosPrevistosMes: number;
    sobraPrevista: number;
    despesaTotal: number;
  };
}

export interface DreSerieRow {
  mes: string;
  receita: number | null;
  despesa: number | null;
  projecaoReceita: number | null;
  projecaoDespesa: number | null;
  margem?: number | null;
  projecaoMargem?: number | null;
  isCritical: boolean;
}

export interface DreTotalAnual {
  label: string;
  icon: string;
  color: string;
  total: number;
  mediaMensal: number;
}

export interface DreSaldoAcumuladoRow {
  mes: string;
  recebimentos: number;
  despesas: number;
  recebimentosRealizados: number | null;
  despesasRealizadas: number | null;
  saldoProjetado: number;
  saldoRealizado: number | null;
}

/** Deep-dive: despesas de um mês quebradas por origem de pagamento. */
export interface DreDespesaOrigemRow {
  mes: string;
  /** Mês projetado (futuro) — renderizado com opacidade reduzida. */
  isFuture: boolean;
  /** Valor por origem (centavos): "Conta Corrente", "Cartão ••XXXX", "Outros". */
  origens: Record<string, number>;
}

export interface DreDespesasPorOrigem {
  /** Colunas estáveis ordenadas (Conta Corrente, cartões, Outros). */
  origens: string[];
  serie: DreDespesaOrigemRow[];
}

export interface DreAnual {
  ano: number;
  ateOMes: string;
  totalEntrou: number;
  totalSaiu: number;
  resultadoAcumulado: number;
  mediaMensal: number;
  mesCritico: { mes: string; margem: number };
  serie: DreSerieRow[];
  caixaHoje: number;
  saldoAcumuladoOpening: number;
  saldoAcumuladoSerie: DreSaldoAcumuladoRow[];
  despesasPorOrigem: DreDespesasPorOrigem;
  totaisEntradas: DreTotalAnual[];
  totaisSaidas: DreTotalAnual[];
  totaisGuardado: DreTotalAnual[];
}

export interface DreOverviewResponse {
  mensal: DreMensal;
  anual: DreAnual;
}
