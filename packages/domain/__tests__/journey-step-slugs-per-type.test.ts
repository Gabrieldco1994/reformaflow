import { describe, it, expect } from "vitest";
import { ProjectType } from "../src/enums";
import { getProjectNavModules } from "../src/config/module-navigator";
import {
  JOURNEY_CATALOG,
  JOURNEY_STEP_SLUGS,
  JOURNEY_STEP_SLUG_OVERRIDES,
  findInvalidStepSlugs,
  hasJourneyStepSlug,
  onboardingJourneyKey,
  resolveJourneyStepSlug,
} from "../src/config/journey-catalog";

/**
 * Issue #531 — dois defeitos, uma causa.
 *
 * 1. `JOURNEY_STEP_SLUGS` era GLOBAL: o passo `expense` de uma jornada PESSOAL
 *    navegava para `expenses`, uma rota que o U4 (#453/#436) tira do
 *    `PROJECT_NAV[PESSOAL]`. A tela redireciona para `/conta` — o produto se
 *    contradiz (manda para uma URL e entrega outra).
 *
 * 2. `findInvalidStepSlugs()` validava os slugs contra a UNIÃO de todos os
 *    tipos. Como `expenses` sobrevive em REFORMA e COMPRA, a guarda ficava
 *    VERDE enquanto o PESSOAL estava quebrado. Guarda type-agnostic para um
 *    problema per-type — este é o defeito caro: sem ele, a próxima pessoa que
 *    colapsar uma rota repete o defeito com o CI verde.
 *
 * As 4 rotas que o U4 remove de `PROJECT_NAV[PESSOAL]`.
 */
const COLLAPSED_BY_U4 = new Set([
  "expenses",
  "receipts",
  "credit-cards",
  "bank-accounts",
]);

/** `PROJECT_NAV[PESSOAL]` como fica DEPOIS do U4 — cenário injetado, não esperado. */
const PESSOAL_NAV_AFTER_U4 = getProjectNavModules(ProjectType.PESSOAL).filter(
  (m) => !COLLAPSED_BY_U4.has(m.slug),
);

/** Os 4 passos do onboarding PESSOAL que apontavam para rota colapsada. */
const PESSOAL_STEPS_THAT_BOUNCED = [
  "expense",
  "import",
  "expense-import",
  "receipt",
] as const;

describe("findInvalidStepSlugs — guarda per-type (defeito 2)", () => {
  /**
   * O CORAÇÃO do defeito 2, e o motivo de este teste NÃO usar o PESSOAL: com a
   * correção aplicada os passos do PESSOAL apontam para `conta`, que sobrevive
   * ao U4 — o cenário original deixa de ser violação (é o objetivo da PR) e o
   * teste perderia o dente.
   *
   * REFORMA isola o mecanismo puro: tiro `expenses` só do nav de REFORMA. A
   * rota continua viva em COMPRA e PESSOAL, então a guarda ANTIGA (união de
   * todos os tipos) devolve `[]` — exatamente a cegueira medida em produção.
   * Uma guarda per-type acusa.
   */
  it("acusa o tipo quebrado mesmo quando a rota sobrevive em OUTRO tipo", () => {
    const findings = findInvalidStepSlugs({
      nav: {
        [ProjectType.REFORMA]: getProjectNavModules(ProjectType.REFORMA).filter(
          (m) => m.slug !== "expenses",
        ),
      },
    });

    expect(findings).toEqual([
      { type: ProjectType.REFORMA, stepKey: "expense", slug: "expenses" },
    ]);
  });

  /**
   * Prova que o escopo é por tipo e não "qualquer passo contra qualquer tipo":
   * `bill -> bills` só existe no onboarding de CASA, então o PESSOAL (que não
   * tem `bills` no nav) NUNCA pode ser cobrado por ele. Sem este escopo a
   * guarda vira uma máquina de falso-positivo e alguém a desliga.
   */
  it("só cobra de um tipo os passos das jornadas que miram aquele tipo", () => {
    const findings = findInvalidStepSlugs();
    const pessoalStepKeys = new Set(
      JOURNEY_CATALOG[onboardingJourneyKey(ProjectType.PESSOAL)].steps.map(
        (s) => s.key,
      ),
    );

    expect(pessoalStepKeys.has("bill")).toBe(false);
    expect(
      getProjectNavModules(ProjectType.PESSOAL).map((m) => m.slug),
    ).not.toContain("bills");
    expect(findings).toEqual([]);
  });

  /**
   * O teste que libera o U4 para mergear: com o nav JÁ colapsado, o catálogo
   * REAL (com os overrides) fica limpo. É verde por MÉRITO, não por cegueira —
   * o mutation-check remove o override do PESSOAL e este teste fica vermelho.
   */
  it("fica limpo com o nav pós-U4 — os passos do PESSOAL apontam para rota viva", () => {
    expect(
      findInvalidStepSlugs({
        nav: { [ProjectType.PESSOAL]: PESSOAL_NAV_AFTER_U4 },
      }),
    ).toEqual([]);
  });

  /** Um tipo ausente do override cai no `PROJECT_NAV` real, não em lista vazia. */
  it("mescla o override sobre PROJECT_NAV em vez de substituí-lo", () => {
    expect(findInvalidStepSlugs({ nav: {} })).toEqual([]);
    expect(findInvalidStepSlugs({})).toEqual([]);
    expect(findInvalidStepSlugs()).toEqual([]);
  });
});

