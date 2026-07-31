import { describe, it, expect, beforeEach } from "vitest";
import { ProjectType } from "../src/enums";
import {
  resolveJourneyPlan,
  journeyProgress,
  initialJourneyFlowState,
  advanceJourneyFlow,
  currentJourneyStep,
  type JourneyPlan,
} from "../src/config/journey-plan";
import { JOURNEY_CATALOG, listAllCatalogStepKeys } from "../src/config/journey-catalog";
import { listSummaryCatalogSlugs } from "../src/config/summary-catalog";
import {
  makeJourney,
  makeStep,
  makeSteps,
  makeTrigger,
  resetJourneyBuilderSequence,
} from "../src/testing/journey-builders";

/**
 * Suíte DINÂMICA do motor de plano de Jornada (Etapa D do épico #338).
 *
 * Princípio obrigatório do plano: os testes não codificam quantidade, posição
 * ou nome dos passos de uma jornada publicada. Toda expectativa é derivada da
 * configuração que o próprio teste construiu com os builders — nunca do
 * catálogo default e nunca de um literal como `expect(steps).toHaveLength(4)`
 * sobre uma jornada de produto.
 *
 * Fronteira deliberada: este arquivo cobre o PLANO de passos (quais passos
 * rodam, em que ordem, com que experiência, e como o progresso é calculado).
 * NÃO cobre elegibilidade (quais jornadas disparam) — isso é do
 * `JourneysEligibilityService` na Etapa B, e duplicar a regra aqui criaria um
 * segundo motor.
 */

/** Tamanhos parametrizados: 0, 1, 4, 6 e "muitas", como exigido pelo plano. */
const STEP_COUNTS = [0, 1, 4, 6, 25];

beforeEach(() => {
  resetJourneyBuilderSequence();
});

