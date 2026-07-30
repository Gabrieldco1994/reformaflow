"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import type { ProjectType, OnboardingFunding } from "@reformaflow/domain";
import { useAuth } from "@/contexts/auth-context";
import {
  SummaryStepPanel,
  hasOperationalSummaryComponent,
} from "@/components/journeys/SummaryStepPanel";
import { getKnownJourneyStepKeys } from "@/lib/journeys/known-step-keys";
import {
  completeJourney,
  getEligibleJourneys,
  getProjectType,
  listJourneyProjects,
  type EligibleJourneyStep,
  type JourneyEligibilityContext,
  type JourneyProject,
  type RuntimeJourney,
  normalizeJourney,
} from "@/lib/journeys/runtime";

interface ActiveJourney {
  journey: RuntimeJourney;
  stepIndex: number;
  projectId?: string;
  // undefined = ainda não buscado (projectId chegou depois, via chooseProject);
  // null = buscado e sem tipo (falhou ou não havia projectId no emit()).
  projectType?: ProjectType | null;
}

interface JourneyRuntimeContextValue {
  active: ActiveJourney | null;
  projects: JourneyProject[];
  loading: boolean;
  error: string | null;
  emit: (context: JourneyEligibilityContext) => Promise<void>;
  emitSignupCompleted: () => Promise<void>;
  emitProjectCreated: (
    projectId: string,
    projectType: JourneyProject["type"],
  ) => Promise<void>;
  next: () => void;
  back: () => void;
  skip: () => void;
  chooseProject: (projectId: string) => void;
  dismiss: () => void;
}

const JourneyRuntimeContext = createContext<JourneyRuntimeContextValue | null>(
  null,
);
const STORAGE_KEY = "lifeone:journey-runtime";

function currentProjectId(pathname: string): string | undefined {
  const match = pathname.match(/^\/projects\/([^/]+)/);
  return match?.[1];
}

function device(): "web" | "mobile" {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches
    ? "mobile"
    : "web";
}

function readStored(): ActiveJourney | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ActiveJourney) : null;
  } catch {
    return null;
  }
}

function writeStored(active: ActiveJourney | null) {
  if (typeof window === "undefined") return;
  if (!active) window.sessionStorage.removeItem(STORAGE_KEY);
  else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(active));
}

