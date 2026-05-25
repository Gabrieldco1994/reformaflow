export interface SimRow { key: string; label: string; total: number }
export interface SimTipo extends SimRow { categorias?: SimRow[] }
export interface SimAmbiente { key: string; label: string; total: number; tipos: SimTipo[] }
export interface SimTipoCard { key: string; label: string; total: number; pago?: number; planejado?: number; ambientes: (SimRow & { categorias?: SimRow[] })[] }

export interface MonthlyRow { month: string; recebimentos: number; despesas: number }

export interface PayConfig {
  mode: string;
  parcelas: string;
  inicio: string;
  valor: string;
  titulo?: string;
  categoria?: string;
  subcategoria?: string;
  ambiente?: string;
  link?: string;
  imageUrl?: string;
}

export interface SimulationData {
  kpis: { totalRecebimentos: number; previsaoGastos: number; previsaoSaldo: number };
  recebimentosPorTipo: SimRow[];
  ambientes: SimAmbiente[];
  porTipo: SimTipoCard[];
  projecaoMensal: MonthlyRow[];
  savedValues: Record<string, string>;
}

export interface Scenario {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export type SimValues = Record<string, string>;
export type SimMode = 'simulacao' | 'comparar' | 'compraveis';

export const SAVE_DEBOUNCE_MS = 1500;
