import { describe, it, expect } from 'vitest';
import {
  NAV_GROUPS,
  PROJECT_NAV,
  buildNavGroups,
  getProjectNavModules,
  type NavGroupId,
  type NavModule,
} from '../src/config/module-navigator';
import { ProjectType } from '../src/enums';

/**
 * U1 (issue #450) — METADE DE DOMÍNIO: o agrupamento da navegação vira DADO
 * declarado em `PROJECT_NAV`, não uma função hard-coded dentro do componente
 * React (`buildDesktopNavGroups` em `DesktopSidebar.tsx`, com seu literal
 * `projectType !== "PESSOAL"`).
 *
 * O defeito real que este arquivo mata: a função da view montava os grupos a
 * partir de LISTAS FIXAS de slugs e descartava EM SILÊNCIO qualquer slug fora
 * delas. `expenses` e `receipts` existem em `PROJECT_NAV[PESSOAL]` e sumiam do
 * menu desktop sem ninguém notar. Por isso `group` é obrigatório em
 * `NavModule` (opcional deixaria o default implícito e reintroduziria o mesmo
 * descarte) e por isso existe um teste de PARTIÇÃO TOTAL aqui.
 *
 * ─── CONVENÇÃO DE MARCAÇÃO (leia antes de acrescentar teste) ───────────────
 * Cada teste é marcado no próprio nome:
 *
 *   [RED]   = falhava ANTES desta implementação. Prova que o código novo faz
 *             o que promete.
 *   [TRAVA] = já passava antes. NÃO prova nada sobre a implementação nova;
 *             existe só para quebrar se alguém desfizer um invariante já
 *             conquistado. Um teste verde-desde-sempre dá falsa confiança
 *             quando se mistura com os RED sem etiqueta.
 */

// ─── Tabelas esperadas, declaradas como DADO (nunca derivadas do código sob
// teste — senão o teste concorda com qualquer coisa que o código disser) ────

const EXPECTED_PRIMARY_IDS = ['hoje', 'movimentacoes', 'planejamento', 'projetos'];
const EXPECTED_SECONDARY_IDS = ['resultado', 'auditoria', 'modulos'];

const EXPECTED_LABELS: Record<NavGroupId, string> = {
  hoje: 'Hoje',
  movimentacoes: 'Movimentações',
  planejamento: 'Planejamento',
  projetos: 'Projetos',
  resultado: 'Resultado',
  auditoria: 'Auditoria',
  modulos: 'Módulos',
};

/** Mapeamento aprovado pelo PO para PESSOAL: slug -> grupo. */
const EXPECTED_PESSOAL_GROUPS: Record<string, NavGroupId> = {
  monthly: 'hoje',
  conta: 'movimentacoes',
  'credit-cards': 'movimentacoes',
  'bank-accounts': 'movimentacoes',
  expenses: 'movimentacoes',
  receipts: 'movimentacoes',
  recorrentes: 'planejamento',
  metas: 'planejamento',
  planning: 'planejamento',
  planejador: 'planejamento',
  dre: 'resultado',
  'cash-flow': 'auditoria',
  neutros: 'auditoria',
};

/**
 * Tipos que mantêm o comportamento de LISTA ÚNICA. Declarados como dado, de
 * propósito: se o teste precisasse de `if (tipo === PESSOAL)` para saber o que
 * esperar, o desenho teria falhado — o agrupamento tem que estar no dado, não
 * num ramo condicional. A exaustividade desta lista é ela mesma verificada
 * (U1-08b), então um `ProjectType` novo obriga alguém a decidir.
 */
const SINGLE_LIST_TYPES = [
  ProjectType.REFORMA,
  ProjectType.COMPRA,
  ProjectType.CASA,
  ProjectType.CARRO,
  ProjectType.PLANTAS,
];

const idsOfTier = (tier: 'primary' | 'secondary') =>
  NAV_GROUPS.filter((g) => g.tier === tier).map((g) => g.id);

describe('NAV_GROUPS — contrato de ordem e rótulos', () => {
  it('U1-01 [RED] grupos primários na ordem canônica exata', () => {
    expect(idsOfTier('primary')).toEqual(EXPECTED_PRIMARY_IDS);
  });

  it('U1-02 [RED] grupos secundários na ordem canônica exata', () => {
    expect(idsOfTier('secondary')).toEqual(EXPECTED_SECONDARY_IDS);
  });

  it('U1-02b [RED] o array inteiro é primários-depois-secundários, sem intercalar', () => {
    // Sem isto, `tier` poderia estar certo e a ordem do array errada — e é o
    // array que a view percorre.
    expect(NAV_GROUPS.map((g) => g.id)).toEqual([
      ...EXPECTED_PRIMARY_IDS,
      ...EXPECTED_SECONDARY_IDS,
    ]);
  });

  it('U1-03 [RED] rótulos exatos da tabela aprovada', () => {
    expect(Object.fromEntries(NAV_GROUPS.map((g) => [g.id, g.label]))).toEqual(EXPECTED_LABELS);
  });

  it('U1-03b [RED] ids únicos e tier restrito a primary|secondary', () => {
    const ids = NAV_GROUPS.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const g of NAV_GROUPS) {
      expect(['primary', 'secondary']).toContain(g.tier);
      expect(g.label.length).toBeGreaterThan(0);
    }
  });
});

