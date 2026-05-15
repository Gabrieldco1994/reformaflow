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
