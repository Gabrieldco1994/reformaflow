// Ontologia de despesas — camada semântica consultável por IA.
// Cada ExpenseType recebe: grupo-pai (categoria), essencialidade e sinônimos.
// Fonte de verdade única para classificar gasto essencial × supérfluo de forma
// consistente e auditável (em vez de o agente "adivinhar" a cada resposta).

import { ExpenseType, ExpenseTypeLabels } from '../enums';

/** Essencialidade do gasto — base para "essencial vs supérfluo". */
export type Essentiality =
  | 'ESSENCIAL' // necessidade básica (moradia, comida, saúde, transporte, impostos)
  | 'SUPERFLUO' // estilo de vida / discricionário (lazer, beleza, assinaturas)
  | 'INVESTIMENTO' // poupança/patrimônio — não é consumo
  | 'NEUTRO' // movimentação (transferência, pagto de fatura) — não é consumo
  | 'PROJETO' // gasto de obra/aquisição (REFORMA/COMPRA) — fora do orçamento pessoal
  | 'INDEFINIDO'; // depende do item — classificar pelo título/contexto

export const EssentialityLabels: Record<Essentiality, string> = {
  ESSENCIAL: 'Essencial',
  SUPERFLUO: 'Supérfluo / Estilo de vida',
  INVESTIMENTO: 'Investimento / Poupança',
  NEUTRO: 'Neutro (movimentação, não é consumo)',
  PROJETO: 'Gasto de projeto (obra/aquisição)',
  INDEFINIDO: 'Depende do item (classificar pelo contexto)',
};

/** Grupos-pai (categorias) da taxonomia. */
export const ExpenseGroups = {
  MORADIA: 'Moradia',
  ALIMENTACAO: 'Alimentação',
  TRANSPORTE: 'Transporte',
  SAUDE: 'Saúde',
  EDUCACAO: 'Educação',
  ESTILO_VIDA: 'Lazer & Estilo de vida',
  SERVICOS_FINANCEIROS: 'Serviços financeiros',
  IMPOSTOS: 'Impostos & Taxas',
  OBRA: 'Obra & Reforma',
  AQUISICAO: 'Aquisição de bem',
  INVESTIMENTOS: 'Investimentos',
  TRANSFERENCIAS: 'Transferências & Ajustes',
  OUTROS: 'Outros',
} as const;

export type ExpenseGroup = (typeof ExpenseGroups)[keyof typeof ExpenseGroups];

interface TaxonomyMeta {
  group: ExpenseGroup;
  essentiality: Essentiality;
  synonyms?: string[];
}