export function JourneyRuntimeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading: authLoading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [active, setActive] = useState<ActiveJourney | null>(null);
  const [queue, setQueue] = useState<RuntimeJourney[]>([]);
  const [projects, setProjects] = useState<JourneyProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completedKeys = useRef(new Set<string>());

  // `useLayoutEffect`, não `useState(() => readStored())`: o componente é
  // renderizado no servidor também (client component com SSR), onde
  // `readStored()` sempre é `null` — usar o initializer do `useState` faria o
  // PRIMEIRO render do cliente (hidratação) já ler o sessionStorage real,
  // divergindo do HTML do servidor (`<aside>` presente vs. ausente) e
  // disparando "Hydration failed". `useLayoutEffect` roda síncrono, DEPOIS da
  // hidratação (que já viu `null`, igual ao servidor) e ANTES do browser
  // pintar — restaura a jornada sem o usuário ver o frame vazio.
  useLayoutEffect(() => {
    const stored = readStored();
    if (stored) setActive(stored);
  }, []);

  useEffect(() => {
    writeStored(active);
  }, [active]);

  const emit = useCallback(
    async (context: JourneyEligibilityContext) => {
      if (!user || authLoading || active) return;
      setLoading(true);
      setError(null);
      try {
        const knownStepKeys = getKnownJourneyStepKeys();
        // Dispara junto com a checagem de elegibilidade, não depois dela: o
        // projectId (quando existe) já é conhecido ANTES da resposta de
        // elegibilidade, então esperar essa resposta para só então buscar o
        // tipo do projeto era um segundo round-trip sequencial sem motivo.
        const projectTypePromise = context.projectId
          ? getProjectType(context.projectId).catch(() => null)
          : Promise.resolve(null);
        const [eligible, projectType] = await Promise.all([
          getEligibleJourneys(context),
          projectTypePromise,
        ]);
        const journeys = eligible
          .map((j) => normalizeJourney(j, { knownStepKeys }))
          .filter((journey) => !completedKeys.current.has(journey.key));
        const [journey] = journeys;
        if (journey?.steps.length) {
          if (journey.crossProject) {
            void listJourneyProjects()
              .then(setProjects)
              .catch(() => setProjects([]));
          }
          setActive({
            journey,
            stepIndex: 0,
            projectId: context.projectId,
            projectType,
          });
          setQueue(journeys);
        }
      } catch {
        // The runtime is additive: an unavailable journey API must not break the app.
      } finally {
        setLoading(false);
      }
    },
    [active, authLoading, user],
  );

  const emitSignupCompleted = useCallback(
    () => emit({ triggerType: "SIGNUP_COMPLETED", device: device() }),
    [emit],
  );

  const emitProjectCreated = useCallback(
    (projectId: string, projectType: JourneyProject["type"]) =>
      emit({
        triggerType: "PROJECT_CREATED",
        device: device(),
        projectId,
        projectType,
      }),
    [emit],
  );

  useEffect(() => {
    if (!user || authLoading || !pathname || active) return;
    const projectId = currentProjectId(pathname);
    void emit({
      triggerType: "SCREEN_VISIT",
      device: device(),
      projectId,
      screenKey: pathname.split("/").pop() || undefined,
    });
  }, [active, authLoading, emit, pathname, user]);

  useEffect(() => {
    if (!user || authLoading) return;
    const onAction = (event: MouseEvent) => {
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>("[data-journey-action]")
          : null;
      const actionKey = target?.dataset.journeyAction;
      if (actionKey) {
        void emit({
          triggerType: "ACTION",
          device: device(),
          projectId: currentProjectId(window.location.pathname),
          actionKey,
        });
      }
    };
    document.addEventListener("click", onAction);
    return () => document.removeEventListener("click", onAction);
  }, [authLoading, emit, user]);

  // Navega para a rota real da etapa ATUAL — na ativação (índice 0, inclusive
  // jornada de uma única etapa) e em toda troca de índice/projeto. Navegar de
  // dentro de next() só cobria a transição PARA a próxima etapa: a primeira
  // etapa (ativada direto por emit(), sem passar por next()) e uma jornada de
  // etapa única (nunca chama next() antes de finish()) nunca navegavam.
  useEffect(() => {
    if (!active) return;
    const step = active.journey.steps[active.stepIndex];
    if (step?.experience === "FULL" && step.slug && active.projectId) {
      router.push(`/projects/${active.projectId}/${step.slug}`);
    }
  }, [active?.journey, active?.stepIndex, active?.projectId, router]);

  const finish = useCallback(async () => {
    if (!active) return;
    const completed = active;
    completedKeys.current.add(completed.journey.key);
    const nextJourney = queue[1];
    if (nextJourney) {
      setQueue((current) => current.slice(1));
      setActive({
        journey: nextJourney,
        stepIndex: 0,
        projectId: active.projectId,
      });
    } else {
      setQueue([]);
      setActive(null);
    }
    try {
      await completeJourney(
        completed.journey.journeyId,
        completed.journey.triggerId,
        completed.projectId,
      );
    } catch {
      // Completion is best effort for the overlay; the next eligibility check remains authoritative.
    }
  }, [active, queue]);

  const next = useCallback(() => {
    if (!active) return;
    if (active.stepIndex >= active.journey.steps.length - 1) void finish();
    else setActive({ ...active, stepIndex: active.stepIndex + 1 });
  }, [active, finish]);

  const back = useCallback(() => {
    if (active)
      setActive({ ...active, stepIndex: Math.max(0, active.stepIndex - 1) });
  }, [active]);

  const skip = useCallback(() => {
    if (!active) return;
    const step = active.journey.steps[active.stepIndex];
    if (!step?.skippable) return;
    if (step.blocked) {
      if (active.stepIndex >= active.journey.steps.length - 1) void finish();
      else setActive({ ...active, stepIndex: active.stepIndex + 1 });
      return;
    }
    next();
  }, [active, finish, next]);

  const chooseProject = useCallback(
    (projectId: string) => {
      // `projectType: undefined` marca "ainda não buscado" — o efeito no
      // Overlay busca sob demanda quando o projeto só é escolhido aqui
      // (cross-project), caso em que não dava para paralelizar no emit().
      if (active) setActive({ ...active, projectId, projectType: undefined });
    },
    [active],
  );

  const dismiss = useCallback(() => {
    if (!active) return;
    const step = active.journey.steps[active.stepIndex];
    if (!step?.skippable) return;
    // Sem isto, fechar é no-op no gatilho SCREEN_VISIT: o effect re-roda com
    // `active === null` no MESMO pathname, a API devolve a mesma jornada (ela
    // não foi concluída, e não existe endpoint de dismiss) e o painel reabre.
    // `completedKeys` é a única supressão client-side e vive enquanto a aba
    // vive — exatamente a semântica de `DISMISS_UNTIL_LOGIN`.
    completedKeys.current.add(active.journey.key);
    setQueue([]);
    setActive(null);
  }, [active]);

  const value = useMemo(
    () => ({
      active,
      projects,
      loading,
      error,
      emit,
      emitSignupCompleted,
      emitProjectCreated,
      next,
      back,
      skip,
      chooseProject,
      dismiss,
    }),
    [
      active,
      back,
      chooseProject,
      dismiss,
      emit,
      emitProjectCreated,
      emitSignupCompleted,
      error,
      loading,
      next,
      projects,
      skip,
    ],
  );

  return (
    <JourneyRuntimeContext.Provider value={value}>
      {children}
      <JourneyRuntimeOverlay />
    </JourneyRuntimeContext.Provider>
  );
}