describe("resolveJourneyPlan — dirigido pela configuração", () => {
  it.each(STEP_COUNTS)(
    "devolve exatamente os passos configurados, na ordem configurada (%i etapas)",
    (count) => {
      const journey = makeJourney({ stepCount: count });

      const plan = resolveJourneyPlan(journey);

      // Denominador e conteúdo vêm da config, não de um número literal.
      expect(plan.total).toBe(journey.steps.length);
      expect(plan.steps.map((s) => s.stepKey)).toEqual(
        [...journey.steps].sort((a, b) => a.order - b.order).map((s) => s.stepKey),
      );
    },
  );

  it("uma jornada de 4 etapas e a MESMA jornada com 6 etapas são consumidas pelo mesmo código", () => {
    const four = resolveJourneyPlan(makeJourney({ stepCount: 4 }));
    const six = resolveJourneyPlan(makeJourney({ stepCount: 6 }));

    // O contrato observável é idêntico; só o tamanho muda — nenhum ramo de
    // código, nenhuma lista fixa, nenhum ajuste de teste entre os dois casos.
    for (const plan of [four, six]) {
      expect(plan.total).toBe(plan.steps.length);
      expect(plan.steps.map((s) => s.position)).toEqual(
        plan.steps.map((_, index) => index + 1),
      );
    }
    expect(six.total).toBeGreaterThan(four.total);
  });

  it("respeita `order` salvo, não a ordem do array (reorder do admin)", () => {
    const journey = makeJourney({
      steps: [
        makeStep({ stepKey: "c", order: 2 }),
        makeStep({ stepKey: "a", order: 0 }),
        makeStep({ stepKey: "b", order: 1 }),
      ],
    });

    const plan = resolveJourneyPlan(journey);

    expect(plan.steps.map((s) => s.stepKey)).toEqual(["a", "b", "c"]);
  });

  it("empate de `order` cai na ordem declarada (determinístico, nunca aleatório)", () => {
    const journey = makeJourney({
      steps: [
        makeStep({ stepKey: "primeiro", order: 3 }),
        makeStep({ stepKey: "segundo", order: 3 }),
      ],
    });

    expect(resolveJourneyPlan(journey).steps.map((s) => s.stepKey)).toEqual([
      "primeiro",
      "segundo",
    ]);
  });

  it("passo desligado sai do plano E do denominador do progresso", () => {
    const journey = makeJourney({
      steps: makeSteps(6, (index) => ({ enabled: index !== 2 })),
    });

    const plan = resolveJourneyPlan(journey);
    const enabledInConfig = journey.steps.filter((s) => s.enabled);

    expect(plan.total).toBe(enabledInConfig.length);
    expect(plan.steps.map((s) => s.stepKey)).toEqual(
      enabledInConfig.map((s) => s.stepKey),
    );
    expect(plan.steps.some((s) => s.stepKey === "step-3")).toBe(false);
  });

  it.each(STEP_COUNTS)(
    "desligar TODOS os passos devolve plano vazio sem lançar (%i etapas)",
    (count) => {
      const journey = makeJourney({
        steps: makeSteps(count, () => ({ enabled: false })),
      });

      const plan = resolveJourneyPlan(journey);

      expect(plan.steps).toEqual([]);
      expect(plan.total).toBe(0);
    },
  );

  it("lê SUMMARY/FULL de cada etapa, sem default por jornada", () => {
    const journey = makeJourney({
      steps: makeSteps(6, (index) => ({
        experience: index % 2 === 0 ? "SUMMARY" : "FULL",
      })),
    });

    const plan = resolveJourneyPlan(journey);

    expect(plan.steps.map((s) => s.experience)).toEqual(
      journey.steps.map((s) => s.experience),
    );
  });

  it.each([
    ["todas resumidas", "SUMMARY" as const],
    ["todas completas", "FULL" as const],
  ])("%s: a experiência vem da etapa, uniformemente", (_label, experience) => {
    const journey = makeJourney({ steps: makeSteps(4, () => ({ experience })) });

    const plan = resolveJourneyPlan(journey);

    expect(plan.steps.every((s) => s.experience === experience)).toBe(true);
  });

  it("obrigatoriedade (`skippable`) é lida da etapa, não do catálogo", () => {
    const journey = makeJourney({
      steps: makeSteps(4, (index) => ({ skippable: index !== 1 })),
    });

    const plan = resolveJourneyPlan(journey);

    expect(plan.steps.map((s) => s.skippable)).toEqual(
      journey.steps.map((s) => s.skippable),
    );
  });
});

// A suíte "condições SKIP/BLOCK" foi removida (não substituída): o modelo
// Prisma `JourneyStep` nunca teve `conditionKey`/`conditionUnmetBehavior`
// (ver `journey-plan.ts` — `PersistedJourneyStep`), então essa suíte testava
// só o fixture (`makeStep` chegou a preencher os três campos à mão) e nunca o
// código de produção. `blocked` continua existindo em `PlannedJourneyStep`,
// fixo em `false` — a suíte de fluxo abaixo ("Pular, Voltar...") cobre o
// consumo desse campo construindo um `JourneyPlan` manualmente.

