import { describe, expect, it } from 'vitest';
import { ProjectType } from '@reformaflow/domain';
import { buildByTypeGroups } from './by-type';
import type { AccountViewSaida } from '../_types';

/**
 * U6b build 1 — lente `by-type` (#456). RED spec do builder/re-key: agrupa
 * `saidas` + `comprasCartao` por `project.type` (nunca pelo rótulo), fail-closed
 * em tipo ausente/desconhecido, exclui `isIncludedInSaidaTotal === false`
 * (inclusive INVESTIMENTOS) e preserva o invariante Σ(grupos) = totalSaidas.
 * `entradas` não é parâmetro desta função por design (§ contrato §7.5).
 */

function saida(overrides: Partial<AccountViewSaida> & { valor: number }): AccountViewSaida {
  return {
    id: overrides.id ?? 'saida-fixture',
    kind: 'saida',
    descricao: 'Movimento',
    data: '2026-07-10T00:00:00.000Z',
    forma: 'debito',
    realizado: true,
    status: 'PAGO',
    cardLast4: null,
    bankLast4: null,
    tipoDespesa: 'MERCADO',
    isInvoice: false,
    editavel: true,
    dueMonth: null,
    projetoOrigem: null,
    ...overrides,
  };
}
describe('buildByTypeGroups', () => {
  it('ignora compra sem fatura do mesmo cartão e mês', () => {
    const fixture = {
      saidaTotal: 5_000,
      saidas: [
        saida({
          id: 'invoice-1111-2026-07',
          valor: 5_000,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          isInvoice: true,
          cardLast4: '1111',
          dueMonth: '2026-07',
        }),
      ],
      comprasCartao: [
        saida({
          id: 'purchase-2222-2026-07',
          valor: 5_000,
          cardLast4: '2222',
          dueMonth: '2026-07',
          projetoOrigem: { id: 'project-reforma', name: 'Obra', type: ProjectType.REFORMA },
        }),
      ],
    };
    const groups = buildByTypeGroups({ ...fixture, selfProjectType: ProjectType.PESSOAL });

    expect(groups.find((g) => g.type === ProjectType.PESSOAL)).toMatchObject({ total: 5_000, count: 1 });
    expect(groups.find((g) => g.type === ProjectType.REFORMA)).toBeUndefined();
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(fixture.saidaTotal);
  });

  it('ignora compra do mesmo cartão quando o mês da fatura é diferente', () => {
    const fixture = {
      saidaTotal: 5_000,
      saidas: [
        saida({ valor: 5_000, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', isInvoice: true, cardLast4: '1111', dueMonth: '2026-07' }),
      ],
      comprasCartao: [
        saida({ valor: 5_000, cardLast4: '1111', dueMonth: '2026-08', projetoOrigem: { id: 'project-reforma', name: 'Obra', type: ProjectType.REFORMA } }),
      ],
    };
    const groups = buildByTypeGroups({ ...fixture, selfProjectType: ProjectType.PESSOAL });

    expect(groups.find((g) => g.type === ProjectType.PESSOAL)).toMatchObject({ total: 5_000, count: 1 });
    expect(groups.find((g) => g.type === ProjectType.REFORMA)).toBeUndefined();
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(fixture.saidaTotal);
  });

  it.each([
    { missing: 'cardLast4', cardLast4: null, dueMonth: '2026-07' },
    { missing: 'dueMonth', cardLast4: '1111', dueMonth: null },
  ])('ignora compra quando a fatura não tem $missing', ({ cardLast4, dueMonth }) => {
    const fixture = {
      saidaTotal: 5_000,
      saidas: [
        saida({ valor: 5_000, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', isInvoice: true, cardLast4, dueMonth }),
      ],
      comprasCartao: [
        saida({ valor: 5_000, cardLast4: '1111', dueMonth: '2026-07', projetoOrigem: { id: 'project-reforma', name: 'Obra', type: ProjectType.REFORMA } }),
      ],
    };
    const groups = buildByTypeGroups({ ...fixture, selfProjectType: ProjectType.PESSOAL });

    expect(groups.find((g) => g.type === ProjectType.PESSOAL)).toMatchObject({ total: 5_000, count: 1 });
    expect(groups.find((g) => g.type === ProjectType.REFORMA)).toBeUndefined();
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(fixture.saidaTotal);
  });

  it('não desloca compra quando a fatura casada não criou baseline PESSOAL', () => {
    const fixture = {
      saidaTotal: 5_000,
      saidas: [
        saida({
          id: 'invoice-carro-1111-2026-07',
          valor: 5_000,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          isInvoice: true,
          cardLast4: '1111',
          dueMonth: '2026-07',
          projetoOrigem: { id: 'project-carro', name: 'Carro', type: ProjectType.CARRO },
        }),
      ],
      comprasCartao: [
        saida({
          id: 'purchase-reforma-1111-2026-07',
          valor: 2_000,
          cardLast4: '1111',
          dueMonth: '2026-07',
          projetoOrigem: { id: 'project-reforma', name: 'Obra', type: ProjectType.REFORMA },
        }),
      ],
    };
    const groups = buildByTypeGroups({ ...fixture, selfProjectType: ProjectType.PESSOAL });

    expect(groups.find((g) => g.type === ProjectType.PESSOAL)).toMatchObject({ total: 0, count: 0 });
    expect(groups.find((g) => g.type === ProjectType.CARRO)).toMatchObject({ total: 5_000, count: 1 });
    expect(groups.find((g) => g.type === ProjectType.REFORMA)).toBeUndefined();
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(fixture.saidaTotal);
  });

  it('desloca compra casada sem limitar ao valor ajustado da fatura', () => {
    const fixture = {
      saidaTotal: 8_000,
      saidas: [
        saida({
          id: 'invoice-adjusted-1111-2026-07',
          valor: 8_000,
          tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
          isInvoice: true,
          cardLast4: '1111',
          dueMonth: '2026-07',
        }),
      ],
      comprasCartao: [
        saida({
          id: 'purchase-reforma-1111-2026-07',
          valor: 10_000,
          cardLast4: '1111',
          dueMonth: '2026-07',
          projetoOrigem: { id: 'project-reforma', name: 'Obra', type: ProjectType.REFORMA },
        }),
      ],
    };
    const groups = buildByTypeGroups({ ...fixture, selfProjectType: ProjectType.PESSOAL });

    expect(groups.find((g) => g.type === ProjectType.PESSOAL)).toMatchObject({ total: -2_000, count: 1 });
    expect(groups.find((g) => g.type === ProjectType.REFORMA)).toMatchObject({ total: 10_000, count: 1 });
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(fixture.saidaTotal);
  });

  it('faz netting por cartão e mês para movimentos realizados e planejados', () => {
    const fixture = {
      saidaTotal: 19_000,
      saidas: [
        saida({ id: 'invoice-1111-2026-07', valor: 9_000, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', isInvoice: true, cardLast4: '1111', dueMonth: '2026-07' }),
        saida({ id: 'invoice-2222-2026-08', valor: 10_000, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', isInvoice: true, cardLast4: '2222', dueMonth: '2026-08', realizado: false, status: 'PENDENTE' }),
      ],
      comprasCartao: [
        saida({ id: 'purchase-reforma-1111-2026-07', valor: 6_000, cardLast4: '1111', dueMonth: '2026-07', projetoOrigem: { id: 'project-reforma', name: 'Obra', type: ProjectType.REFORMA } }),
        saida({ id: 'purchase-carro-2222-2026-08', valor: 4_000, cardLast4: '2222', dueMonth: '2026-08', projetoOrigem: { id: 'project-carro', name: 'Carro', type: ProjectType.CARRO } }),
        saida({ id: 'purchase-casa-1111-2026-07', valor: 3_000, cardLast4: '1111', dueMonth: '2026-07', realizado: false, status: 'PENDENTE', projetoOrigem: { id: 'project-casa', name: 'Casa', type: ProjectType.CASA } }),
        saida({ id: 'purchase-investimento-2222-2026-08', valor: 7_000, cardLast4: '2222', dueMonth: '2026-08', tipoDespesa: 'INVESTIMENTOS', projetoOrigem: { id: 'project-carro', name: 'Carro', type: ProjectType.CARRO } }),
      ],
    };
    const groups = buildByTypeGroups({ ...fixture, selfProjectType: ProjectType.PESSOAL });

    expect(groups.find((g) => g.type === ProjectType.PESSOAL)).toMatchObject({ total: 6_000, count: 2 });
    expect(groups.find((g) => g.type === ProjectType.REFORMA)).toMatchObject({ total: 6_000, count: 1 });
    expect(groups.find((g) => g.type === ProjectType.CARRO)).toMatchObject({ total: 4_000, count: 1 });
    expect(groups.find((g) => g.type === ProjectType.CASA)).toMatchObject({ total: 3_000, count: 1 });
    expect(groups.reduce((sum, group) => sum + group.total, 0)).toBe(fixture.saidaTotal);
  });

  it('fail-closed: selfProjectType diferente de PESSOAL não produz grupos', () => {
    const groups = buildByTypeGroups({
      saidas: [saida({ valor: 1000 })],
      comprasCartao: [],
      selfProjectType: 'REFORMA',
    });
    expect(groups).toEqual([]);
  });

  it('fail-closed: selfProjectType ausente/vazio não produz grupos', () => {
    const groups = buildByTypeGroups({
      saidas: [saida({ valor: 1000 })],
      comprasCartao: [],
      selfProjectType: '',
    });
    expect(groups).toEqual([]);
  });

  it('agrupa saída sem projetoOrigem em PESSOAL', () => {
    const groups = buildByTypeGroups({
      saidas: [saida({ valor: 5_000, projetoOrigem: null })],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    expect(groups).toEqual([
      expect.objectContaining({ type: ProjectType.PESSOAL, total: 5_000, count: 1 }),
      expect.objectContaining({ type: ProjectType.PLANTAS, total: 0, count: 0, hasFinance: false }),
    ]);
  });

  it('agrupa saída com projetoOrigem REFORMA no bucket REFORMA, estrito por type', () => {
    const groups = buildByTypeGroups({
      saidas: [
        saida({ id: 'a', valor: 3_000, projetoOrigem: { id: 'p1', name: 'Obra', type: 'REFORMA' } }),
        saida({ id: 'b', valor: 1_000, projetoOrigem: null }),
      ],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    const reforma = groups.find((g) => g.type === 'REFORMA');
    const pessoal = groups.find((g) => g.type === 'PESSOAL');
    expect(reforma).toMatchObject({ total: 3_000, count: 1 });
    expect(pessoal).toMatchObject({ total: 1_000, count: 1 });
  });

  it('fail-closed: projetoOrigem.type desconhecido cai em PESSOAL, nunca é inferido pelo nome', () => {
    const groups = buildByTypeGroups({
      saidas: [
        saida({ valor: 2_000, projetoOrigem: { id: 'x', name: 'Reforma da Casa', type: 'ALGO_NOVO' } }),
      ],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    expect(groups.find((g) => g.type === 'ALGO_NOVO')).toBeUndefined();
    expect(groups.find((g) => g.type === 'PESSOAL')).toMatchObject({ total: 2_000, count: 1 });
  });

  it('exclui INVESTIMENTOS do agrupamento e do subtotal (isIncludedInSaidaTotal === false)', () => {
    const groups = buildByTypeGroups({
      saidas: [
        saida({ id: 'aporte', valor: 10_000, tipoDespesa: 'INVESTIMENTOS' }),
        saida({ id: 'gasto', valor: 4_000, tipoDespesa: 'MERCADO' }),
      ],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    const pessoal = groups.find((g) => g.type === 'PESSOAL');
    expect(pessoal).toMatchObject({ total: 4_000, count: 1 });
  });

  it('PLANTAS aparece sempre como "sem financeiro", sem fabricar movimentos', () => {
    const groups = buildByTypeGroups({
      saidas: [saida({ valor: 100 })],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    expect(groups.find((g) => g.type === 'PLANTAS')).toEqual(
      expect.objectContaining({ type: 'PLANTAS', total: 0, count: 0, hasFinance: false }),
    );
  });

  it('tipos sem nenhum lançamento (REFORMA/COMPRA/CASA/CARRO) não aparecem fabricados', () => {
    const groups = buildByTypeGroups({
      saidas: [saida({ valor: 100, projetoOrigem: null })],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    expect(groups.map((g) => g.type)).toEqual([ProjectType.PESSOAL, ProjectType.PLANTAS]);
  });

  it('PAGAMENTO_FATURA_CARTAO conta exatamente 1x no bucket PESSOAL, sem colidir com comprasCartao expandidas', () => {
    const fatura = saida({
      id: 'fatura-4242',
      valor: 9_000,
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      isInvoice: true,
      cardLast4: '4242',
      dueMonth: '2026-07',
      projetoOrigem: null,
    });
    const comprasCartao: AccountViewSaida[] = [
      saida({
        id: 'compra-reforma',
        valor: 6_000,
        cardLast4: '4242',
        dueMonth: '2026-07',
        tipoDespesa: 'MATERIAL_CONSTRUCAO',
        projetoOrigem: { id: 'p1', name: 'Obra', type: 'REFORMA' },
      }),
      saida({
        id: 'compra-pessoal',
        valor: 2_000,
        cardLast4: '4242',
        dueMonth: '2026-07',
        tipoDespesa: 'MERCADO',
        projetoOrigem: null,
      }),
      // "Cartão paga cartão": este cartão pagou a fatura de outro — compra
      // tipada PAGAMENTO_FATURA_CARTAO mas sem projetoOrigem (é PESSOAL).
      saida({
        id: 'compra-fatura-outro-cartao',
        valor: 1_000,
        cardLast4: '4242',
        dueMonth: '2026-07',
        tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
        projetoOrigem: null,
      }),
    ];

    const groups = buildByTypeGroups({
      saidas: [fatura],
      comprasCartao,
      selfProjectType: ProjectType.PESSOAL,
    });

    const reforma = groups.find((g) => g.type === 'REFORMA');
    const pessoal = groups.find((g) => g.type === 'PESSOAL');
    // REFORMA recebe exatamente a parcela atribuível a ela (6_000).
    expect(reforma).toMatchObject({ total: 6_000, count: 1 });
    // PESSOAL fica com o restante da fatura (9_000 - 6_000 = 3_000): a compra
    // "pessoal" e a "cartão paga cartão" continuam DENTRO da fatura, nunca são
    // somadas de novo (sem colisão/duplicação).
    expect(pessoal).toMatchObject({ total: 3_000 });
    // Soma total = exatamente o valor da fatura, nunca 9_000 + 9_000 (comprasCartao).
    const total = groups.reduce((acc, g) => acc + g.total, 0);
    expect(total).toBe(9_000);
  });

  it('fail-closed: comprasCartao com projetoOrigem.type desconhecido permanece no bucket PESSOAL (não inventa bucket)', () => {
    const fatura = saida({
      id: 'fatura-1',
      valor: 5_000,
      tipoDespesa: 'PAGAMENTO_FATURA_CARTAO',
      isInvoice: true,
      cardLast4: '1111',
      projetoOrigem: null,
    });
    const comprasCartao: AccountViewSaida[] = [
      saida({
        id: 'compra-tipo-desconhecido',
        valor: 5_000,
        cardLast4: '1111',
        tipoDespesa: 'OUTROS',
        projetoOrigem: { id: 'z', name: 'Projeto novo', type: 'TIPO_INEXISTENTE' },
      }),
    ];

    const groups = buildByTypeGroups({
      saidas: [fatura],
      comprasCartao,
      selfProjectType: ProjectType.PESSOAL,
    });

    expect(groups.find((g) => g.type === 'TIPO_INEXISTENTE')).toBeUndefined();
    expect(groups.find((g) => g.type === 'PESSOAL')).toMatchObject({ total: 5_000 });
    const total = groups.reduce((acc, g) => acc + g.total, 0);
    expect(total).toBe(5_000);
  });

  it('Carteira LOCAL (sem cartão/conta, projetoOrigem null) permanece PESSOAL', () => {
    // `localCarteiraThisMonth` (backend) sempre emite `projetoOrigem: null` —
    // cai no bucket self (PESSOAL) pela mesma regra de qualquer saída sem
    // projeto de origem. "Carteira permanece PESSOAL" aqui.
    const groups = buildByTypeGroups({
      saidas: [saida({ id: 'carteira-local', valor: 3_300, projetoOrigem: null })],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    expect(groups.find((g) => g.type === 'PESSOAL')).toMatchObject({ total: 3_300, count: 1 });
  });

  it('Carteira paga despesa de OUTRO projeto: projetoOrigem já é a fonte oficial (mesmo campo usado por porProjetoFiltered/PorProjetoCategoriaView hoje) — bucket segue o tipo real, não vira PESSOAL por ser Carteira', () => {
    // `carteiraPaidThisMonth` (backend) preenche `projetoOrigem` com o projeto
    // REAL da despesa mesmo quando o pagamento saiu da Carteira do PESSOAL —
    // é o MESMO dado que a visão "Por projeto" já expõe hoje (sem mudança de
    // comportamento pré-existente). O invariante O8 (§7.4) é sobre uma fonte
    // DIFERENTE (`classifySource`/`paid-origins.builder.ts`, usada por outra
    // superfície de origem cross-project, fora de escopo aqui) — não sobre
    // este campo, que já é público neste payload.
    const groups = buildByTypeGroups({
      saidas: [
        saida({
          id: 'carteira-estrangeira',
          valor: 4_400,
          projetoOrigem: { id: 'p-reforma', name: 'Obra', type: 'REFORMA' },
        }),
      ],
      comprasCartao: [],
      selfProjectType: ProjectType.PESSOAL,
    });
    expect(groups.find((g) => g.type === 'REFORMA')).toMatchObject({ total: 4_400, count: 1 });
  });

  it('invariante: Σ(groups.total) === soma de saidas elegíveis (isIncludedInSaidaTotal), independente de comprasCartao', () => {
    const saidas: AccountViewSaida[] = [
      saida({ id: 'fatura', valor: 12_345, tipoDespesa: 'PAGAMENTO_FATURA_CARTAO', isInvoice: true, cardLast4: '9999', dueMonth: '2026-07' }),
      saida({ id: 'aporte', valor: 50_000, tipoDespesa: 'INVESTIMENTOS' }),
      saida({ id: 'reforma-direta', valor: 7_777, projetoOrigem: { id: 'p9', name: 'Obra', type: 'REFORMA' } }),
      saida({ id: 'pessoal-direta', valor: 1_111 }),
    ];
    const comprasCartao: AccountViewSaida[] = [
      saida({ id: 'c1', valor: 4_000, cardLast4: '9999', dueMonth: '2026-07', tipoDespesa: 'MATERIAL_CONSTRUCAO', projetoOrigem: { id: 'p9', name: 'Obra', type: 'REFORMA' } }),
      saida({ id: 'c2', valor: 8_345, cardLast4: '9999', dueMonth: '2026-07', tipoDespesa: 'MERCADO', projetoOrigem: null }),
    ];

    const groups = buildByTypeGroups({ saidas, comprasCartao, selfProjectType: ProjectType.PESSOAL });
    const expectedTotal = 12_345 + 7_777 + 1_111; // exclui INVESTIMENTOS
    const actualTotal = groups.reduce((acc, g) => acc + g.total, 0);
    expect(actualTotal).toBe(expectedTotal);
  });
});
