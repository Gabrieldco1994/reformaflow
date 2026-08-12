import { buildPaidOrigins } from './paid-origins.builder';

const PESSOAL = { id: 'proj-pessoal', name: 'Pessoal', type: 'PESSOAL' };
const CASA = { id: 'proj-casa', name: 'Casa', type: 'CASA' };
const ADMIN = { role: 'ADMIN', allowedModules: [], projectScope: null };
const FULL_USER = {
  role: 'USER',
  allowedModules: ['expenses', 'creditCards', 'bankAccounts'],
  projectScope: null,
};

function source(over: Partial<any> = {}) {
  return {
    id: 'src-nubank', projectId: PESSOAL.id, projectName: PESSOAL.name, projectType: PESSOAL.type,
    cardLast4: '3541', bankLast4: null, accountId: null, ...over,
  };
}
function card(over: Partial<any> = {}) {
  return {
    id: 'cc-nubank', projectId: PESSOAL.id, last4: '3541', nickname: 'Nubank',
    brand: 'Mastercard', createdAt: new Date('2026-01-01T00:00:00.000Z'), ...over,
  };
}
function input(over: Partial<any> = {}) {
  return {
    settlements: [], rateios: [], links: [], sources: [], cards: [], accounts: [],
    viewer: ADMIN, ...over,
  };
}

describe('buildPaidOrigins — derivação (O3/O4/O5/O12)', () => {
  it('O9/boundary: emite a parcela de índice 0 (não pode ser tratada como falsy)', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank', parcelaIndex: 0 }],
      sources: [source()], cards: [card()],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].parcelas).toEqual([
      { parcelaIndex: 0, origin: expect.objectContaining({ kind: 'card', last4: '3541', nickname: 'Nubank' }) },
    ]);
  });

  it('O5: PROD Infra — o MESMO cartão em 2 parcelas gera 2 entradas em parcelas e 1 em origins', () => {
    const items = buildPaidOrigins(input({
      settlements: [
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank-b', parcelaIndex: 5 },
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank-a', parcelaIndex: 4 },
      ],
      sources: [source({ id: 'src-nubank-a' }), source({ id: 'src-nubank-b' })],
      cards: [card()],
    }));
    expect(items[0].via).toBe('settlement');
    expect(items[0].parcelas.map((p) => p.parcelaIndex)).toEqual([4, 5]); // O12: ordenado asc
    expect(items[0].origins).toHaveLength(1);
    expect(items[0].multiple).toBe(false);
  });

  it('O5/O6: parcelas pagas por cartões DIFERENTES não colapsam e marcam multiple=true', () => {
    const items = buildPaidOrigins(input({
      settlements: [
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank', parcelaIndex: 4 },
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-latam', parcelaIndex: 6 },
      ],
      sources: [source(), source({ id: 'src-latam', cardLast4: '5572' })],
      cards: [card(), card({ id: 'cc-latam', last4: '5572', nickname: 'Latam' })],
    }));
    expect(items[0].parcelas).toHaveLength(2);
    expect(items[0].origins.map((o) => o.last4)).toEqual(['3541', '5572']); // O12: 1ª aparição
    expect(items[0].multiple).toBe(true);
  });

  it('O4: PROD Telhanorte — 1 fonte rateada em 9 alvos gera 9 itens, cada um com a MESMA origem e parcelas vazio', () => {
    const targets = Array.from({ length: 9 }, (_, i) => `tgt-rateio-${i}`);
    const items = buildPaidOrigins(input({
      rateios: targets.map((t) => ({ targetExpenseId: t, sourceExpenseId: 'src-telha' })),
      sources: [source({ id: 'src-telha', cardLast4: '5572' })],
      cards: [card({ id: 'cc-telha', last4: '5572', nickname: 'Latam' })],
    }));
    expect(items).toHaveLength(9);
    expect(items.map((i) => i.expenseId)).toEqual(targets); // O12: ordenado por expenseId
    for (const item of items) {
      expect(item.via).toBe('rateio');
      expect(item.parcelas).toEqual([]);           // O4
      expect(item.origins).toEqual([expect.objectContaining({ last4: '5572', nickname: 'Latam' })]);
      expect(item.multiple).toBe(false);
    }
  });

  it('O3: fonte de settlement que TAMBÉM tem linkedExpenseId no alvo não vira 2ª origem', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank', parcelaIndex: 0 }],
      links: [{ targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank' }], // espelho aponta p/ o alvo
      sources: [source()], cards: [card()],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].via).toBe('settlement');
    expect(items[0].origins).toHaveLength(1);
    expect(items[0].multiple).toBe(false);
  });

  it('O3: rateio tem precedência sobre o link reverso do MESMO alvo (ratearSource seta linkedExpenseId no 1º alvo)', () => {
    const items = buildPaidOrigins(input({
      rateios: [{ targetExpenseId: 'tgt-1', sourceExpenseId: 'src-telha' }],
      links: [{ targetExpenseId: 'tgt-1', sourceExpenseId: 'src-telha' }],
      sources: [source({ id: 'src-telha', cardLast4: '5572' })],
      cards: [card({ id: 'cc-telha', last4: '5572' })],
    }));
    expect(items[0].via).toBe('rateio');
    expect(items[0].origins).toHaveLength(1);
  });

  it('link simples: 1 fonte reversa inequívoca vira via=link agregado', () => {
    const items = buildPaidOrigins(input({
      links: [{ targetExpenseId: 'tgt-obra', sourceExpenseId: 'src-nubank' }],
      sources: [source()], cards: [card()],
    }));
    expect(items[0].via).toBe('link');
    expect(items[0].parcelas).toEqual([]);
    expect(items[0].origins).toHaveLength(1);
  });

  it('link simples AMBÍGUO (2 fontes reversas no mesmo alvo) é OMITIDO por completo', () => {
    const items = buildPaidOrigins(input({
      links: [
        { targetExpenseId: 'tgt-obra', sourceExpenseId: 'src-nubank' },
        { targetExpenseId: 'tgt-obra', sourceExpenseId: 'src-latam' },
      ],
      sources: [source(), source({ id: 'src-latam', cardLast4: '5572' })],
      cards: [card(), card({ id: 'cc-latam', last4: '5572' })],
    }));
    expect(items).toEqual([]);
  });
});