describe('totalidade — todo módulo de todo tipo declara um grupo conhecido', () => {
  it('U1-04 [RED] nenhum NavModule fica sem `group`, em nenhum ProjectType', () => {
    const known = new Set(NAV_GROUPS.map((g) => g.id));
    for (const type of Object.values(ProjectType)) {
      for (const m of PROJECT_NAV[type]) {
        // `toContain` sobre o Set dá mensagem ruim; explicitamos o par para
        // que a falha diga QUAL slug de QUAL tipo está órfão.
        expect({ type, slug: m.slug, group: m.group, known: known.has(m.group) }).toEqual({
          type,
          slug: m.slug,
          group: m.group,
          known: true,
        });
      }
    }
  });
});

describe('mapeamento de PESSOAL', () => {
  it('U1-05 [RED] cada slug de PESSOAL cai no grupo aprovado pelo PO', () => {
    const actual = Object.fromEntries(PROJECT_NAV[ProjectType.PESSOAL].map((m) => [m.slug, m.group]));
    expect(actual).toEqual(EXPECTED_PESSOAL_GROUPS);
    // O `toEqual` acima colapsaria slugs duplicados; o comprimento não deixa.
    expect(PROJECT_NAV[ProjectType.PESSOAL]).toHaveLength(
      Object.keys(EXPECTED_PESSOAL_GROUPS).length,
    );
  });
});