describe("resolveJourneyPlan — chave desconhecida não derruba a jornada", () => {
  it("passo com `stepKey` órfão é ignorado com aviso diagnosticável, e o resto roda", () => {
    const journey = makeJourney({
      steps: [
        makeStep({ stepKey: "conhecido-a", order: 0 }),
        makeStep({ stepKey: "removido-num-deploy", order: 1 }),
        makeStep({ stepKey: "conhecido-b", order: 2 }),
      ],
    });

    const plan = resolveJourneyPlan(journey, {
      knownStepKeys: ["conhecido-a", "conhecido-b"],
    });

    expect(plan.steps.map((s) => s.stepKey)).toEqual(["conhecido-a", "conhecido-b"]);
    expect(plan.total).toBe(2);
    expect(plan.warnings).toEqual([
      { code: "UNKNOWN_STEP_KEY", stepKey: "removido-num-deploy" },
    ]);
  });

  it("sem `knownStepKeys` o runtime aceita tudo (nenhum aviso espúrio)", () => {
    const journey = makeJourney({ stepCount: 4 });

    const plan = resolveJourneyPlan(journey);

    expect(plan.warnings).toEqual([]);
    expect(plan.total).toBe(journey.steps.length);
  });

  // Etapa E, parte 2 (todo #338, #4 "ATIVAR knownStepKeys"): o web monta
  // `knownStepKeys` unindo `listAllCatalogStepKeys()` (todo stepKey já usado
  // por alguma jornada do catálogo — cobre o bootstrap por construção) +
  // chaves do registry operacional + `listSummaryCatalogSlugs()` (as ~18
  // telas do resumo informativo, novo nesta fatia). Prova aqui, com o
  // catálogo REAL do domínio (não um fixture inventado), que essa união
  // nunca derruba nenhum stepKey do catálogo de onboarding nem os slugs do
  // catálogo de resumos informativos — as duas fontes que a Etapa E, parte 2
  // precisa manter "conhecidas" para não regredir o que já roda em produção.
  it("a união real (catálogo de onboarding + registry + resumos informativos) nunca marca UNKNOWN_STEP_KEY para um stepKey do próprio catálogo", () => {
    const knownStepKeys = [...listAllCatalogStepKeys(), ...listSummaryCatalogSlugs()];

    for (const definition of Object.values(JOURNEY_CATALOG)) {
      const journey = makeJourney({
        steps: definition.steps.map((s, index) =>
          makeStep({ stepKey: s.key, order: index }),
        ),
      });

      const plan = resolveJourneyPlan(journey, { knownStepKeys });

      expect(plan.warnings).toEqual([]);
      expect(plan.total).toBe(definition.steps.length);
    }
  });

  it("um stepKey do catálogo de resumos informativos (ex.: dashboard) é conhecido pela mesma união", () => {
    const knownStepKeys = [...listAllCatalogStepKeys(), ...listSummaryCatalogSlugs()];
    const journey = makeJourney({
      steps: [makeStep({ stepKey: "dashboard", order: 0 })],
    });

    const plan = resolveJourneyPlan(journey, { knownStepKeys });

    expect(plan.warnings).toEqual([]);
    expect(plan.steps.map((s) => s.stepKey)).toEqual(["dashboard"]);
  });
});

// A suíte "cross-project" foi removida (não substituída): `PersistedJourneyStep`
// nunca teve `targetProjectType` por passo persistido no banco, então
// `isCross`/`CROSS_PROJECT_NOT_ALLOWED` nunca disparavam em produção — só o
// fixture (`makeStep`) preenchia o campo. `crossProject`/
// `allowCrossProjectNavigation` (nível de JORNADA) continuam vivos; o teste
// abaixo prova que o alvo (nível de jornada) nunca alterou o PLANO de passos
// — responsabilidade que sempre foi só de `JourneysEligibilityService`.
describe("resolveJourneyPlan — alvo (nível de jornada) não altera o plano de passos", () => {
  it.each([
    ["ALL_PROJECTS" as const, null],
    ["PROJECT_TYPE" as const, ProjectType.CASA],
    ["PROJECT" as const, ProjectType.CASA],
  ])(
    "targetScope %s não altera o plano de passos (alvo é elegibilidade, não plano)",
    (targetScope, targetProjectType) => {
      const steps = makeSteps(4);
      const journey = makeJourney({
        steps,
        targetScope,
        targetProjectType,
        targetProjectId: targetScope === "PROJECT" ? "proj-1" : null,
      });

      const plan = resolveJourneyPlan(journey);

      expect(plan.steps.map((s) => s.stepKey)).toEqual(steps.map((s) => s.stepKey));
    },
  );
});

