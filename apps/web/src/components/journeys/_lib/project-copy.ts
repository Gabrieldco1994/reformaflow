import { ProjectType } from '@reformaflow/domain';

export const PROJECT_ONBOARDING_COPY: Record<
  ProjectType,
  { heroTitle: string; heroDescription: string; defaultName: string }
> = {
  [ProjectType.PESSOAL]: {
    heroTitle: 'Seu projeto financeiro pessoal',
    heroDescription:
      'Vamos criar o projeto que centraliza seu dinheiro — contas, cartões, receitas e despesas do dia a dia.',
    defaultName: 'Minha vida financeira',
  },
  [ProjectType.REFORMA]: {
    heroTitle: 'Sua reforma',
    heroDescription: 'Vamos criar o projeto que organiza orçamento, despesas e cronograma da obra.',
    defaultName: 'Minha reforma',
  },
  [ProjectType.COMPRA]: {
    heroTitle: 'Sua grande compra',
    heroDescription: 'Vamos criar o projeto que acompanha despesas e recebimentos da conquista.',
    defaultName: 'Minha compra',
  },
  [ProjectType.CASA]: {
    heroTitle: 'Sua casa',
    heroDescription: 'Vamos criar o projeto que organiza contas e manutenções do lar.',
    defaultName: 'Minha casa',
  },
  [ProjectType.CARRO]: {
    heroTitle: 'Seu carro',
    heroDescription: 'Vamos criar o projeto que acompanha custos e manutenção do veículo.',
    defaultName: 'Meu carro',
  },
  [ProjectType.PLANTAS]: {
    heroTitle: 'Suas plantas',
    heroDescription: 'Vamos criar o projeto que organiza cuidados e lembretes das plantas.',
    defaultName: 'Minhas plantas',
  },
};
