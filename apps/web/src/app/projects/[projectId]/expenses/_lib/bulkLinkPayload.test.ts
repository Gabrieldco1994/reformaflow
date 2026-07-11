import { describe, it, expect } from 'vitest';
import { buildBulkLinkTargetPayload } from './bulkLinkPayload';
import type { Expense } from '@/types';

function source(patch: Partial<Expense>): Expense {
  return {
    id: 's1',
    tipoDespesa: 'MATERIAL_CONSTRUCAO',
    valor: 100,
    quantidade: 5,
    valorTotal: 10000,
    titulo: 'Cimento',
    fornecedor: 'Leroy Merlin',
    formaPagamento: 'A_VISTA',
    status: 'PAGO',
    ...patch,
  };
}

describe('buildBulkLinkTargetPayload', () => {
  it('allocation sempre = valorTotal (1 centavo)', () => {
    const payload = buildBulkLinkTargetPayload(source({ valorTotal: 1 }), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].allocation).toBe(1);
  });

  it('allocation sempre = valorTotal (valor grande)', () => {
    const payload = buildBulkLinkTargetPayload(source({ valorTotal: 987_654_321 }), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].allocation).toBe(987_654_321);
  });

  it('valor (reais) = valorTotal/100 exato — 30050 → 300.5, não 300.05', () => {
    const payload = buildBulkLinkTargetPayload(source({ valorTotal: 30050 }), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].valor).toBe(300.5);
  });

  it('quantidade sempre 1 mesmo com source.quantidade=5', () => {
    const payload = buildBulkLinkTargetPayload(source({ quantidade: 5 }), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].quantidade).toBe(1);
  });

  it('status herda da fonte (PLANEJADO)', () => {
    const payload = buildBulkLinkTargetPayload(source({ status: 'PLANEJADO' }), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].status).toBe('PLANEJADO');
  });

  it('status herda da fonte (PAGO)', () => {
    const payload = buildBulkLinkTargetPayload(source({ status: 'PAGO' }), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].status).toBe('PAGO');
  });

  it('titulo/fornecedor null viram undefined no payload', () => {
    const payload = buildBulkLinkTargetPayload(
      source({ titulo: null as unknown as string, fornecedor: null as unknown as string }),
      { targetProjectId: 'p2', tipoDespesa: 'MATERIAL_CONSTRUCAO' },
    );
    expect(payload.newTargets[0].titulo).toBeUndefined();
    expect(payload.newTargets[0].fornecedor).toBeUndefined();
  });

  it('titulo/fornecedor undefined permanecem undefined', () => {
    const payload = buildBulkLinkTargetPayload(source({ titulo: undefined, fornecedor: undefined }), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].titulo).toBeUndefined();
    expect(payload.newTargets[0].fornecedor).toBeUndefined();
  });

  it('formaPagamento sempre A_VISTA; existing sempre []', () => {
    const payload = buildBulkLinkTargetPayload(source({}), {
      targetProjectId: 'p2',
      tipoDespesa: 'MATERIAL_CONSTRUCAO',
    });
    expect(payload.newTargets[0].formaPagamento).toBe('A_VISTA');
    expect(payload.existing).toEqual([]);
    expect(payload.newTargets[0].targetProjectId).toBe('p2');
    expect(payload.newTargets[0].tipoDespesa).toBe('MATERIAL_CONSTRUCAO');
  });
});