describe("journeyProgress — sempre posição/total derivados do plano", () => {
  it.each(STEP_COUNTS.filter((n) => n > 0))(
    "percorrer o plano inteiro produz progresso 1..N sem número literal (%i etapas)",
    (count) => {
      const plan = resolveJourneyPlan(makeJourney({ stepCount: count }));

      const ratios = plan.steps.map((_, index) => journeyProgress(plan, index));

      expect(ratios.map((p) => p.position)).toEqual(
        plan.steps.map((_, index) => index + 1),
      );
      expect(ratios.every((p) => p.total === plan.total)).toBe(true);
      expect(ratios[ratios.length - 1].ratio).toBe(1);
    },
  );

  it("passos desligados não inflam o denominador", () => {
    const journey = makeJourney({
      steps: makeSteps(6, (index) => (index >= 4 ? { enabled: false } : {})),
    });

    const plan = resolveJourneyPlan(journey);

    expect(journeyProgress(plan, 0).total).toBe(4);
  });

  it("plano vazio tem progresso 0/0 e ratio 0 (nunca NaN)", () => {
    const plan = resolveJourneyPlan(makeJourney({ stepCount: 0 }));

    const progress = journeyProgress(plan, 0);

    expect(progress).toEqual({ position: 0, total: 0, ratio: 0 });
  });
});

describe("fluxo (Voltar/Continuar/Pular/conclusão) derivado da jornada ativa", () => {
  it.each(STEP_COUNTS.filter((n) => n > 0))(
    "avançar sempre conclui exatamente ao fim do plano configurado (%i etapas)",
    (count) => {
      const plan = resolveJourneyPlan(makeJourney({ stepCount: count }));

      let state = initialJourneyFlowState(plan);
      const visited: string[] = [];

      while (!state.done) {
        visited.push(currentJourneyStep(plan, state)!.stepKey);
        state = advanceJourneyFlow(plan, state, "next");
      }

      expect(visited).toEqual(plan.steps.map((s) => s.stepKey));
      expect(state.done).toBe(true);
    },
  );

  it("jornada sem passos habilitados já nasce concluída (não abre)", () => {
    const plan = resolveJourneyPlan(
      makeJourney({ steps: makeSteps(4, () => ({ enabled: false })) }),
    );

    const state = initialJourneyFlowState(plan);

    expect(state.done).toBe(true);
    expect(currentJourneyStep(plan, state)).toBeNull();
  });

  it("Voltar anda para trás e nunca passa do primeiro passo", () => {
    const plan = resolveJourneyPlan(makeJourney({ stepCount: 4 }));

    let state = advanceJourneyFlow(plan, initialJourneyFlowState(plan), "next");
    state = advanceJourneyFlow(plan, state, "back");
    state = advanceJourneyFlow(plan, state, "back");

    expect(state.index).toBe(0);
    expect(state.done).toBe(false);
  });

  it("Pular só é permitido quando a etapa é pulável", () => {
    const plan = resolveJourneyPlan(
      makeJourney({ steps: makeSteps(3, (index) => ({ skippable: index === 0 })) }),
    );

    const first = initialJourneyFlowState(plan);
    const afterSkip = advanceJourneyFlow(plan, first, "skip");
    expect(afterSkip.index).toBe(1);

    // A segunda etapa é obrigatória: Pular é recusado e o estado não muda.
    expect(advanceJourneyFlow(plan, afterSkip, "skip")).toEqual(afterSkip);
  });

  it("etapa BLOQUEADA e obrigatória segura o Continuar; se for pulável, libera", () => {
    // `blocked` não nasce mais de `resolveJourneyPlan` (nada no plano
    // bloqueia hoje — ver comentário de `PlannedJourneyStep`), mas o campo
    // continua consumido pelo fluxo (`advanceJourneyFlow`) e pelo executor
    // web (`journey-runtime-context.tsx`, frente separada). Construímos o
    // `JourneyPlan` à mão para provar que esse trecho do fluxo — a única
    // parte real que resta do contrato de bloqueio — continua funcionando.
    const makeBlockedPlan = (skippable: boolean): JourneyPlan => ({
      steps: [
        {
          stepKey: "trava",
          order: 0,
          position: 1,
          skippable,
          experience: "FULL",
          label: null,
          subtitle: null,
          blocked: true,
        },
        {
          stepKey: "depois",
          order: 1,
          position: 2,
          skippable: true,
          experience: "FULL",
          label: null,
          subtitle: null,
          blocked: false,
        },
      ],
      total: 2,
      warnings: [],
    });

    const blockedRequired = makeBlockedPlan(false);
    const state = initialJourneyFlowState(blockedRequired);
    expect(advanceJourneyFlow(blockedRequired, state, "next")).toEqual(state);

    const blockedSkippable = makeBlockedPlan(true);
    expect(
      advanceJourneyFlow(blockedSkippable, initialJourneyFlowState(blockedSkippable), "skip")
        .index,
    ).toBe(1);
  });

  it("regressão 4→6: a MESMA execução, sem tocar no código do fluxo, usa a nova config", () => {
    // 1. executa com 4 etapas
    const walk = (steps: ReturnType<typeof makeSteps>) => {
      const plan = resolveJourneyPlan(makeJourney({ steps }));
      let state = initialJourneyFlowState(plan);
      const seen: Array<{ key: string; experience: string; total: number }> = [];
      while (!state.done) {
        const step = currentJourneyStep(plan, state)!;
        seen.push({
          key: step.stepKey,
          experience: step.experience,
          total: journeyProgress(plan, state.index).total,
        });
        state = advanceJourneyFlow(plan, state, "next");
      }
      return seen;
    };

    const before = walk(makeSteps(4));

    // 2. a configuração persistida vira 6 etapas, com uma Resumida e uma Completa
    const after = walk(
      makeSteps(6, (index) => ({
        experience: index === 4 ? "SUMMARY" : index === 5 ? "FULL" : "FULL",
      })),
    );

    // 3. o runtime usa as 6 — nada restaurou a config anterior
    expect(before.length).toBe(4);
    expect(after.length).toBe(6);
    expect(after.every((s) => s.total === 6)).toBe(true);
    expect(after.map((s) => s.experience)).toContain("SUMMARY");
  });
});