export function useJourneyRuntime() {
  const context = useContext(JourneyRuntimeContext);
  if (!context)
    throw new Error(
      "useJourneyRuntime must be used within JourneyRuntimeProvider",
    );
  return context;
}

function focusPageLandmark() {
  const landmark =
    document.querySelector<HTMLElement>("main") ??
    document.querySelector<HTMLElement>("h1");
  if (!landmark) return;
  // `main`/`h1` não são focáveis por padrão. `tabIndex = -1` os torna alvo
  // programático sem entrar na ordem do Tab — e é a partir dali que o Tab
  // seguinte continua, em vez de reiniciar do topo do documento.
  if (!landmark.hasAttribute("tabindex")) landmark.tabIndex = -1;
  // `preventScroll`: o landmark costuma ser o container rolável da tela
  // (`AppShell`), e focar sem isto joga o usuário de volta pro topo.
  landmark.focus({ preventScroll: true });
}

function JourneyRuntimeOverlay() {
  const runtime = useJourneyRuntime();
  const active = runtime.active;
  const panelRef = useRef<HTMLElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const [activeProjectType, setActiveProjectType] = useState<ProjectType | null>(null);
  // ponytail: transitório — não persistir além da sessão do painel, mesmo
  // rationale do onboarding (`onboarding/setup/page.tsx`): conta/cartão
  // escolhidos numa etapa `funding` alimentam despesa/recebimento seguintes.
  const [funding, setFunding] = useState<OnboardingFunding>({
    bankAccount: null,
    creditCard: null,
  });

  // `JourneyRuntimeProvider` é irmão (não descendente) de qualquer
  // `ProjectProvider` de rota — não dá para usar `useProject()` aqui. Na
  // maioria dos gatilhos, `emit()` já buscou o tipo em paralelo com a
  // elegibilidade (`active.projectType` chega pronto); este efeito só busca
  // sob demanda quando falta (projeto escolhido depois, via `chooseProject`
  // no fluxo cross-project).
  useEffect(() => {
    const projectId = active?.projectId;
    if (!projectId) {
      setActiveProjectType(null);
      return;
    }
    if (active?.projectType !== undefined) {
      setActiveProjectType(active.projectType);
      return;
    }
    let cancelled = false;
    getProjectType(projectId)
      .then((type) => {
        if (!cancelled) setActiveProjectType(type);
      })
      .catch(() => {
        if (!cancelled) setActiveProjectType(null);
      });
    return () => {
      cancelled = true;
    };
  }, [active?.projectId, active?.projectType]);

  // Reseta o `funding` transitório a cada jornada nova (não entre etapas da
  // MESMA jornada — senão a conta escolhida em `funding` se perderia ao
  // avançar para `expense`).
  useEffect(() => {
    setFunding({ bankAccount: null, creditCard: null });
  }, [active?.journey.key]);

  // Foco inicial ao abrir + retorno de foco ao fechar. Só nas bordas
  // aberto<->fechado — não a cada troca de passo dentro da mesma sessão do
  // painel, senão cada "Continuar" rouba o foco do usuário.
  useEffect(() => {
    const isOpen = !!active;
    if (isOpen && !wasOpenRef.current) {
      // `<body>` não é um "gatilho" de verdade — em toque mobile (sem CTA
      // marcado disparando a jornada, ex.: SCREEN_VISIT), frequentemente
      // nada específico está focado quando a jornada abre. Restaurar foco
      // pro body é um no-op silencioso; melhor não guardar nada para
      // restaurar do que guardar um alvo sem sentido.
      const activeEl = document.activeElement;
      previouslyFocusedRef.current =
        activeEl instanceof HTMLElement && activeEl !== document.body
          ? activeEl
          : null;
      panelRef.current?.focus();
    } else if (!isOpen && wasOpenRef.current) {
      // `isConnected`: o alvo pode ter desmontado enquanto a jornada estava
      // ativa (navegação da experiência Completa, re-render da tela real).
      if (previouslyFocusedRef.current?.isConnected) {
        previouslyFocusedRef.current.focus();
      } else {
        // Caminho COMUM (SCREEN_VISIT): a jornada abriu sem clique de gatilho,
        // então não há nada para restaurar — mas o painel levou o foco consigo
        // na abertura. Desmontar sem fallback devolve o foco ao `<body>` e o
        // Tab reinicia do topo. Cai no landmark estável da página.
        focusPageLandmark();
      }
      previouslyFocusedRef.current = null;
    }
    wasOpenRef.current = isOpen;
  }, [active]);

  const currentStep = active?.journey.steps[active.stepIndex];

  // Escape só quando o passo atual é pulável — mesma regra do botão "×"
  // (disabled={!step.skippable}), aplicada aqui porque dismiss() já se
  // protege sozinho contra passo obrigatório.
  useEffect(() => {
    if (!active || !currentStep) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") runtime.dismiss();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, currentStep, runtime]);

  if (!active) return null;
  const step: EligibleJourneyStep | undefined =
    active.journey.steps[active.stepIndex];
  if (!step) return null;

  // A etapa operacional tem as próprias ações de salvar/pular — o rodapé
  // genérico (Voltar/Pular/Continuar) só faz sentido para SUMMARY informativo
  // e para o fallback de texto simples, nunca junto de um formulário real.
  const suppressGenericActions =
    step.experience === "SUMMARY" &&
    !!active.projectId &&
    hasOperationalSummaryComponent(step.stepKey);

  return (
    <aside
      ref={panelRef}
      tabIndex={-1}
      role="dialog"
      data-journey-panel
      aria-modal="false"
      aria-label={`Jornada: ${active.journey.name}`}
      className="fixed inset-x-3 bottom-3 z-[70] mx-auto max-w-lg rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-4 shadow-2xl"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-lifeone-blue">
            Jornada ·{" "}
            <span data-journey-progress>
              {active.stepIndex + 1}/{active.journey.steps.length}
            </span>
          </p>
          <h2
            data-journey-step={step.stepKey}
            data-journey-experience={step.experience}
            className="text-[17px] font-bold text-lifeone-ink"
          >
            {step.label}
          </h2>
        </div>
        <button
          type="button"
          onClick={runtime.dismiss}
          disabled={!step.skippable}
          aria-label="Fechar jornada"
          className="min-h-11 min-w-11 rounded-[10px] text-[20px] text-lifeone-ink-3 disabled:opacity-30"
        >
          ×
        </button>
      </div>

      {step.experience === "FULL" ? (
        <p className="text-[13px] text-lifeone-ink-2">
          Você está na tela real da funcionalidade. Use o painel para continuar
          a jornada.
        </p>
      ) : active.projectId ? (
        <SummaryStepPanel
          step={step}
          projectId={active.projectId}
          projectType={activeProjectType}
          funding={funding}
          onFundingChange={setFunding}
          onDone={() => runtime.next()}
          onSkip={runtime.skip}
          onBack={active.stepIndex > 0 ? runtime.back : undefined}
        />
      ) : (
        // Cross-project sem projeto escolhido ainda (o `ProjectPicker`
        // abaixo resolve isso) — nenhum componente sabe o que renderizar
        // sem um `projectId`, então o texto de apoio puro é o único caminho
        // seguro aqui, igual ao comportamento anterior a esta mudança.
        <p className="text-[13px] text-lifeone-ink-2">{step.subtitle}</p>
      )}
      {step.blocked && (
        <p className="mt-3 text-[13px] text-lifeone-ink-2">
          Esta etapa aguarda uma condição para continuar.
        </p>
      )}

      {active.journey.crossProject && <ProjectPicker runtime={runtime} />}

      {!suppressGenericActions && (
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={runtime.back}
            disabled={active.stepIndex === 0}
            className="min-h-11 rounded-[10px] border border-lifeone-hairline px-3 text-[13px] disabled:opacity-40"
          >
            Voltar
          </button>
          {step.skippable && (
            <button
              type="button"
              onClick={runtime.skip}
              className="min-h-11 rounded-[10px] px-3 text-[13px] text-lifeone-ink-2"
            >
              Pular
            </button>
          )}
          <button
            type="button"
            onClick={runtime.next}
            disabled={step.blocked}
            className="min-h-11 rounded-[10px] bg-lifeone-blue px-4 text-[13px] font-semibold text-white"
          >
            {active.stepIndex === active.journey.steps.length - 1
              ? "Concluir"
              : "Continuar"}
          </button>
        </div>
      )}
    </aside>
  );
}

function ProjectPicker({ runtime }: { runtime: JourneyRuntimeContextValue }) {
  if (runtime.projects.length === 0) {
    return (
      <p className="mt-3 text-[12px] text-[#B42318]">
        Nenhum projeto compatível encontrado. Você pode pular esta etapa.
      </p>
    );
  }
  return (
    <label className="mt-3 block text-[12px] font-semibold text-lifeone-ink-2">
      Escolha o projeto
      <select
        aria-label="Projeto da jornada"
        onChange={(event) => runtime.chooseProject(event.target.value)}
        className="mt-1 min-h-11 w-full rounded-[10px] border border-lifeone-hairline px-3 text-[13px]"
      >
        <option value="">Selecione</option>
        {runtime.projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>
    </label>
  );
}