describe('buildPaidOrigins — fonte inativa e carteira (O2/O7/O8)', () => {
  it('O2: settlement cuja fonte NÃO está em sources (soft-deletada) é descartado', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-morta', parcelaIndex: 0 }],
      sources: [], cards: [card()],
    }));
    expect(items).toEqual([]);
  });

  it('O2/O7: fonte morta em UMA parcela não derruba as demais parcelas do MESMO alvo', () => {
    const items = buildPaidOrigins(input({
      settlements: [
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-morta', parcelaIndex: 0 },
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank', parcelaIndex: 1 },
      ],
      sources: [source()], cards: [card()],
    }));
    expect(items).toHaveLength(1);
    expect(items[0].parcelas.map((p) => p.parcelaIndex)).toEqual([1]);
    expect(items[0].origins).toHaveLength(1);
  });

  it('O8/O7: fonte CARTEIRA (sem cartão e sem conta) não emite origem e some de items', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-x', sourceExpenseId: 'src-carteira', parcelaIndex: 0 }],
      sources: [source({ id: 'src-carteira', cardLast4: null, bankLast4: null, accountId: null })],
    }));
    expect(items).toEqual([]);
  });

  it('O7: origins NUNCA é [] em nenhum item retornado', () => {
    const items = buildPaidOrigins(input({
      settlements: [
        { targetExpenseId: 'tgt-a', sourceExpenseId: 'src-carteira', parcelaIndex: 0 },
        { targetExpenseId: 'tgt-b', sourceExpenseId: 'src-nubank', parcelaIndex: 0 },
      ],
      sources: [source(), source({ id: 'src-carteira', cardLast4: null, bankLast4: null })],
      cards: [card()],
    }));
    expect(items.map((i) => i.expenseId)).toEqual(['tgt-b']);
    for (const item of items) expect(item.origins.length).toBeGreaterThan(0);
  });
});

