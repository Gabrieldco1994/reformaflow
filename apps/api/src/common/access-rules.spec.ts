import {
  accessibleProjectTypes,
  projectTypeHasModule,
  resolveAccessibleProjectScope,
  userCanAccessProjectType,
} from './access-rules';

const SEC1_TENANT = 'sec1-tenant';
const SEC1_REFORMA = 'sec1-reforma-project';
const SEC1_PESSOAL = 'sec1-pessoal-project';

type ScopeRow = { id: string; type: string };

const SEC1_ROWS: ScopeRow[] = [
  { id: SEC1_REFORMA, type: 'REFORMA' },
  { id: SEC1_PESSOAL, type: 'PESSOAL' },
];

/**
 * Leitor mínimo de projetos que REGISTRA cada `where` recebido. Serve para
 * provar as duas metades do contrato: o escopo resolvido E que um módulo
 * ausente responde `[]` ANTES de qualquer leitura de projeto/candidato.
 */
function scopeReader(rows: ScopeRow[] = SEC1_ROWS) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    project: {
      async findMany(args: {
        where: Record<string, unknown>;
        select: { id: true };
      }): Promise<Array<{ id: string }>> {
        calls.push(args.where);
        const typeFilter = (args.where.type as { in?: string[] } | undefined)?.in;
        const idFilter = (args.where.id as { in?: string[] } | undefined)?.in;
        return rows
          .filter((row) => (typeFilter ? typeFilter.includes(row.type) : true))
          .filter((row) => (idFilter ? idFilter.includes(row.id) : true))
          .map((row) => ({ id: row.id }));
      },
    },
  };
}

describe('projectTypeHasModule — pendencias gate', () => {
  it('REFORMA has the pendencias module', () => {
    expect(projectTypeHasModule('REFORMA', 'pendencias')).toBe(true);
  });

  describe('userCanAccessProjectType', () => {
    it('denies access when both type and module grants are empty', () => {
      expect(userCanAccessProjectType('USER', [], [], 'PESSOAL')).toBe(false);
      expect(userCanAccessProjectType('USER', undefined, [], 'REFORMA')).toBe(false);
    });

    it('keeps explicit type restriction when allowedProjectTypes is provided', () => {
      expect(
        userCanAccessProjectType('USER', ['PESSOAL'], ['monthlyOverview'], 'PESSOAL'),
      ).toBe(true);
      expect(
        userCanAccessProjectType('USER', ['PESSOAL'], ['monthlyOverview'], 'REFORMA'),
      ).toBe(false);
    });
  });

  describe('accessibleProjectTypes', () => {
    it('returns empty list when both type and module grants are empty', () => {
      expect(accessibleProjectTypes('USER', [], [])).toEqual([]);
    });

    it('derives types from modules when type grant is empty', () => {
      expect(accessibleProjectTypes('USER', [], ['monthlyOverview'])).toEqual([
        'PESSOAL',
      ]);
    });
  });

  it('only REFORMA and PESSOAL have pendencias', () => {
    expect(projectTypeHasModule('PESSOAL', 'pendencias')).toBe(true);
    for (const t of ['COMPRA', 'CASA', 'CARRO', 'PLANTAS']) {
      expect(projectTypeHasModule(t, 'pendencias')).toBe(false);
    }
  });
});

describe('resolveAccessibleProjectScope — recurso exige o módulo do recurso (#480 SEC-1)', () => {
  it('excludes a same-type project when requester owns only an unrelated module', async () => {
    const reader = scopeReader([{ id: SEC1_REFORMA, type: 'REFORMA' }]);

    const expensesScope = await resolveAccessibleProjectScope(
      reader,
      SEC1_TENANT,
      'USER',
      [SEC1_REFORMA],
      ['REFORMA'],
      ['creditCards'],
      'expenses',
    );

    expect(expensesScope).toEqual([]);
    // Módulo ausente responde antes de qualquer leitura de projeto/candidato.
    expect(reader.calls).toEqual([]);

    const cardsScope = await resolveAccessibleProjectScope(
      reader,
      SEC1_TENANT,
      'USER',
      [SEC1_REFORMA],
      ['REFORMA'],
      ['creditCards'],
      'creditCards',
    );

    expect(cardsScope).toEqual([SEC1_REFORMA]);
    expect(reader.calls).toHaveLength(1);
  });

  it('applies expenses, receipts and creditCards independently and preserves OWNER/ADMIN', async () => {
    const ALL_FINANCIAL = ['expenses', 'receipts', 'creditCards', 'bankAccounts'];
    const cases: Array<{
      label: string;
      modules: string[];
      requiredModule: string;
      expected: string[];
    }> = [
      {
        label: 'expenses em REFORMA + PESSOAL',
        modules: ALL_FINANCIAL,
        requiredModule: 'expenses',
        expected: [SEC1_REFORMA, SEC1_PESSOAL],
      },
      {
        label: 'receipts em REFORMA + PESSOAL',
        modules: ALL_FINANCIAL,
        requiredModule: 'receipts',
        expected: [SEC1_REFORMA, SEC1_PESSOAL],
      },
      {
        label: 'creditCards em REFORMA + PESSOAL',
        modules: ALL_FINANCIAL,
        requiredModule: 'creditCards',
        expected: [SEC1_REFORMA, SEC1_PESSOAL],
      },
      {
        // bankAccounts não existe em REFORMA: suporte do TIPO também filtra.
        label: 'bankAccounts só existe em PESSOAL',
        modules: ALL_FINANCIAL,
        requiredModule: 'bankAccounts',
        expected: [SEC1_PESSOAL],
      },
      {
        label: 'creditCards concedido não vale por expenses',
        modules: ['creditCards'],
        requiredModule: 'expenses',
        expected: [],
      },
      {
        label: 'expenses concedido não vale por receipts',
        modules: ['expenses'],
        requiredModule: 'receipts',
        expected: [],
      },
      {
        label: 'receipts concedido não vale por creditCards',
        modules: ['receipts'],
        requiredModule: 'creditCards',
        expected: [],
      },
    ];

    for (const scenario of cases) {
      const reader = scopeReader();
      await expect(
        resolveAccessibleProjectScope(
          reader,
          SEC1_TENANT,
          'USER',
          [SEC1_REFORMA, SEC1_PESSOAL],
          ['REFORMA', 'PESSOAL'],
          scenario.modules,
          scenario.requiredModule,
        ),
      ).resolves.toEqual(scenario.expected);
      if (scenario.expected.length === 0) {
        expect({ label: scenario.label, calls: reader.calls }).toEqual({
          label: scenario.label,
          calls: [],
        });
      }
    }

    for (const role of ['OWNER', 'ADMIN']) {
      for (const requiredModule of ['expenses', 'receipts', 'creditCards']) {
        const reader = scopeReader();
        await expect(
          resolveAccessibleProjectScope(
            reader,
            SEC1_TENANT,
            role,
            [],
            [],
            [],
            requiredModule,
          ),
        ).resolves.toBeNull();
        expect(reader.calls).toEqual([]);
      }
    }
  });

  it('keeps every existing caller unchanged when no module is required', async () => {
    const reader = scopeReader();

    await expect(
      resolveAccessibleProjectScope(
        reader,
        SEC1_TENANT,
        'USER',
        [SEC1_REFORMA, SEC1_PESSOAL],
        ['REFORMA', 'PESSOAL'],
        ['creditCards'],
      ),
    ).resolves.toEqual([SEC1_REFORMA, SEC1_PESSOAL]);
  });
});