describe("resolveJourneyStepSlug — destino por tipo de projeto (defeito 1)", () => {
  it("manda os 4 passos do PESSOAL direto para `conta`", () => {
    for (const stepKey of PESSOAL_STEPS_THAT_BOUNCED) {
      expect(
        resolveJourneyStepSlug(stepKey, ProjectType.PESSOAL),
        `passo "${stepKey}" do PESSOAL precisa ir para a tela que de fato atende`,
      ).toBe("conta");
    }
  });

  it("não muda nada nos demais tipos", () => {
    expect(resolveJourneyStepSlug("expense", ProjectType.REFORMA)).toBe(
      "expenses",
    );
    expect(resolveJourneyStepSlug("expense", ProjectType.COMPRA)).toBe(
      "expenses",
    );
    expect(resolveJourneyStepSlug("bill", ProjectType.CASA)).toBe("bills");
    expect(resolveJourneyStepSlug("car", ProjectType.CARRO)).toBe("car-info");
    expect(resolveJourneyStepSlug("plant", ProjectType.PLANTAS)).toBe("plants");
  });

  it("`funding` já apontava para `conta` e continua apontando", () => {
    expect(resolveJourneyStepSlug("funding", ProjectType.PESSOAL)).toBe(
      "conta",
    );
  });

  /**
   * Sem tipo (ex.: `SIGNUP_COMPLETED`, que não tem projeto em contexto) o
   * comportamento é o do mapa base — nunca um `undefined` novo, que faria uma
   * etapa FULL deixar de navegar.
   */
  it("sem tipo, cai no mapa base — não vira undefined", () => {
    expect(resolveJourneyStepSlug("expense")).toBe("expenses");
    expect(resolveJourneyStepSlug("expense", null)).toBe("expenses");
    expect(resolveJourneyStepSlug("funding")).toBe("conta");
  });

  it("passo sem tela própria continua sem tela em qualquer tipo", () => {
    for (const type of Object.values(ProjectType)) {
      expect(resolveJourneyStepSlug("feedback", type)).toBeUndefined();
      expect(resolveJourneyStepSlug("maria-insight", type)).toBeUndefined();
    }
    expect(
      resolveJourneyStepSlug("nao-existe", ProjectType.PESSOAL),
    ).toBeUndefined();
  });
});

describe("invariante do override: redireciona, NUNCA remove", () => {
  /**
   * Esta é a invariante que sustenta a decisão de deixar
   * `hasJourneyStepSlug`/`assertFullExperienceHasSlug` type-agnostic
   * (`journeys-admin.service.ts` NÃO tem como saber o tipo: passos são da
   * jornada, e uma jornada pode ter 0..N triggers mirando tipos diferentes ou
   * nenhum). Enquanto todo override apontar para uma tela REAL, "esse passo
   * tem tela própria?" dá a mesma resposta com e sem tipo.
   *
   * Se alguém um dia quiser um override que APAGUE o slug de um tipo, este
   * teste fica vermelho e força a conversa — em vez de deixar o admin salvar
   * um FULL que não navega para lugar nenhum.
   */
  it("todo stepKey sobrescrito já existe no mapa base e aponta para string não-vazia", () => {
    for (const [type, overrides] of Object.entries(
      JOURNEY_STEP_SLUG_OVERRIDES,
    )) {
      for (const [stepKey, slug] of Object.entries(overrides ?? {})) {
        expect(
          JOURNEY_STEP_SLUGS[stepKey],
          `override ${type}.${stepKey} não pode INTRODUZIR um passo ausente do mapa base`,
        ).toBeDefined();
        expect(
          typeof slug,
          `override ${type}.${stepKey} precisa ser string`,
        ).toBe("string");
        expect((slug ?? "").length).toBeGreaterThan(0);
      }
    }
  });

  it("hasJourneyStepSlug dá a MESMA resposta com e sem tipo, para todo passo do catálogo", () => {
    const allStepKeys = new Set(
      Object.values(JOURNEY_CATALOG).flatMap((j) => j.steps.map((s) => s.key)),
    );
    for (const stepKey of allStepKeys) {
      for (const type of Object.values(ProjectType)) {
        expect(
          resolveJourneyStepSlug(stepKey, type) !== undefined,
          `"${stepKey}" muda de "tem tela" para "não tem tela" no tipo ${type} — ` +
            `isso quebra assertFullExperienceHasSlug, que não sabe o tipo`,
        ).toBe(hasJourneyStepSlug(stepKey));
      }
    }
  });
});
