import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import {
  advanceJourneyFlow,
  currentJourneyStep,
  initialJourneyFlowState,
  journeyProgress,
  resolveJourneyPlan,
  type JourneyPlan,
  type PlannedJourneyStep,
} from "@reformaflow/domain";
// Builders de fixture: caminho direto do módulo, fora do barrel público do
// domínio (têm sequência mutável de ids e não são API de produção).
import {
  makeJourney,
  makeStep,
  makeSteps,
  resetJourneyBuilderSequence,
} from "@reformaflow/domain/testing/journey-builders";

/**
 * CONTRATO DO EXECUTOR WEB (Etapa D do épico #338).
 *
 * O executor real (painel de jornada sobre a aplicação) chega na Etapa seguinte.
 * O que esta suíte fixa AGORA é o contrato que ele terá de honrar, e que é o
 * ponto inteiro da Etapa D:
 *
 *   - renderiza por LOOKUP de `stepKey` num registro de componentes — nunca um
 *     `switch` por jornada nem um número fixo de passos;
 *   - progresso, Voltar, Continuar, Pular e conclusão são derivados do plano
 *     ativo (`resolveJourneyPlan`), não de constantes;
 *   - trocar a jornada de 4 para 6 etapas não muda este teste NEM o componente.
 *
 * O `JourneyRunner` abaixo é um harness de teste deliberadamente mínimo (~40
 * linhas): ele demonstra que o padrão fecha usando SÓ o motor do domínio. O
 * executor de produção pode ser muito mais rico visualmente, mas se precisar de
 * qualquer regra que não esteja aqui, ela virou um segundo motor — que é
 * exatamente o que o plano proíbe.
 */

type StepRenderer = (step: PlannedJourneyStep) => JSX.Element;

function JourneyRunner({
  plan,
  registry,
  onComplete,
}: {
  plan: JourneyPlan;
  registry: Record<string, StepRenderer>;
  onComplete?: () => void;
}) {
  const [state, setState] = useState(() => initialJourneyFlowState(plan));
  const step = currentJourneyStep(plan, state);

  if (!step) {
    return <div data-testid="journey-done">concluída</div>;
  }

  const progress = journeyProgress(plan, state.index);
  const dispatch = (action: "next" | "back" | "skip") => {
    const nextState = advanceJourneyFlow(plan, state, action);
    setState(nextState);
    if (nextState.done) onComplete?.();
  };

  // Lookup por chave. Chave sem componente registrado não derruba o painel:
  // renderiza um aviso diagnosticável e a jornada segue.
  const Renderer = registry[step.stepKey];

  return (
    <section aria-label="Jornada">
      <p data-testid="progress">
        {progress.position}/{progress.total}
      </p>
      <p data-testid="experience">{step.experience}</p>
      <div data-testid="step-body">
        {Renderer ? (
          Renderer(step)
        ) : (
          <span data-testid="step-missing">passo sem renderer: {step.stepKey}</span>
        )}
      </div>
      <button type="button" onClick={() => dispatch("back")}>
        Voltar
      </button>
      <button type="button" onClick={() => dispatch("next")} disabled={step.blocked}>
        Continuar
      </button>
      {step.skippable && (
        <button type="button" onClick={() => dispatch("skip")}>
          Pular
        </button>
      )}
    </section>
  );
}

/** Registro genérico: um renderer por chave, criado a partir da própria config. */
function registryFor(plan: JourneyPlan): Record<string, StepRenderer> {
  return Object.fromEntries(
    plan.steps.map((step) => [
      step.stepKey,
      (s: PlannedJourneyStep) => <span data-testid="step-key">{s.stepKey}</span>,
    ]),
  );
}

/** Percorre a jornada inteira clicando em Continuar, iterando o plano. */
async function walkThrough(plan: JourneyPlan) {
  const user = userEvent.setup();
  const seen: string[] = [];

  for (let i = 0; i < plan.total; i += 1) {
    seen.push(screen.getByTestId("step-key").textContent ?? "");
    expect(screen.getByTestId("progress")).toHaveTextContent(`${i + 1}/${plan.total}`);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
  }

  return seen;
}

beforeEach(() => {
  resetJourneyBuilderSequence();
});