describe("builders de fixture", () => {
  it("makeTrigger cobre os 4 tipos de gatilho sem lista duplicada no teste", () => {
    const triggers = (
      ["SIGNUP_COMPLETED", "PROJECT_CREATED", "SCREEN_VISIT", "ACTION"] as const
    ).map((triggerType) =>
      makeTrigger({
        triggerType,
        screenKey: triggerType === "SCREEN_VISIT" ? "monthly" : null,
        actionKey: triggerType === "ACTION" ? "expense.new" : null,
      }),
    );

    expect(triggers.map((t) => t.triggerType)).toEqual([
      "SIGNUP_COMPLETED",
      "PROJECT_CREATED",
      "SCREEN_VISIT",
      "ACTION",
    ]);
    expect(triggers.every((t) => t.active)).toBe(true);
  });

  it.each(["ONCE_PER_USER", "ONCE_PER_PROJECT", "ALWAYS"] as const)(
    "makeJourney aceita a política de repetição %s sem alterar o plano de passos",
    (repeatPolicy) => {
      const steps = makeSteps(4);
      const plan = resolveJourneyPlan(makeJourney({ steps, repeatPolicy }));

      expect(plan.steps.map((s) => s.stepKey)).toEqual(steps.map((s) => s.stepKey));
    },
  );

  it("makeJourney produz chaves únicas entre fixtures (fixtures não colidem)", () => {
    const keys = [makeJourney().key, makeJourney().key, makeJourney().key];

    expect(new Set(keys).size).toBe(keys.length);
  });
});
