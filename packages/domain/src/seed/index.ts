import { WorkTypeCategory } from '../enums';

/** Definição de um ambiente padrão com seus tipos de obra aplicáveis */
export interface RoomSeed {
  name: string;
  workTypes: WorkTypeCategory[];
}

/**
 * Catálogo padrão de tipos de obra com nomes em PT-BR
 * Extraído da planilha: coluna J "Lista Tipos de Obra"
 */
export const workTypeCatalog: Record<WorkTypeCategory, string> = {
  [WorkTypeCategory.DEMOLITION]: 'Demolição',
  [WorkTypeCategory.CIVIL]: 'Civil',
  [WorkTypeCategory.PLUMBING]: 'Hidráulica',
  [WorkTypeCategory.ELECTRICAL]: 'Elétrica',
  [WorkTypeCategory.FLOORING]: 'Pisos/Revestimentos',
  [WorkTypeCategory.PAINTING]: 'Pintura',
  [WorkTypeCategory.CARPENTRY]: 'Marcenaria',
  [WorkTypeCategory.FRAMES]: 'Esquadrias',
  [WorkTypeCategory.FIXTURES]: 'Louças/Metais',
  [WorkTypeCategory.LIGHTING]: 'Iluminação',
  [WorkTypeCategory.LABOR]: 'Mão de obra (Empreiteiro)',
  [WorkTypeCategory.FEES]: 'Taxas/Documentação',
  [WorkTypeCategory.CONTINGENCY]: 'Contingência',
};

/**
 * Matriz Ambiente × Tipo de Obra extraída diretamente da planilha
 * Controle_Reforma_Casa.xlsx — aba "Orçamento Master"
 * Total: 87 combinações (BudgetItems no seed de um novo projeto)
 */
export const roomWorkTypeMatrix: RoomSeed[] = [
  {
    name: 'Sala de TV',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.CARPENTRY,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Sala de Estar',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.CARPENTRY,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Escritório',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.CARPENTRY,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Cozinha',
    workTypes: [
      WorkTypeCategory.DEMOLITION,
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.PLUMBING,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.CARPENTRY,
      WorkTypeCategory.FIXTURES,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Quarto Casal',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.CARPENTRY,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Quarto Solteiro/Hóspedes',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.CARPENTRY,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Banheiro Social',
    workTypes: [
      WorkTypeCategory.DEMOLITION,
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.PLUMBING,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.FIXTURES,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Banheiro Suíte',
    workTypes: [
      WorkTypeCategory.DEMOLITION,
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.PLUMBING,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.FIXTURES,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Lavabo',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.PLUMBING,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.FIXTURES,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Área de Serviço',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.PLUMBING,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.FIXTURES,
    ],
  },
  {
    name: 'Área Externa/Quintal',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.PLUMBING,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Garagem',
    workTypes: [
      WorkTypeCategory.CIVIL,
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Hall/Corredor',
    workTypes: [
      WorkTypeCategory.ELECTRICAL,
      WorkTypeCategory.FLOORING,
      WorkTypeCategory.PAINTING,
      WorkTypeCategory.LIGHTING,
    ],
  },
  {
    name: 'Geral (casa toda)',
    workTypes: [
      WorkTypeCategory.FRAMES,
      WorkTypeCategory.LABOR,
      WorkTypeCategory.FEES,
      WorkTypeCategory.CONTINGENCY,
    ],
  },
];

/**
 * Milestones padrão para empreiteiro (extraído da planilha aba "Empreiteiro")
 */
export const defaultContractorMilestones = [
  { stage: 'Sinal (20%)', description: 'Pagamento inicial ao empreiteiro', percentage: 0.2 },
  { stage: 'Demolição/Civil (30%)', description: 'Após conclusão da demolição e civil', percentage: 0.3 },
  { stage: 'Acabamentos (30%)', description: 'Após pisos, pintura, instalações', percentage: 0.3 },
  { stage: 'Entrega (20%)', description: 'Pagamento final na entrega da obra', percentage: 0.2 },
] as const;

/**
 * Total de BudgetItems gerados no seed
 */
export const TOTAL_BUDGET_ITEMS = roomWorkTypeMatrix.reduce(
  (sum, room) => sum + room.workTypes.length,
  0,
);