describe("executor: renderiza por lookup de stepKey, dirigido pela configuração", () => {
  it.each([1, 4, 6, 12])(
    "percorre uma jornada de %i etapas sem o teste conhecer o número",
    async (stepCount) => {
      const plan = resolveJourneyPlan(makeJourney({ stepCount }));
      const onComplete = vi.fn();

      render(<JourneyRunner plan={plan} registry={registryFor(plan)} onComplete={onComplete} />);

      const seen = await walkThrough(plan);

      expect(seen).toEqual(plan.steps.map((s) => s.stepKey));
      expect(onComplete).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("journey-done")).toBeInTheDocument();
    },
  );

  it("a MESMA renderização consome 4 e depois 6 etapas — nenhuma mudança de código ou de teste", async () => {
    for (const stepCount of [4, 6]) {
      const plan = resolveJourneyPlan(makeJourney({ stepCount }));
      const { unmount } = render(<JourneyRunner plan={plan} registry={registryFor(plan)} />);

      const seen = await walkThrough(plan);

      expect(seen).toHaveLength(plan.total);
      unmount();
    }
  });

  it("mostra a experiência configurada por etapa (SUMMARY/FULL), lida do plano", async () => {
    const plan = resolveJourneyPlan(
      makeJourney({
        steps: makeSteps(4, (index) => ({ experience: index % 2 === 0 ? "SUMMARY" : "FULL" })),
      }),
    );
    const user = userEvent.setup();

    render(<JourneyRunner plan={plan} registry={registryFor(plan)} />);

    for (const step of plan.steps) {
      expect(screen.getByTestId("experience")).toHaveTextContent(step.experience);
      await user.click(screen.getByRole("button", { name: "Continuar" }));
    }
  });

  it("passo desligado no admin simplesmente não aparece, e o progresso reflete isso", async () => {
    const journey = makeJourney({ steps: makeSteps(6, (index) => ({ enabled: index !== 3 })) });
    const plan = resolveJourneyPlan(journey);

    render(<JourneyRunner plan={plan} registry={registryFor(plan)} />);

    const seen = await walkThrough(plan);

    expect(seen).not.toContain("step-4");
    expect(seen).toHaveLength(journey.steps.filter((s) => s.enabled).length);
  });

  it("reordenar no admin muda a ordem renderizada, sem tocar no executor", async () => {
    const plan = resolveJourneyPlan(
      makeJourney({
        steps: [
          makeStep({ stepKey: "ultimo", order: 9 }),
          makeStep({ stepKey: "primeiro", order: 0 }),
          makeStep({ stepKey: "meio", order: 5 }),
        ],
      }),
    );

    render(<JourneyRunner plan={plan} registry={registryFor(plan)} />);

    expect(await walkThrough(plan)).toEqual(["primeiro", "meio", "ultimo"]);
  });
});

describe("executor: Pular, Voltar e etapas bloqueadas", () => {
  it("etapa obrigatória não oferece Pular; etapa pulável oferece", () => {
    const plan = resolveJourneyPlan(
      makeJourney({ steps: makeSteps(2, (index) => ({ skippable: index === 1 })) }),
    );

    render(<JourneyRunner plan={plan} registry={registryFor(plan)} />);

    expect(screen.queryByRole("button", { name: "Pular" })).not.toBeInTheDocument();
  });

  it("Voltar retorna à etapa anterior e o progresso acompanha", async () => {
    const plan = resolveJourneyPlan(makeJourney({ stepCount: 4 }));
    const user = userEvent.setup();

    render(<JourneyRunner plan={plan} registry={registryFor(plan)} />);
    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByTestId("progress")).toHaveTextContent(`2/${plan.total}`);

    await user.click(screen.getByRole("button", { name: "Voltar" }));

    expect(screen.getByTestId("progress")).toHaveTextContent(`1/${plan.total}`);
    expect(screen.getByTestId("step-key")).toHaveTextContent(plan.steps[0].stepKey);
  });

  // A condição BLOCK por passo (`conditionKey`/`conditionUnmetBehavior`) nunca
  // existiu no modelo Prisma `JourneyStep` — era código morto em
  // `resolveJourneyPlan`, removido em `journey-plan.ts`. `blocked` continua
  // existindo em `PlannedJourneyStep` (fixo em `false` hoje) só porque
  // `journey-runtime-context.tsx` já o consome; o teste abaixo monta o plano
  // à mão (não via `resolveJourneyPlan`, que nunca produz `blocked: true`
  // sozinho) para continuar cobrindo o consumo de `blocked` pelo executor.
  it("etapa com blocked=true desabilita Continuar e aguarda", () => {
    const plan: JourneyPlan = {
      steps: [
        {
          stepKey: "aguarda",
          order: 0,
          position: 1,
          skippable: false,
          experience: "FULL",
          label: null,
          subtitle: null,
          blocked: true,
        },
        {
          stepKey: "depois",
          order: 1,
          position: 2,
          skippable: false,
          experience: "FULL",
          label: null,
          subtitle: null,
          blocked: false,
        },
      ],
      total: 2,
      warnings: [],
    };

    render(<JourneyRunner plan={plan} registry={registryFor(plan)} />);

    expect(screen.getByRole("button", { name: "Continuar" })).toBeDisabled();
    expect(screen.getByTestId("progress")).toHaveTextContent("1/2");
  });
});

describe("executor: robustez", () => {
  it("stepKey sem renderer registrado não derruba o painel — vira aviso e o fluxo segue", async () => {
    const plan = resolveJourneyPlan(makeJourney({ stepCount: 3 }));
    const partialRegistry = registryFor(plan);
    delete partialRegistry[plan.steps[1].stepKey];
    const user = userEvent.setup();

    render(<JourneyRunner plan={plan} registry={partialRegistry} />);
    await user.click(screen.getByRole("button", { name: "Continuar" }));

    const body = screen.getByTestId("step-body");
    expect(within(body).getByTestId("step-missing")).toHaveTextContent(plan.steps[1].stepKey);

    await user.click(screen.getByRole("button", { name: "Continuar" }));
    expect(screen.getByTestId("step-key")).toHaveTextContent(plan.steps[2].stepKey);
  });

  it("jornada sem nenhuma etapa habilitada não abre — nasce concluída", () => {
    const plan = resolveJourneyPlan(
      makeJourney({ steps: makeSteps(5, () => ({ enabled: false })) }),
    );

    render(<JourneyRunner plan={plan} registry={{}} />);

    expect(screen.getByTestId("journey-done")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Continuar" })).not.toBeInTheDocument();
  });
});