// Metadados por tipo. Record<ExpenseType, ...> força cobrir TODOS os tipos.
const META: Record<ExpenseType, TaxonomyMeta> = {
  // ── Obra & Reforma (projetos REFORMA) ──
  [ExpenseType.MATERIAL_CONSTRUCAO]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['cimento', 'areia', 'tijolo', 'obra', 'material'] },
  [ExpenseType.ELETRODOMESTICO]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['geladeira', 'fogão', 'máquina de lavar'] },
  [ExpenseType.REVESTIMENTO]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['piso', 'azulejo', 'porcelanato'] },
  [ExpenseType.ILUMINACAO]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['luminária', 'spot', 'lustre'] },
  [ExpenseType.MARMORE]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['granito', 'bancada', 'pedra'] },
  [ExpenseType.VIDRACARIA_SERRALHERIA]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['vidro', 'box', 'esquadria', 'portão'] },
  [ExpenseType.METAL_CERAMICA]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['torneira', 'louça', 'vaso', 'pia'] },
  [ExpenseType.MARCENARIA]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['armário', 'móvel planejado', 'marceneiro'] },
  [ExpenseType.MAO_DE_OBRA]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['pedreiro', 'pintor', 'eletricista', 'empreiteiro', 'serviço'] },
  [ExpenseType.OBRA_REFORMA]: { group: ExpenseGroups.OBRA, essentiality: 'PROJETO', synonyms: ['reforma', 'obra'] },

  // ── Aquisição de bem (projetos COMPRA) ──
  [ExpenseType.ENTRADA]: { group: ExpenseGroups.AQUISICAO, essentiality: 'PROJETO', synonyms: ['entrada', 'sinal'] },
  [ExpenseType.FINANCIAMENTO]: { group: ExpenseGroups.AQUISICAO, essentiality: 'PROJETO', synonyms: ['parcela financiamento', 'prestação'] },
  [ExpenseType.DOCUMENTACAO]: { group: ExpenseGroups.AQUISICAO, essentiality: 'PROJETO', synonyms: ['documento', 'registro'] },
  [ExpenseType.CARTORIO]: { group: ExpenseGroups.AQUISICAO, essentiality: 'PROJETO', synonyms: ['cartório', 'escritura'] },
  [ExpenseType.IMPOSTO]: { group: ExpenseGroups.IMPOSTOS, essentiality: 'ESSENCIAL', synonyms: ['itbi', 'imposto'] },
  [ExpenseType.SEGURO_COMPRA]: { group: ExpenseGroups.AQUISICAO, essentiality: 'PROJETO', synonyms: ['seguro do imóvel'] },
  [ExpenseType.VISTORIA]: { group: ExpenseGroups.AQUISICAO, essentiality: 'PROJETO', synonyms: ['vistoria', 'avaliação'] },
  [ExpenseType.MUDANCA]: { group: ExpenseGroups.AQUISICAO, essentiality: 'PROJETO', synonyms: ['mudança', 'frete'] },

  // ── Moradia (pessoal) ──
  [ExpenseType.MORADIA]: { group: ExpenseGroups.MORADIA, essentiality: 'ESSENCIAL', synonyms: ['aluguel', 'condomínio', 'iptu', 'moradia'] },
  [ExpenseType.CONTAS_UTILIDADES]: { group: ExpenseGroups.MORADIA, essentiality: 'ESSENCIAL', synonyms: ['luz', 'água', 'gás', 'energia', 'conta'] },
  [ExpenseType.TELEFONE_INTERNET]: { group: ExpenseGroups.MORADIA, essentiality: 'ESSENCIAL', synonyms: ['internet', 'telefone', 'celular', 'plano'] },
  [ExpenseType.FAXINEIRA]: { group: ExpenseGroups.MORADIA, essentiality: 'SUPERFLUO', synonyms: ['faxina', 'diarista', 'limpeza'] },

  // ── Alimentação ──
  [ExpenseType.ALIMENTACAO]: { group: ExpenseGroups.ALIMENTACAO, essentiality: 'ESSENCIAL', synonyms: ['comida', 'restaurante', 'lanche', 'ifood', 'padaria'] },
  [ExpenseType.SUPERMERCADO]: { group: ExpenseGroups.ALIMENTACAO, essentiality: 'ESSENCIAL', synonyms: ['mercado', 'supermercado', 'feira'] },

  // ── Transporte ──
  [ExpenseType.TRANSPORTE]: { group: ExpenseGroups.TRANSPORTE, essentiality: 'ESSENCIAL', synonyms: ['uber', 'ônibus', 'metrô', 'transporte', '99'] },
  [ExpenseType.GASOLINA]: { group: ExpenseGroups.TRANSPORTE, essentiality: 'ESSENCIAL', synonyms: ['gasolina', 'combustível', 'álcool', 'posto'] },
  [ExpenseType.ESTACIONAMENTO]: { group: ExpenseGroups.TRANSPORTE, essentiality: 'SUPERFLUO', synonyms: ['estacionamento', 'zona azul'] },
  [ExpenseType.LAVAGEM]: { group: ExpenseGroups.TRANSPORTE, essentiality: 'SUPERFLUO', synonyms: ['lavagem', 'lava-rápido'] },

  // ── Saúde ──
  [ExpenseType.SAUDE]: { group: ExpenseGroups.SAUDE, essentiality: 'ESSENCIAL', synonyms: ['médico', 'remédio', 'farmácia', 'plano de saúde', 'exame', 'dentista'] },
  [ExpenseType.REEMBOLSO_MEDICO]: { group: ExpenseGroups.SAUDE, essentiality: 'ESSENCIAL', synonyms: ['reembolso médico'] },
  [ExpenseType.ACADEMIA]: { group: ExpenseGroups.ESTILO_VIDA, essentiality: 'SUPERFLUO', synonyms: ['academia', 'personal', 'crossfit', 'pilates'] },

  // ── Educação ──
  [ExpenseType.EDUCACAO]: { group: ExpenseGroups.EDUCACAO, essentiality: 'ESSENCIAL', synonyms: ['escola', 'faculdade', 'curso', 'mensalidade', 'matrícula'] },

  // ── Lazer & Estilo de vida ──
  [ExpenseType.LAZER]: { group: ExpenseGroups.ESTILO_VIDA, essentiality: 'SUPERFLUO', synonyms: ['cinema', 'viagem', 'bar', 'show', 'passeio'] },
  [ExpenseType.BELEZA]: { group: ExpenseGroups.ESTILO_VIDA, essentiality: 'SUPERFLUO', synonyms: ['salão', 'cabeleireiro', 'manicure', 'estética'] },
  [ExpenseType.PETS]: { group: ExpenseGroups.ESTILO_VIDA, essentiality: 'SUPERFLUO', synonyms: ['pet', 'veterinário', 'ração'] },
  [ExpenseType.ASSINATURAS]: { group: ExpenseGroups.ESTILO_VIDA, essentiality: 'SUPERFLUO', synonyms: ['netflix', 'spotify', 'assinatura', 'streaming'] },

  // ── Serviços financeiros / Seguros ──
  [ExpenseType.CARTAO_CREDITO]: { group: ExpenseGroups.SERVICOS_FINANCEIROS, essentiality: 'NEUTRO', synonyms: ['pagamento fatura', 'fatura cartão'] },
  [ExpenseType.SEGUROS_PESSOAIS]: { group: ExpenseGroups.SERVICOS_FINANCEIROS, essentiality: 'ESSENCIAL', synonyms: ['seguro de vida', 'seguro auto', 'seguro'] },
  [ExpenseType.TARIFAS_BANCARIAS]: { group: ExpenseGroups.SERVICOS_FINANCEIROS, essentiality: 'ESSENCIAL', synonyms: ['tarifa', 'anuidade', 'taxa banco'] },

  // ── Impostos ──
  [ExpenseType.IMPOSTOS_IOF]: { group: ExpenseGroups.IMPOSTOS, essentiality: 'ESSENCIAL', synonyms: ['iof'] },
  [ExpenseType.IMPOSTOS_TAXAS]: { group: ExpenseGroups.IMPOSTOS, essentiality: 'ESSENCIAL', synonyms: ['imposto', 'taxa', 'ir', 'darf'] },

  // ── Investimentos ──
  [ExpenseType.INVESTIMENTOS]: { group: ExpenseGroups.INVESTIMENTOS, essentiality: 'INVESTIMENTO', synonyms: ['aplicação', 'cdb', 'ações', 'tesouro', 'investimento'] },

  // ── Transferências & Ajustes (neutros) ──
  [ExpenseType.MOVIMENTACAO_INTERNA]: { group: ExpenseGroups.TRANSFERENCIAS, essentiality: 'NEUTRO', synonyms: ['transferência própria', 'resgate', 'aplicação interna'] },
  [ExpenseType.TRANSFERENCIA_TED]: { group: ExpenseGroups.TRANSFERENCIAS, essentiality: 'NEUTRO', synonyms: ['ted', 'doc', 'transferência'] },
  [ExpenseType.ESTORNOS_AJUSTES]: { group: ExpenseGroups.TRANSFERENCIAS, essentiality: 'NEUTRO', synonyms: ['estorno', 'ajuste', 'reembolso'] },

  // ── Ambíguos: dependem do item (classificar pelo título) ──
  [ExpenseType.PIX_ENVIADO]: { group: ExpenseGroups.TRANSFERENCIAS, essentiality: 'INDEFINIDO', synonyms: ['pix'] },
  [ExpenseType.PAGAMENTO_BOLETO]: { group: ExpenseGroups.TRANSFERENCIAS, essentiality: 'INDEFINIDO', synonyms: ['boleto'] },
  [ExpenseType.COMPRAS_VAREJO]: { group: ExpenseGroups.ESTILO_VIDA, essentiality: 'INDEFINIDO', synonyms: ['compra', 'loja', 'varejo', 'shopping'] },
  [ExpenseType.COMPRAS_DEBITO]: { group: ExpenseGroups.OUTROS, essentiality: 'INDEFINIDO', synonyms: ['débito', 'compra débito'] },
  [ExpenseType.AJUDA]: { group: ExpenseGroups.OUTROS, essentiality: 'SUPERFLUO', synonyms: ['ajuda', 'doação', 'presente', 'mesada'] },
  [ExpenseType.IMPREVISTOS]: { group: ExpenseGroups.OUTROS, essentiality: 'INDEFINIDO', synonyms: ['imprevisto', 'emergência'] },
  [ExpenseType.OUTROS]: { group: ExpenseGroups.OUTROS, essentiality: 'INDEFINIDO', synonyms: [] },
};

