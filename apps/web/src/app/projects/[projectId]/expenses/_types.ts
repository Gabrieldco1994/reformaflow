export interface InlineNewRow {
  tipoDespesa: string;
  categoriaMaoDeObra: string;
  roomId: string;
  valor: string;
  quantidade: string;
  titulo: string;
  fornecedor: string;
  formaPagamento: string;
  status: string;
  dataPagamento: string;
  quantidadeParcela: string;
  dataInicioParcela: string;
}

export function makeEmptyNewRow(defaultType = 'MATERIAL_CONSTRUCAO'): InlineNewRow {
  return {
    tipoDespesa: defaultType,
    categoriaMaoDeObra: '',
    roomId: '',
    valor: '',
    quantidade: '1',
    titulo: '',
    fornecedor: '',
    formaPagamento: 'A_VISTA',
    status: 'PLANEJADO',
    dataPagamento: '',
    quantidadeParcela: '',
    dataInicioParcela: '',
  };
}

export interface LinkPreview {
  url: string;
  ogImage: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  favicon: string | null;
}

export interface PriceResult {
  title: string;
  price: number | null;
  currency: string;
  store: string;
  link: string;
  image?: string;
}

import { ExpenseTypeLabels, type ProjectType as PType, getExpenseTypesForProject } from '@reformaflow/domain';

export function getExpenseOptions(projectType: string) {
  const types = getExpenseTypesForProject(projectType as PType);
  return types.map(t => ({ value: t, label: ExpenseTypeLabels[t] }));
}

// ── Nova jornada "+Nova despesa" (wizard reducer + payload builders) ──────────
import type { LinkedExpenseDraft } from './_components/CreateLinkedExpenseModal';

/** Representação enxuta de uma despesa-alvo EXISTENTE (cross-project) no cesto. */
export interface CrossExpenseLite {
  id: string;
  titulo?: string | null;
  tipoDespesa?: string | null;
  /** valorTotal do alvo em centavos (inteiro), quando conhecido. */
  valorTotal?: number;
  projectId?: string;
  projectName?: string | null;
}

/**
 * Rascunho de um alvo NOVO (a criar na hora, em outro projeto) dentro do cesto.
 * Reaproveita os campos de `LinkedExpenseDraft` e acrescenta o destino/roomId.
 */
export interface NewTargetDraft extends LinkedExpenseDraft {
  targetProjectId: string;
  roomId?: string;
}

/**
 * Item do payload `newTargets` do endpoint `ratear-mixed`.
 * `valor` é em REAIS; `allocation` é em CENTAVOS. Shape espelha `NewTargetDto`.
 */
export interface NewTarget {
  targetProjectId: string;
  tipoDespesa: string;
  valor: number;
  quantidade: number;
  titulo?: string;
  fornecedor?: string;
  categoriaMaoDeObra?: string;
  roomId?: string;
  formaPagamento?: string;
  status?: string;
  allocation: number;
}