describe('buildPaidOrigins — identidade cartão/conta', () => {
  it('cartão resolvido usa nickname + brand; conta usa nickname + institution', () => {
    const items = buildPaidOrigins(input({
      settlements: [
        { targetExpenseId: 'tgt-a', sourceExpenseId: 'src-nubank', parcelaIndex: 0 },
        { targetExpenseId: 'tgt-b', sourceExpenseId: 'src-conta', parcelaIndex: 0 },
      ],
      sources: [source(), source({ id: 'src-conta', cardLast4: null, bankLast4: '7424', accountId: 'ba-itau' })],
      cards: [card()],
      accounts: [{ id: 'ba-itau', projectId: PESSOAL.id, last4: '7424', nickname: 'Itaú Corrente',
                   institution: 'ITAU', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
    }));
    expect(items.find((i) => i.expenseId === 'tgt-a')!.origins[0]).toEqual({
      kind: 'card', last4: '3541', nickname: 'Nubank', institution: 'Mastercard',
      sourceProjectId: PESSOAL.id, sourceProjectName: 'Pessoal',
    });
    expect(items.find((i) => i.expenseId === 'tgt-b')!.origins[0]).toEqual({
      kind: 'bank', last4: '7424', nickname: 'Itaú Corrente', institution: 'ITAU',
      sourceProjectId: PESSOAL.id, sourceProjectName: 'Pessoal',
    });
  });

  it('BANK-RESOLVE: sem accountId (legado) resolve pelo bankLast4', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-b', sourceExpenseId: 'src-conta', parcelaIndex: 0 }],
      sources: [source({ id: 'src-conta', cardLast4: null, bankLast4: '7424', accountId: null })],
      accounts: [{ id: 'ba-itau', projectId: PESSOAL.id, last4: '7424', nickname: 'Itaú Corrente',
                   institution: 'ITAU', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
    }));
    expect(items[0].origins[0].nickname).toBe('Itaú Corrente');
  });

  it('cartão NÃO resolvível emite nickname null mantendo last4 (UI cai no fallback)', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-a', sourceExpenseId: 'src-nubank', parcelaIndex: 0 }],
      sources: [source()], cards: [],
    }));
    expect(items[0].origins[0]).toMatchObject({ kind: 'card', last4: '3541', nickname: null, institution: null });
  });

  it('CARD-RESOLVE: last4 duplicado no tenant prefere o cartão do MESMO projeto da fonte', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-a', sourceExpenseId: 'src-nubank', parcelaIndex: 0 }],
      sources: [source()],
      cards: [
        card({ id: 'cc-outro', projectId: CASA.id, nickname: 'Nubank da Casa',
               createdAt: new Date('2025-01-01T00:00:00.000Z') }), // mais antigo, outro projeto
        card({ id: 'cc-nubank', projectId: PESSOAL.id, nickname: 'Nubank' }),
      ],
    }));
    expect(items[0].origins[0].nickname).toBe('Nubank');
  });

  it('CARD-RESOLVE: sem cartão no projeto da fonte, desempata por (createdAt asc, id asc)', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-a', sourceExpenseId: 'src-nubank', parcelaIndex: 0 }],
      sources: [source()],
      cards: [
        card({ id: 'cc-b', projectId: CASA.id, nickname: 'B', createdAt: new Date('2026-02-01T00:00:00.000Z') }),
        card({ id: 'cc-a', projectId: CASA.id, nickname: 'A', createdAt: new Date('2026-01-01T00:00:00.000Z') }),
      ],
    }));
    expect(items[0].origins[0].nickname).toBe('A');
  });

  it('parcelaIndex fora do range do alvo é preservado (o read não inventa nem clampa)', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-a', sourceExpenseId: 'src-nubank', parcelaIndex: 99 }],
      sources: [source()], cards: [card()],
    }));
    expect(items[0].parcelas.map((p) => p.parcelaIndex)).toEqual([99]);
  });
});

