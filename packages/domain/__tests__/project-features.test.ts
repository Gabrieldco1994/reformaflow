import { describe, it, expect } from 'vitest';
import {
  hasFeature,
  getFeatures,
  getExpenseTypesForProject,
  PROJECT_FEATURES,
} from '../src/config/project-features';
import { ProjectType, ExpenseType } from '../src/enums';

describe('hasFeature', () => {
  it('REFORMA tem todas as features financeiras + planta/simulação', () => {
    const reformaFeatures = [
      'expenses', 'receipts', 'cashFlow', 'dashboard',
      'rooms', 'floorPlans', 'simulation', 'priceCompare',
    ] as const;
    for (const f of reformaFeatures) {
      expect(hasFeature(ProjectType.REFORMA, f)).toBe(true);
    }
  });

  it('REFORMA tem a feature pendencias (Kanban); demais tipos não', () => {
    expect(hasFeature(ProjectType.REFORMA, 'pendencias')).toBe(true);
    expect(hasFeature(ProjectType.COMPRA, 'pendencias')).toBe(false);
    expect(hasFeature(ProjectType.CASA, 'pendencias')).toBe(false);
    expect(hasFeature(ProjectType.CARRO, 'pendencias')).toBe(false);
    expect(hasFeature(ProjectType.PESSOAL, 'pendencias')).toBe(false);
  });

  it('REFORMA não tem features de gestão de bens (CASA/CARRO)', () => {    expect(hasFeature(ProjectType.REFORMA, 'recurringBills')).toBe(false);
    expect(hasFeature(ProjectType.REFORMA, 'maintenance')).toBe(false);
    expect(hasFeature(ProjectType.REFORMA, 'reminders')).toBe(false);
  });

  it('COMPRA só tem features financeiras (sem planta/simulação)', () => {
    expect(hasFeature(ProjectType.COMPRA, 'expenses')).toBe(true);
    expect(hasFeature(ProjectType.COMPRA, 'cashFlow')).toBe(true);
    expect(hasFeature(ProjectType.COMPRA, 'floorPlans')).toBe(false);
    expect(hasFeature(ProjectType.COMPRA, 'simulation')).toBe(false);
    expect(hasFeature(ProjectType.COMPRA, 'priceCompare')).toBe(false);
  });

  it('CASA tem gestão de bens + despesas avulsas (one-off)', () => {
    expect(hasFeature(ProjectType.CASA, 'dashboard')).toBe(true);
    expect(hasFeature(ProjectType.CASA, 'recurringBills')).toBe(true);
    expect(hasFeature(ProjectType.CASA, 'maintenance')).toBe(true);
    expect(hasFeature(ProjectType.CASA, 'reminders')).toBe(true);
    expect(hasFeature(ProjectType.CASA, 'expenses')).toBe(true);
    // Não tem receipts/cashFlow detalhado (sem fluxo financeiro próprio).
    expect(hasFeature(ProjectType.CASA, 'receipts')).toBe(false);
  });

  it('CARRO espelha CASA + carInfo via PROJECT_FEATURES (inclui expenses avulsas)', () => {
    expect(hasFeature(ProjectType.CARRO, 'dashboard')).toBe(true);
    expect(hasFeature(ProjectType.CARRO, 'recurringBills')).toBe(true);
    expect(hasFeature(ProjectType.CARRO, 'maintenance')).toBe(true);
    expect(hasFeature(ProjectType.CARRO, 'reminders')).toBe(true);
    expect(hasFeature(ProjectType.CARRO, 'expenses')).toBe(true);
  });
});

describe('getFeatures', () => {
  it('retorna a lista de features para o tipo', () => {
    expect(getFeatures(ProjectType.COMPRA)).toEqual(
      PROJECT_FEATURES[ProjectType.COMPRA],
    );
  });

  it('todos os tipos têm dashboard', () => {
    for (const t of Object.values(ProjectType)) {
      expect(getFeatures(t).includes('dashboard')).toBe(true);
    }
  });
});

describe('getExpenseTypesForProject', () => {
  it('REFORMA inclui MAO_DE_OBRA e MATERIAL_CONSTRUCAO', () => {
    const types = getExpenseTypesForProject(ProjectType.REFORMA);
    expect(types).toContain(ExpenseType.MAO_DE_OBRA);
    expect(types).toContain(ExpenseType.MATERIAL_CONSTRUCAO);
  });

  it('COMPRA NÃO inclui tipos de reforma (MAO_DE_OBRA, MATERIAL_CONSTRUCAO)', () => {
    const types = getExpenseTypesForProject(ProjectType.COMPRA);
    expect(types).not.toContain(ExpenseType.MAO_DE_OBRA);
    expect(types).not.toContain(ExpenseType.MATERIAL_CONSTRUCAO);
  });

  it('COMPRA inclui tipos próprios (ENTRADA, FINANCIAMENTO, DOCUMENTACAO)', () => {
    const types = getExpenseTypesForProject(ProjectType.COMPRA);
    expect(types).toContain(ExpenseType.ENTRADA);
    expect(types).toContain(ExpenseType.FINANCIAMENTO);
    expect(types).toContain(ExpenseType.DOCUMENTACAO);
  });

  it('CASA tem tipos de despesa específicos (não cai no default REFORMA)', () => {
    const casa = getExpenseTypesForProject(ProjectType.CASA);
    expect(casa).toContain(ExpenseType.MORADIA);
    expect(casa).toContain(ExpenseType.ELETRODOMESTICO);
    expect(casa).toContain(ExpenseType.ALIMENTACAO);
    expect(casa).toContain(ExpenseType.FINANCIAMENTO);
    expect(casa).toContain(ExpenseType.PAGAMENTO_CASA);
    expect(casa).toContain(ExpenseType.OUTROS);
    // Não deve conter tipos típicos só de REFORMA
    expect(casa).not.toContain(ExpenseType.MAO_DE_OBRA);
    expect(casa).not.toContain(ExpenseType.MATERIAL_CONSTRUCAO);
  });

  it('CARRO tem tipos de despesa específicos (não cai no default REFORMA)', () => {
    const carro = getExpenseTypesForProject(ProjectType.CARRO);
    expect(carro).toContain(ExpenseType.TRANSPORTE);
    expect(carro).toContain(ExpenseType.OUTROS);
    expect(carro).not.toContain(ExpenseType.MAO_DE_OBRA);
  });

  it('PESSOAL inclui Eletrodoméstico (além dos tipos pessoais)', () => {
    const pessoal = getExpenseTypesForProject(ProjectType.PESSOAL);
    expect(pessoal).toContain(ExpenseType.ELETRODOMESTICO);
    expect(pessoal).toContain(ExpenseType.MORADIA);
  });

  it('listas não estão vazias', () => {
    expect(getExpenseTypesForProject(ProjectType.REFORMA).length).toBeGreaterThan(0);
    expect(getExpenseTypesForProject(ProjectType.COMPRA).length).toBeGreaterThan(0);
  });
});