describe('buildNavGroups', () => {
  it('U1-06 [RED] PESSOAL: grupos na ordem canônica, slugs na ordem ORIGINAL do PROJECT_NAV', () => {
    const groups = buildNavGroups(ProjectType.PESSOAL, getProjectNavModules(ProjectType.PESSOAL));
    expect(groups.map((g) => g.id)).toEqual([
      'hoje',
      'movimentacoes',
      'planejamento',
      'resultado',
      'auditoria',
    ]);
    expect(groups.map((g) => g.items.map((i) => i.slug))).toEqual([
      ['monthly'],
      ['conta', 'expenses', 'receipts', 'credit-cards', 'bank-accounts'],
      ['recorrentes', 'metas', 'planning', 'planejador'],
      ['dre'],
      ['neutros', 'cash-flow'],
    ]);
  });

  it('U1-06b [RED] cada grupo emitido carrega label e tier (a view não remonta a tabela)', () => {
    const groups = buildNavGroups(ProjectType.PESSOAL, getProjectNavModules(ProjectType.PESSOAL));
    for (const g of groups) {
      const def = NAV_GROUPS.find((d) => d.id === g.id);
      expect(g.label).toBe(def?.label);
      expect(g.tier).toBe(def?.tier);
    }
  });

  it('U1-07 [RED] partição TOTAL: nenhum módulo visível é descartado, em nenhum tipo', () => {
    for (const type of Object.values(ProjectType)) {
      const visible = getProjectNavModules(type);
      const emitted = buildNavGroups(type, visible).flatMap((g) => g.items.map((i) => i.slug));
      const expectedSlugs = visible.map((m) => m.slug);
      // Conjuntos E comprimentos: só o Set deixaria passar duplicata (o mesmo
      // módulo emitido em dois grupos) e só o comprimento deixaria passar
      // troca de item.
      expect(new Set(emitted)).toEqual(new Set(expectedSlugs));
      expect(emitted).toHaveLength(expectedSlugs.length);
    }
  });

  it('U1-08 [RED] tipos de lista única: tudo em `modulos`, um único grupo, ordem preservada', () => {
    for (const type of SINGLE_LIST_TYPES) {
      expect([...new Set(PROJECT_NAV[type].map((m) => m.group))]).toEqual(['modulos']);
      const groups = buildNavGroups(type, getProjectNavModules(type));
      expect(groups).toHaveLength(1);
      expect(groups[0].id).toBe('modulos');
      expect(groups[0].label).toBe('Módulos');
      expect(groups[0].items.map((i) => i.slug)).toEqual(PROJECT_NAV[type].map((m) => m.slug));
    }
  });

  it('U1-08b [TRAVA — já passa] a lista de tipos de lista única é exaustiva', () => {
    // TRAVA e não RED: só olha `ProjectType` e a tabela do próprio teste, não
    // toca em nada implementado aqui — verde antes e depois. Existe para que
    // um `ProjectType` novo quebre U1-08b e obrigue alguém a DECIDIR o grupo,
    // em vez de o tipo novo escapar calado da cobertura de U1-08.
    expect(new Set([...SINGLE_LIST_TYPES, ProjectType.PESSOAL])).toEqual(
      new Set(Object.values(ProjectType)),
    );
  });

  it('U1-09 [RED] grupo que fica vazio após o filtro de permissão NÃO é emitido', () => {
    // Cabeçalho "Auditoria" sem nenhum link é pior que ausência.
    const semAuditoria = getProjectNavModules(ProjectType.PESSOAL).filter(
      (m) => m.group !== 'auditoria',
    );
    const ids = buildNavGroups(ProjectType.PESSOAL, semAuditoria).map((g) => g.id);
    expect(ids).not.toContain('auditoria');
    expect(ids).toEqual(['hoje', 'movimentacoes', 'planejamento', 'resultado']);
  });

  it('U1-09b [RED] lista vazia devolve [] (nenhum cabeçalho órfão), sem lançar', () => {
    expect(buildNavGroups(ProjectType.PESSOAL, [])).toEqual([]);
  });

  it('U1-10 [RED] `projetos` nunca é emitido: é constante do shell, não vem do PROJECT_NAV', () => {
    // `/projects` é rota global de sessão, sem módulo. Existe em NAV_GROUPS
    // porque o contrato de ORDEM o inclui; quem renderiza é que o insere.
    for (const type of Object.values(ProjectType)) {
      const ids = buildNavGroups(type, getProjectNavModules(type)).map((g) => g.id);
      expect(ids).not.toContain('projetos');
    }
    expect(NAV_GROUPS.map((g) => g.id)).toContain('projetos');
  });

  it('U1-11 [RED] grupo desconhecido em runtime cai em `modulos` — nunca some calado', () => {
    // Este item é montado à mão com `as unknown as NavModule` porque o tipo
    // torna o caso impossível de escrever honestamente. NÃO conclua daqui que
    // existe dado real assim: U1-04 (totalidade) prova o contrário. O que este
    // teste fixa é só o COMPORTAMENTO da rede — se um dia a nav vier da rede e
    // o `group` chegar errado, o item degrada para "Módulos" em vez de sumir.
    // Ver o aviso longo em `resolveNavGroup` antes de mexer aqui.
    const rogue = {
      slug: 'rogue',
      label: 'Rogue',
      iconName: 'Box',
      module: 'dashboard',
      group: 'grupo-que-nao-existe',
    } as unknown as NavModule;
    const groups = buildNavGroups(ProjectType.PESSOAL, [
      ...getProjectNavModules(ProjectType.PESSOAL),
      rogue,
    ]);
    const emitted = groups.flatMap((g) => g.items.map((i) => i.slug));
    expect(emitted).toContain('rogue');
    expect(groups.find((g) => g.items.some((i) => i.slug === 'rogue'))?.id).toBe('modulos');
  });

  it('U1-12 [RED] é pura: não muta a lista recebida nem seus itens', () => {
    const input = getProjectNavModules(ProjectType.PESSOAL);
    const snapshot = JSON.parse(JSON.stringify(input));
    buildNavGroups(ProjectType.PESSOAL, input);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it('U1-13 [RED] tipo desconhecido não lança (mesmo contrato de getProjectNavModules)', () => {
    // @ts-expect-error entrada inválida proposital
    expect(buildNavGroups('NOPE', [])).toEqual([]);
  });
});

describe('regressões travadas (não provam esta implementação)', () => {
  it('REG-01 [TRAVA — já passa] Budget nunca volta ao PROJECT_NAV', () => {
    // Prova APENAS que o item não retorna à lista filtrada por MÓDULO. NÃO prova
    // que a tela é inalcançável — desde #504/#507 ela TEM ponto de entrada
    // deliberado, gateado por PAPEL, fora do PROJECT_NAV. As duas coisas são
    // compatíveis por construção e devem continuar sendo.
    for (const t of Object.values(ProjectType))
      expect(PROJECT_NAV[t].some((m) => m.slug === 'budget-allocation')).toBe(false);
  });

  it('REG-02 [TRAVA — já passa] a ORDEM de PROJECT_NAV[PESSOAL] não muda', () => {
    // Duplica de propósito a asserção de `module-navigator.test.ts`: esta
    // mudança acrescenta um campo a CADA entrada do array, e a tentação de
    // "aproveitar e reordenar por grupo" é grande. A PRIMEIRA linha do array É
    // a home do projeto (`project-home-route.ts` usa `[0].slug`) — reordenar
    // mudaria o destino do card de projeto, do redirect pós-criação e dos
    // redirects legados `.html` do middleware.
    expect(PROJECT_NAV[ProjectType.PESSOAL].map((m) => m.slug)).toEqual([
      'monthly',
      'conta',
      'dre',
      'neutros',
      'expenses',
      'receipts',
      'recorrentes',
      'metas',
      'planning',
      'planejador',
      'cash-flow',
      'credit-cards',
      'bank-accounts',
    ]);
    expect(PROJECT_NAV[ProjectType.PESSOAL][0].slug).toBe('monthly');
  });

  it('U5 — vocabulário unificado de planejamento: labels inequívocos', () => {
    const bySlug = (s: string) =>
      PROJECT_NAV[ProjectType.PESSOAL].find((m) => m.slug === s)!;

    // module-navigator labels (U5 AC-1)
    expect(bySlug('planning').label).toBe('Orçamento futuro');
    expect(bySlug('planejador').label).toBe('Compras e cenários');
  });
});
