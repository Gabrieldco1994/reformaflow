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
import { ProjectType, type OnboardingFunding } from "@reformaflow/domain";
import { toast } from "sonner";
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

/**
 * A fila carrega o projeto de CADA jornada, não só a jornada. Um cadastro com
 * vários objetivos cria um projeto por tipo e cada um tem a sua jornada de
 * onboarding — sem isso a segunda jornada herdava o projectId da primeira e
 * abria no projeto errado.
 */
interface QueuedJourney {
  journey: RuntimeJourney;
  projectId?: string;
  projectType?: ProjectType | null;
}

interface JourneySnapshotOwner {
  userId: string;
  tenantId: string;
}

interface JourneySnapshot {
  owner: JourneySnapshotOwner;
  active: ActiveJourney;
  /** Só as jornadas seguintes; a ativa já está armazenada acima. */
  queue: QueuedJourney[];
}

interface JourneyRuntimeContextValue {
  active: ActiveJourney | null;
  projects: JourneyProject[];
  loading: boolean;
  error: string | null;
  emit: (context: JourneyEligibilityContext) => Promise<void>;
  emitSignupCompleted: () => Promise<void>;
  emitProjectsCreated: (
    projects: Array<{ id: string; type: JourneyProject["type"] }>,
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

function currentScreenKey(pathname: string): string | undefined {
  const segments = pathname.split("/").filter(Boolean);
  return segments[segments.length - 1];
}

function device(): "web" | "mobile" {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(max-width: 767px)").matches
    ? "mobile"
    : "web";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const PROJECT_TYPE_VALUES = new Set<string>(Object.values(ProjectType));

function isProjectType(value: unknown): value is ProjectType {
  return typeof value === "string" && PROJECT_TYPE_VALUES.has(value);
}

function isEligibleJourneyStep(value: unknown): value is EligibleJourneyStep {
  return (
    isRecord(value) &&
    typeof value.stepKey === "string" &&
    value.stepKey.length > 0 &&
    typeof value.order === "number" &&
    Number.isInteger(value.order) &&
    value.order >= 0 &&
    (value.experience === "SUMMARY" || value.experience === "FULL") &&
    typeof value.label === "string" &&
    (value.subtitle === null || typeof value.subtitle === "string") &&
    typeof value.skippable === "boolean" &&
    (value.enabled === undefined || typeof value.enabled === "boolean") &&
    (value.blocked === undefined || typeof value.blocked === "boolean") &&
    (value.slug === undefined || typeof value.slug === "string")
  );
}

function isRuntimeJourney(value: unknown): value is RuntimeJourney {
  return (
    isRecord(value) &&
    typeof value.journeyId === "string" &&
    typeof value.key === "string" &&
    typeof value.name === "string" &&
    typeof value.triggerId === "string" &&
    typeof value.repeatPolicy === "string" &&
    typeof value.dismissPolicy === "string" &&
    typeof value.crossProject === "boolean" &&
    Array.isArray(value.steps) &&
    value.steps.length > 0 &&
    value.steps.every(isEligibleJourneyStep)
  );
}

function hasValidProjectContext(value: Record<string, unknown>): boolean {
  return (
    (value.projectId === undefined || typeof value.projectId === "string") &&
    (value.projectType === undefined ||
      value.projectType === null ||
      isProjectType(value.projectType))
  );
}

function isActiveJourney(value: unknown): value is ActiveJourney {
  if (
    !isRecord(value) ||
    !isRuntimeJourney(value.journey) ||
    typeof value.stepIndex !== "number" ||
    !Number.isInteger(value.stepIndex) ||
    !hasValidProjectContext(value)
  ) {
    return false;
  }
  return value.stepIndex >= 0 && value.stepIndex < value.journey.steps.length;
}

function isQueuedJourney(value: unknown): value is QueuedJourney {
  return (
    isRecord(value) &&
    isRuntimeJourney(value.journey) &&
    hasValidProjectContext(value)
  );
}

function journeyInstanceKey(entry: {
  journey: Pick<RuntimeJourney, "key">;
  projectId?: string;
}): string {
  return JSON.stringify([entry.journey.key, entry.projectId ?? null]);
}

function isJourneySnapshot(value: unknown): value is JourneySnapshot {
  if (
    !isRecord(value) ||
    !isRecord(value.owner) ||
    typeof value.owner.userId !== "string" ||
    value.owner.userId.length === 0 ||
    typeof value.owner.tenantId !== "string" ||
    value.owner.tenantId.length === 0 ||
    !isActiveJourney(value.active) ||
    !Array.isArray(value.queue) ||
    !value.queue.every(isQueuedJourney)
  ) {
    return false;
  }

  const seen = new Set([journeyInstanceKey(value.active)]);
  for (const queued of value.queue) {
    const key = journeyInstanceKey(queued);
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function readStored(): JourneySnapshot | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isJourneySnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(snapshot: JourneySnapshot | null) {
  if (typeof window === "undefined") return;
  if (!snapshot) window.sessionStorage.removeItem(STORAGE_KEY);
  else window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
}

function snapshotOwnerKey(owner: JourneySnapshotOwner): string {
  return JSON.stringify([owner.userId, owner.tenantId]);
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
  const [restoredOwner, setRestoredOwner] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueuedJourney[]>([]);
  const [projects, setProjects] = useState<JourneyProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const completedKeys = useRef(new Set<string>());
  const emittedScreenVisit = useRef<string | null>(null);
  const pendingEmit = useRef<JourneyEligibilityContext[] | null>(null);
  const runtimeOwner = useRef<string | null>(null);
  const eligibilityGeneration = useRef(0);
  const projectListGeneration = useRef(0);
  const currentUserId = user?.id;
  const currentTenantId = user?.tenantId;
  const currentOwner =
    currentUserId && currentTenantId
      ? snapshotOwnerKey({
          userId: currentUserId,
          tenantId: currentTenantId,
        })
      : null;
  const restored = !!currentOwner && restoredOwner === currentOwner;

  // A hidratação precisa terminar antes de ler a sessão autenticada. Quando a
  // identidade resolve, o layout effect restaura antes dos effects passivos
  // (persistência e SCREEN_VISIT), sem divergir do HTML produzido no servidor.
  useLayoutEffect(() => {
    if (authLoading) return;
    const previousOwner = runtimeOwner.current;
    runtimeOwner.current = currentOwner;
    eligibilityGeneration.current += 1;
    projectListGeneration.current += 1;

    setActive(null);
    setQueue([]);
    setProjects([]);
    setLoading(false);
    setError(null);
    completedKeys.current.clear();
    emittedScreenVisit.current = null;

    if (!currentUserId || !currentTenantId || !currentOwner) {
      pendingEmit.current = null;
      writeStored(null);
      setRestoredOwner(null);
      return;
    }

    // Troca direta de conta não pode carregar um gatilho pendente da anterior.
    // No primeiro login, porém, preserva PROJECT_CREATED emitido pelo cadastro.
    if (previousOwner && previousOwner !== currentOwner) {
      pendingEmit.current = null;
    }

    const stored = readStored();
    const belongsToUser =
      stored?.owner.userId === currentUserId &&
      stored.owner.tenantId === currentTenantId;
    if (!stored || !belongsToUser) {
      writeStored(null);
      setRestoredOwner(currentOwner);
      return;
    }

    setActive(stored.active);
    setQueue(stored.queue);
    setRestoredOwner(currentOwner);
  }, [authLoading, currentOwner, currentTenantId, currentUserId]);

  useEffect(() => {
    if (!restored || !currentUserId || !currentTenantId) return;
    writeStored(
      active
        ? {
            owner: {
              userId: currentUserId,
              tenantId: currentTenantId,
            },
            active,
            queue,
          }
        : null,
    );
  }, [active, currentTenantId, currentUserId, queue, restored]);

  const activeProjectContext = active
    ? JSON.stringify([
        active.journey.journeyId,
        active.journey.triggerId,
        active.journey.key,
      ])
    : null;
  const activeCrossProject = active?.journey.crossProject === true;

  // Uma única fonte para projetos cross-project: restauração, primeira
  // ativação e promoção da fila passam por esta mesma troca de `active`.
  useEffect(() => {
    const requestGeneration = ++projectListGeneration.current;
    setProjects([]);
    if (!restored || !currentOwner || !activeCrossProject) return;
    const requestOwner = currentOwner;
    const isCurrentRequest = () =>
      runtimeOwner.current === requestOwner &&
      projectListGeneration.current === requestGeneration;

    void listJourneyProjects()
      .then((items) => {
        if (isCurrentRequest()) setProjects(items);
      })
      .catch(() => {
        if (isCurrentRequest()) setProjects([]);
      });
  }, [activeCrossProject, activeProjectContext, currentOwner, restored]);

  // Gatilho emitido ANTES de a autenticação resolver não pode ser descartado:
  // no cadastro, `emit` é chamado de dentro de um `handleSubmit` cujo closure
  // ainda enxerga `user === null` (o `setUser` do `register()` só chega no
  // render seguinte), então a jornada de onboarding morria em silêncio — sem
  // nem uma requisição. Guardamos o contexto e reemitimos quando o usuário
  // aparece, o que preserva "nunca disparar sem usuário autenticado" sem
  // perder o gatilho.
  const emitMany = useCallback(
    async (contexts: JourneyEligibilityContext[]) => {
      if (active || contexts.length === 0) return;
      if (!user || authLoading || !currentOwner) {
        pendingEmit.current = contexts;
        return;
      }
      const requestOwner = currentOwner;
      const requestGeneration = ++eligibilityGeneration.current;
      const isCurrentRequest = () =>
        runtimeOwner.current === requestOwner &&
        eligibilityGeneration.current === requestGeneration;
      pendingEmit.current = null;
      setLoading(true);
      setError(null);
      try {
        const knownStepKeys = getKnownJourneyStepKeys();
        // Um gatilho por projeto, todos em paralelo: o cadastro com N objetivos
        // cria N projetos e cada tipo tem a sua jornada.
        const perContext = await Promise.all(
          contexts.map(async (context) => {
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
            return eligible.map((j) => ({
              journey: normalizeJourney(j, { knownStepKeys }),
              projectId: context.projectId,
              projectType,
            }));
          }),
        );
        if (!isCurrentRequest()) return;

        const seen = new Set<string>();
        const entries: QueuedJourney[] = [];
        for (const entry of perContext.flat()) {
          if (!entry.journey.steps.length) continue;
          if (completedKeys.current.has(entry.journey.key)) continue;
          // Chave por jornada E projeto: dois projetos do mesmo tipo têm cada
          // um a sua jornada (repeatPolicy é ONCE_PER_PROJECT).
          const dedupeKey = journeyInstanceKey(entry);
          if (seen.has(dedupeKey)) continue;
          seen.add(dedupeKey);
          entries.push(entry);
        }

        const [first] = entries;
        if (first) {
          setActive({
            journey: first.journey,
            stepIndex: 0,
            projectId: first.projectId,
            projectType: first.projectType,
          });
          setQueue(entries.slice(1));
        }
      } catch (cause) {
        if (!isCurrentRequest()) return;
        const message =
          cause instanceof Error
            ? cause.message
            : "Não foi possível carregar a jornada.";
        setError(message);
        toast.error(message);
      } finally {
        if (isCurrentRequest()) setLoading(false);
      }
    },
    [active, authLoading, currentOwner, user],
  );

  const emit = useCallback(
    (context: JourneyEligibilityContext) => emitMany([context]),
    [emitMany],
  );

  const emitSignupCompleted = useCallback(
    () => emit({ triggerType: "SIGNUP_COMPLETED", device: device() }),
    [emit],
  );

  const emitProjectsCreated = useCallback(
    (projects: Array<{ id: string; type: JourneyProject["type"] }>) =>
      emitMany(
        projects.map((project) => ({
          triggerType: "PROJECT_CREATED",
          device: device(),
          projectId: project.id,
          projectType: project.type,
        })),
      ),
    [emitMany],
  );

  // Drena o gatilho que chegou cedo demais, assim que a autenticação resolve.
  useEffect(() => {
    const pending = pendingEmit.current;
    if (!pending || !user || authLoading || active) return;
    void emitMany(pending);
  }, [active, authLoading, emitMany, user]);

  useEffect(() => {
    if (!restored || authLoading) return;
    if (!user) {
      emittedScreenVisit.current = null;
      return;
    }
    if (!pathname || active) return;
    const projectId = currentProjectId(pathname);
    const screenKey = currentScreenKey(pathname);
    if (!screenKey) return;
    const visitKey = `${user.id}:${pathname}`;
    // O Strict Mode pode concluir duas leituras de /auth/me com objetos
    // equivalentes enquanto a primeira elegibilidade ainda está em voo.
    // Marcar antes do await garante um único SCREEN_VISIT por navegação.
    if (emittedScreenVisit.current === visitKey) return;
    emittedScreenVisit.current = visitKey;
    void emit({
      triggerType: "SCREEN_VISIT",
      device: device(),
      projectId,
      screenKey,
    });
  }, [active, authLoading, emit, pathname, restored, user]);

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
    const [nextJourney] = queue;
    if (nextJourney) {
      setQueue((current) => current.slice(1));
      setActive({
        journey: nextJourney.journey,
        stepIndex: 0,
        projectId: nextJourney.projectId,
        projectType: nextJourney.projectType,
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
    // Uma navegação posterior pode devolver a mesma jornada (ela não foi
    // concluída, e não existe endpoint de dismiss). `completedKeys` é a
    // supressão client-side que vive enquanto a aba vive — exatamente a
    // semântica de `DISMISS_UNTIL_LOGIN`.
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
      emitProjectsCreated,
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
      emitProjectsCreated,
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
      if (
        event.key === "Escape" &&
        !document.body.hasAttribute("data-overlay-open")
      ) {
        runtime.dismiss();
      }
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
      className="fixed inset-x-3 bottom-[calc(0.75rem+var(--rf-bottom-chrome,0px))] z-[70] mx-auto flex max-h-[calc(100dvh-var(--rf-bottom-chrome,0px)-5rem)] max-w-lg flex-col rounded-[18px] border border-lifeone-hairline bg-lifeone-card p-4 shadow-2xl"
    >
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
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

      {/*
        Área rolável do painel.

        Ao ceder os 144px do chrome inferior o painel perde altura útil, e um
        passo com rótulo/subtítulo longos estouraria. Rolar preserva o texto
        inteiro — cortar, não. As AÇÕES ficam FORA deste contêiner: se
        rolassem junto, trocaríamos "painel tapa o botão do app" por "painel
        esconde o próprio botão", mesma família de defeito.

        `-mx-4 px-4` devolve o respiro do `p-4` para dentro da área rolável,
        de modo que a barra de rolagem encoste na borda do cartão.
      */}
      <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4">
        {step.experience === "FULL" ? (
          <p className="text-[13px] text-lifeone-ink-2">
            {/* `subtitle` é `String?` no banco: pode vir null E pode vir vazio/só
              espaços (`??` deixaria o vazio passar e renderizaria um parágrafo
              em branco). Só cai na frase genérica quando não há texto real. */}
            {step.subtitle && step.subtitle.trim().length > 0
              ? step.subtitle
              : "Você está na tela real da funcionalidade. Use o painel para continuar a jornada."}
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
      </div>

      {!suppressGenericActions && (
        <div className="mt-4 flex shrink-0 justify-end gap-2">
          <button
            type="button"
            data-journey-panel-action="back"
            onClick={runtime.back}
            disabled={active.stepIndex === 0}
            className="min-h-11 rounded-[10px] border border-lifeone-hairline px-3 text-[13px] disabled:opacity-40"
          >
            Voltar
          </button>
          {step.skippable && (
            <button
              type="button"
              data-journey-panel-action="skip"
              onClick={runtime.skip}
              className="min-h-11 rounded-[10px] px-3 text-[13px] text-lifeone-ink-2"
            >
              Pular
            </button>
          )}
          <button
            type="button"
            data-journey-panel-action="next"
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