describe('buildPaidOrigins — redação por acesso (O6/O7/O10)', () => {
  const CARD_ONLY_INPUT = {
    settlements: [{ targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank', parcelaIndex: 0 }],
    sources: [source()], cards: [card()],
  };

  it('O10: usuário SEM módulo creditCards não recebe NENHUM vestígio do cartão', () => {
    const items = buildPaidOrigins(input({
      ...CARD_ONLY_INPUT,
      viewer: { role: 'USER', allowedModules: ['expenses'], projectScope: null },
    }));
    expect(items).toEqual([]);
    const body = JSON.stringify(items);
    expect(body).not.toContain('3541');
    expect(body).not.toContain('Nubank');
  });

  it('O10: usuário SEM módulo bankAccounts não recebe vestígio da conta', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-b', sourceExpenseId: 'src-conta', parcelaIndex: 0 }],
      sources: [source({ id: 'src-conta', cardLast4: null, bankLast4: '7424', accountId: 'ba-itau' })],
      accounts: [{ id: 'ba-itau', projectId: PESSOAL.id, last4: '7424', nickname: 'Itaú Corrente',
                   institution: 'ITAU', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
      viewer: { role: 'USER', allowedModules: ['expenses', 'creditCards'], projectScope: null },
    }));
    expect(items).toEqual([]);
    expect(JSON.stringify(items)).not.toContain('7424');
    expect(JSON.stringify(items)).not.toContain('Itaú');
  });

  it('O10: projectScope que exclui o projeto da fonte redige mesmo COM os módulos', () => {
    const items = buildPaidOrigins(input({
      ...CARD_ONLY_INPUT,
      viewer: { role: 'USER', allowedModules: ['expenses', 'creditCards', 'bankAccounts'],
                projectScope: ['proj-reforma'] },
    }));
    expect(items).toEqual([]);
  });

  it('gate por TIPO do projeto FONTE: fonte em projeto CASA (sem bankAccounts em TYPE_MODULES) é redigida', () => {
    const items = buildPaidOrigins(input({
      settlements: [{ targetExpenseId: 'tgt-b', sourceExpenseId: 'src-casa', parcelaIndex: 0 }],
      sources: [source({ id: 'src-casa', projectId: CASA.id, projectName: 'Casa', projectType: 'CASA',
                         cardLast4: null, bankLast4: '7424', accountId: null })],
      accounts: [{ id: 'ba-x', projectId: CASA.id, last4: '7424', nickname: 'Conta Casa',
                   institution: 'ITAU', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
      viewer: FULL_USER,
    }));
    expect(items).toEqual([]);
  });

  it('ADMIN/OWNER vê tudo sem depender de allowedModules', () => {
    for (const role of ['ADMIN', 'OWNER']) {
      const items = buildPaidOrigins(input({
        ...CARD_ONLY_INPUT,
        viewer: { role, allowedModules: [], projectScope: null },
      }));
      expect(items).toHaveLength(1);
    }
  });

  it('O6/O7: com 2 origens onde só 1 é visível, multiple=false e a redigida some', () => {
    const items = buildPaidOrigins(input({
      settlements: [
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-nubank', parcelaIndex: 0 }, // card
        { targetExpenseId: 'tgt-infra', sourceExpenseId: 'src-conta', parcelaIndex: 1 },  // bank
      ],
      sources: [source(), source({ id: 'src-conta', cardLast4: null, bankLast4: '7424', accountId: 'ba-itau' })],
      cards: [card()],
      accounts: [{ id: 'ba-itau', projectId: PESSOAL.id, last4: '7424', nickname: 'Itaú Corrente',
                   institution: 'ITAU', createdAt: new Date('2026-01-01T00:00:00.000Z') }],
      viewer: { role: 'USER', allowedModules: ['expenses', 'creditCards'], projectScope: null },
    }));
    expect(items[0].parcelas.map((p) => p.parcelaIndex)).toEqual([0]);
    expect(items[0].origins).toHaveLength(1);
    expect(items[0].multiple).toBe(false);
    expect(JSON.stringify(items)).not.toContain('7424');
  });
});
