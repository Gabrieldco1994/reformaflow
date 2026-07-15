import { ProjectType } from '@reformaflow/domain';

export const OBJECTIVE_TYPES = [
  ProjectType.REFORMA,
  ProjectType.COMPRA,
  ProjectType.CASA,
  ProjectType.CARRO,
  ProjectType.PESSOAL,
  ProjectType.PLANTAS,
] as const;

export type ObjectiveType = (typeof OBJECTIVE_TYPES)[number];

export const OBJECTIVE_DETAILS: Record<ObjectiveType, { label: string; description: string }> = {
  [ProjectType.REFORMA]: { label: 'Reformar', description: 'Orçamento, despesas, cronograma, ambientes e plantas.' },
  [ProjectType.COMPRA]: { label: 'Fazer uma grande compra', description: 'Despesas, recebimentos e fluxo de caixa da conquista.' },
  [ProjectType.CASA]: { label: 'Cuidar da casa', description: 'Contas, gastos avulsos, manutenções e lembretes.' },
  [ProjectType.CARRO]: { label: 'Cuidar do carro', description: 'Custos, dados do veículo, manutenções e lembretes.' },
  [ProjectType.PESSOAL]: { label: 'Organizar minha vida financeira', description: 'Visão mensal, contas, cartões, despesas e recebimentos.' },
  [ProjectType.PLANTAS]: { label: 'Cuidar das minhas plantas', description: 'Rotina de cuidados, lembretes e diagnóstico por IA.' },
};

export function isObjectiveType(value: string): value is ObjectiveType {
  return OBJECTIVE_TYPES.some((type) => type === value);
}
