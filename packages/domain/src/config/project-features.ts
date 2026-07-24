import { ProjectType, ExpenseType } from '../enums';

export type ProjectFeature =
  | 'expenses'
  | 'receipts'
  | 'cashFlow'
  | 'dashboard'
  | 'monthlyOverview'
  | 'rooms'
  | 'floorPlans'
  | 'simulation'
  | 'priceCompare'
  | 'recurringBills'
  | 'maintenance'
  | 'reminders'
  | 'creditCards'
  | 'bankAccounts'
  | 'pendencias'
  | 'plantsAi'
  | 'financing';

export const PROJECT_FEATURES: Record<ProjectType, ProjectFeature[]> = {
  [ProjectType.REFORMA]: [
    'expenses', 'receipts', 'cashFlow', 'dashboard',
    'rooms', 'floorPlans', 'simulation', 'priceCompare', 'pendencias',
  ],
  [ProjectType.COMPRA]: [
    'expenses', 'dashboard', 'priceCompare',
  ],
  [ProjectType.CASA]: [
    'dashboard', 'recurringBills', 'maintenance', 'reminders',
    // Despesas avulsas (one-off) — complementam as recorrentes. Também tornam CASA elegível
    // como alvo de vínculo cross-project a partir do PESSOAL.
    'expenses',
    // Financiamento imobiliário (singleton por projeto): histórico + projeção PRICE/SAC.
    'financing',
  ],
  [ProjectType.CARRO]: [
    'dashboard', 'recurringBills', 'maintenance', 'reminders',
    'expenses',
    // Financiamento de veículo (singleton por projeto, mesmo motor PRICE/SAC de CASA).
    'financing',
  ],
  [ProjectType.PESSOAL]: [
    'monthlyOverview', 'dashboard', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts',
  ],
  [ProjectType.PLANTAS]: [
    'dashboard', 'maintenance', 'reminders', 'plantsAi',
  ],
};

export function hasFeature(projectType: ProjectType, feature: ProjectFeature): boolean {
  return PROJECT_FEATURES[projectType]?.includes(feature) ?? false;
}

export function getFeatures(projectType: ProjectType): ProjectFeature[] {
  return PROJECT_FEATURES[projectType] ?? [];
}

// Expense types per project type
const REFORMA_EXPENSE_TYPES: ExpenseType[] = [
  ExpenseType.MATERIAL_CONSTRUCAO, ExpenseType.ELETRODOMESTICO,
  ExpenseType.REVESTIMENTO, ExpenseType.ILUMINACAO,
  ExpenseType.MARMORE, ExpenseType.VIDRACARIA_SERRALHERIA,
  ExpenseType.METAL_CERAMICA, ExpenseType.MARCENARIA,
  ExpenseType.MAO_DE_OBRA,
];

const COMPRA_EXPENSE_TYPES: ExpenseType[] = [
  ExpenseType.ENTRADA, ExpenseType.FINANCIAMENTO,
  ExpenseType.DOCUMENTACAO, ExpenseType.CARTORIO,
  ExpenseType.IMPOSTO, ExpenseType.SEGURO_COMPRA,
  ExpenseType.VISTORIA, ExpenseType.MUDANCA,
  ExpenseType.OUTROS,
];

const PESSOAL_EXPENSE_TYPES: ExpenseType[] = [
  ExpenseType.CARTAO_CREDITO,
  ExpenseType.MORADIA,
  ExpenseType.ELETRODOMESTICO,
  ExpenseType.ALIMENTACAO,
  ExpenseType.TRANSPORTE,
  ExpenseType.SAUDE,
  ExpenseType.EDUCACAO,
  ExpenseType.LAZER,
  ExpenseType.BELEZA,
  ExpenseType.PETS,
  ExpenseType.SUPERMERCADO,
  ExpenseType.FAXINEIRA,
  ExpenseType.AJUDA,
  ExpenseType.REEMBOLSO_MEDICO,
  ExpenseType.ACADEMIA,
  ExpenseType.ASSINATURAS,
  ExpenseType.INVESTIMENTOS,
  ExpenseType.SEGUROS_PESSOAIS,
  ExpenseType.IMPREVISTOS,
  ExpenseType.IMPOSTO,
  ExpenseType.MOVIMENTACAO_INTERNA,
  // Categorias do consolidado financeiro (extrato + faturas)
  ExpenseType.PIX_ENVIADO,
  ExpenseType.COMPRAS_VAREJO,
  ExpenseType.COMPRAS_DEBITO,
  ExpenseType.OBRA_REFORMA,
  ExpenseType.CONTAS_UTILIDADES,
  ExpenseType.TELEFONE_INTERNET,
  ExpenseType.IMPOSTOS_IOF,
  ExpenseType.IMPOSTOS_TAXAS,
  ExpenseType.TARIFAS_BANCARIAS,
  ExpenseType.ESTORNOS_AJUSTES,
  ExpenseType.PAGAMENTO_BOLETO,
  ExpenseType.TRANSFERENCIA_TED,
  ExpenseType.OUTROS,
];

// CASA: usado pelas despesas avulsas dentro da página "Contas" (além das
// recorrências). Cobre contas de consumo, manutenções e imprevistos do lar.
const CASA_EXPENSE_TYPES: ExpenseType[] = [
  ExpenseType.MORADIA,
  ExpenseType.ELETRODOMESTICO,
  ExpenseType.FINANCIAMENTO,
  ExpenseType.PAGAMENTO_CASA,
  ExpenseType.ALIMENTACAO,
  ExpenseType.SAUDE,
  ExpenseType.LAZER,
  ExpenseType.ASSINATURAS,
  ExpenseType.SEGUROS_PESSOAIS,
  ExpenseType.IMPREVISTOS,
  ExpenseType.OUTROS,
];

// CARRO: despesas avulsas (combustível, lavagem, oficina, IPVA, multas).
const CARRO_EXPENSE_TYPES: ExpenseType[] = [
  ExpenseType.ESTACIONAMENTO,
  ExpenseType.GASOLINA,
  ExpenseType.LAVAGEM,
  ExpenseType.TRANSPORTE,
  ExpenseType.SEGUROS_PESSOAIS,
  ExpenseType.IMPOSTO,
  ExpenseType.IMPREVISTOS,
  ExpenseType.OUTROS,
];

export function getExpenseTypesForProject(projectType: ProjectType): ExpenseType[] {
  switch (projectType) {
    case ProjectType.REFORMA: return REFORMA_EXPENSE_TYPES;
    case ProjectType.COMPRA: return COMPRA_EXPENSE_TYPES;
    case ProjectType.PESSOAL: return PESSOAL_EXPENSE_TYPES;
    case ProjectType.CASA: return CASA_EXPENSE_TYPES;
    case ProjectType.CARRO: return CARRO_EXPENSE_TYPES;
    case ProjectType.PLANTAS: return [];
    default: return REFORMA_EXPENSE_TYPES;
  }
}
