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
  | 'bankAccounts';

export const PROJECT_FEATURES: Record<ProjectType, ProjectFeature[]> = {
  [ProjectType.REFORMA]: [
    'expenses', 'receipts', 'cashFlow', 'dashboard',
    'rooms', 'floorPlans', 'simulation', 'priceCompare',
  ],
  [ProjectType.COMPRA]: [
    'expenses', 'receipts', 'cashFlow', 'dashboard',
  ],
  [ProjectType.CASA]: [
    'dashboard', 'recurringBills', 'maintenance', 'reminders',
  ],
  [ProjectType.CARRO]: [
    'dashboard', 'recurringBills', 'maintenance', 'reminders',
  ],
  [ProjectType.PESSOAL]: [
    'monthlyOverview', 'dashboard', 'expenses', 'receipts', 'cashFlow', 'creditCards', 'bankAccounts',
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
  ExpenseType.ALIMENTACAO,
  ExpenseType.TRANSPORTE,
  ExpenseType.SAUDE,
  ExpenseType.EDUCACAO,
  ExpenseType.LAZER,
  ExpenseType.ASSINATURAS,
  ExpenseType.INVESTIMENTOS,
  ExpenseType.SEGUROS_PESSOAIS,
  ExpenseType.IMPREVISTOS,
  ExpenseType.IMPOSTO,
  ExpenseType.OUTROS,
];

export function getExpenseTypesForProject(projectType: ProjectType): ExpenseType[] {
  switch (projectType) {
    case ProjectType.REFORMA: return REFORMA_EXPENSE_TYPES;
    case ProjectType.COMPRA: return COMPRA_EXPENSE_TYPES;
    case ProjectType.PESSOAL: return PESSOAL_EXPENSE_TYPES;
    default: return REFORMA_EXPENSE_TYPES;
  }
}
