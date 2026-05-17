import { describe, it, expect } from 'vitest';
import {
  allocateEmpreiteiroExpenses,
  type AllocatableExpense,
} from '../src/calculations/empreiteiro-allocation';

const makeMaterial = (
  id: string,
  roomId: string | null,
  valorTotal: number,
  roomName?: string,
): AllocatableExpense => ({
  id,
  tipoDespesa: 'MATERIAL_CONSTRUCAO',
  categoriaMaoDeObra: null,
  valorTotal,
  roomId,
  room: roomId ? { id: roomId, name: roomName ?? roomId } : null,
});

const makeEmpreiteiro = (
  id: string,
  roomId: string | null,
  valorTotal: number,
): AllocatableExpense => ({
  id,
  tipoDespesa: 'MAO_DE_OBRA',
  categoriaMaoDeObra: 'EMPREITEIRO',
  valorTotal,
  roomId,
  room: roomId ? { id: roomId, name: roomId } : null,
});

describe('allocateEmpreiteiroExpenses', () => {
  it('retorna a lista original quando não há empreiteiro sem ambiente', () => {
    const expenses = [
      makeMaterial('m1', 'sala', 10000),
      makeEmpreiteiro('e1', 'sala', 5000), // empreiteiro JÁ alocado: ignorado
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id).sort()).toEqual(['e1', 'm1']);
  });

  it('rateia empreiteiro entre ambientes proporcionalmente ao peso (valor>0)', () => {
    const expenses = [
      makeMaterial('m1', 'sala', 30000, 'Sala'),
      makeMaterial('m2', 'cozinha', 10000, 'Cozinha'),
      makeEmpreiteiro('emp', null, 8000),
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    // 2 originais (m1, m2) + 2 virtuais
    expect(result).toHaveLength(4);
    const virtuais = result.filter((r) =>
      r.tipoDespesa === 'MAO_DE_OBRA' && r.categoriaMaoDeObra === 'EMPREITEIRO',
    );
    expect(virtuais).toHaveLength(2);

    const sala = virtuais.find((v) => v.roomId === 'sala')!;
    const cozinha = virtuais.find((v) => v.roomId === 'cozinha')!;
    // Sala = 30000/40000 * 8000 = 6000
    // Cozinha = última iteração: 8000 - 6000 = 2000
    expect(sala.valorTotal + cozinha.valorTotal).toBe(8000);
    // Pelo peso, Sala recebe 3x a Cozinha (independente da ordem da iteração)
    const ratio = sala.valorTotal / cozinha.valorTotal;
    expect(ratio).toBeCloseTo(3, 5);
  });

  it('soma exatamente o valor total do empreiteiro (sem drift de centavos)', () => {
    const expenses = [
      makeMaterial('m1', 'a', 333),
      makeMaterial('m2', 'b', 333),
      makeMaterial('m3', 'c', 334),
      makeEmpreiteiro('emp', null, 10001), // valor "feio" pra forçar arredondamento
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    const virtuais = result.filter(
      (r) => r.tipoDespesa === 'MAO_DE_OBRA' && r.categoriaMaoDeObra === 'EMPREITEIRO',
    );
    const soma = virtuais.reduce((s, v) => s + v.valorTotal, 0);
    expect(soma).toBe(10001);
  });

  it('ignora ambientes com valorTotal <= 0 (não qualificados)', () => {
    const expenses = [
      makeMaterial('m1', 'sala', 10000),
      makeMaterial('m2', 'quarto', 0), // não qualifica
      makeEmpreiteiro('emp', null, 5000),
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    const virtuais = result.filter(
      (r) => r.tipoDespesa === 'MAO_DE_OBRA' && r.categoriaMaoDeObra === 'EMPREITEIRO',
    );
    expect(virtuais).toHaveLength(1);
    expect(virtuais[0]!.roomId).toBe('sala');
    expect(virtuais[0]!.valorTotal).toBe(5000);
  });

  it('mantém empreiteiro como está quando não há ambientes qualificados', () => {
    const expenses = [makeEmpreiteiro('emp', null, 5000)];
    const result = allocateEmpreiteiroExpenses(expenses);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe('emp');
    expect(result[0]!.roomId).toBeNull();
    expect(result[0]!.valorTotal).toBe(5000);
  });

  it('preserva empreiteiros já alocados manualmente (sem reagir)', () => {
    const expenses = [
      makeMaterial('m1', 'sala', 10000),
      makeEmpreiteiro('e1', 'sala', 3000), // já tem ambiente — fica intocado
      makeEmpreiteiro('e2', null, 4000),   // candidato a rateio
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    const e1 = result.find((r) => r.id === 'e1');
    expect(e1).toBeDefined();
    expect(e1!.valorTotal).toBe(3000);
    expect(e1!.roomId).toBe('sala');
    // e2 deve ter sido substituído por virtuais
    expect(result.find((r) => r.id === 'e2')).toBeUndefined();
  });

  it('gera ids derivados por padrão (originalId::roomId)', () => {
    const expenses = [
      makeMaterial('m1', 'sala', 10000),
      makeMaterial('m2', 'cozinha', 10000),
      makeEmpreiteiro('emp', null, 4000),
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    const virtuais = result.filter(
      (r) => r.tipoDespesa === 'MAO_DE_OBRA' && r.categoriaMaoDeObra === 'EMPREITEIRO',
    );
    expect(virtuais.map((v) => v.id).sort()).toEqual([
      'emp::cozinha',
      'emp::sala',
    ]);
  });

  it('respeita derivedIds:false (mantém id original em todas as virtuais)', () => {
    const expenses = [
      makeMaterial('m1', 'sala', 10000),
      makeMaterial('m2', 'cozinha', 10000),
      makeEmpreiteiro('emp', null, 4000),
    ];
    const result = allocateEmpreiteiroExpenses(expenses, { derivedIds: false });
    const virtuais = result.filter(
      (r) => r.tipoDespesa === 'MAO_DE_OBRA' && r.categoriaMaoDeObra === 'EMPREITEIRO',
    );
    expect(virtuais).toHaveLength(2);
    expect(virtuais.every((v) => v.id === 'emp')).toBe(true);
  });

  it('preserva o nome do ambiente quando disponível em outras despesas', () => {
    const expenses = [
      makeMaterial('m1', 'sala-id', 10000, 'Sala de Estar'),
      makeEmpreiteiro('emp', null, 5000),
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    const virtual = result.find(
      (r) =>
        r.tipoDespesa === 'MAO_DE_OBRA' &&
        r.categoriaMaoDeObra === 'EMPREITEIRO' &&
        r.roomId === 'sala-id',
    );
    expect(virtual?.room?.name).toBe('Sala de Estar');
  });

  it('marca metadados informativos _allocatedFromExpenseId e _allocatedRoomWeight', () => {
    const expenses = [
      makeMaterial('m1', 'sala', 20000),
      makeEmpreiteiro('emp', null, 1000),
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    const virtual = result.find(
      (r) => r.tipoDespesa === 'MAO_DE_OBRA' && r.categoriaMaoDeObra === 'EMPREITEIRO',
    ) as Record<string, unknown> | undefined;
    expect(virtual?._allocatedFromExpenseId).toBe('emp');
    expect(virtual?._allocatedRoomWeight).toBe(20000);
  });

  it('lida com lista vazia', () => {
    expect(allocateEmpreiteiroExpenses([])).toEqual([]);
  });

  it('rateia múltiplos empreiteiros independentemente', () => {
    const expenses = [
      makeMaterial('m1', 'a', 10000),
      makeMaterial('m2', 'b', 30000),
      makeEmpreiteiro('e1', null, 4000),
      makeEmpreiteiro('e2', null, 2000),
    ];
    const result = allocateEmpreiteiroExpenses(expenses);
    const virtuais = result.filter(
      (r) => r.tipoDespesa === 'MAO_DE_OBRA' && r.categoriaMaoDeObra === 'EMPREITEIRO',
    );
    // 2 empreiteiros * 2 rooms = 4 virtuais
    expect(virtuais).toHaveLength(4);

    const totalRateado = virtuais.reduce((s, v) => s + v.valorTotal, 0);
    expect(totalRateado).toBe(6000); // 4000 + 2000
  });
});