export interface ExpenseTaxonomyNode {
  type: string;
  label: string;
  group: ExpenseGroup;
  essentiality: Essentiality;
  essentialityLabel: string;
  synonyms: string[];
}

// Valores legados de `categoria`/`tipoDespesa` presentes em dados antigos que
// não fazem parte do enum atual — mapeados para o nó equivalente.
const LEGACY_ALIASES: Record<string, ExpenseType> = {
  PAGAMENTO_FATURA_CARTAO: ExpenseType.CARTAO_CREDITO,
  TRANSFERENCIA: ExpenseType.TRANSFERENCIA_TED,
  RENDIMENTO: ExpenseType.INVESTIMENTOS,
};

function nodeFor(type: ExpenseType): ExpenseTaxonomyNode {
  const meta = META[type];
  return {
    type,
    label: ExpenseTypeLabels[type] ?? type,
    group: meta.group,
    essentiality: meta.essentiality,
    essentialityLabel: EssentialityLabels[meta.essentiality],
    synonyms: meta.synonyms ?? [],
  };
}

/** Taxonomia completa (um nó por ExpenseType). */
export const EXPENSE_TAXONOMY: ExpenseTaxonomyNode[] = (
  Object.keys(META) as ExpenseType[]
).map(nodeFor);

/** Metadados de um tipo específico (ou undefined se desconhecido). */
export function getExpenseTaxonomy(type: string | null | undefined): ExpenseTaxonomyNode | undefined {
  if (!type) return undefined;
  if (type in META) return nodeFor(type as ExpenseType);
  const alias = LEGACY_ALIASES[type];
  if (alias) {
    const base = nodeFor(alias);
    return { ...base, type };
  }
  return undefined;
}

/** Essencialidade de um tipo (INDEFINIDO se desconhecido). */
export function classifyEssentiality(type: string | null | undefined): Essentiality {
  const node = getExpenseTaxonomy(type);
  return node?.essentiality ?? 'INDEFINIDO';
}

/** Árvore agrupada por categoria-pai → tipos. Útil para a IA introspectar. */
export function getTaxonomyTree(): { group: ExpenseGroup; types: ExpenseTaxonomyNode[] }[] {
  const byGroup = new Map<ExpenseGroup, ExpenseTaxonomyNode[]>();
  for (const node of EXPENSE_TAXONOMY) {
    const arr = byGroup.get(node.group) ?? [];
    arr.push(node);
    byGroup.set(node.group, arr);
  }
  return Array.from(byGroup.entries()).map(([group, types]) => ({ group, types }));
}
