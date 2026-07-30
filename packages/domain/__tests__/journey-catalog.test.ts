import { describe, it, expect } from "vitest";
import { ProjectType } from "../src/enums";
import { getProjectNavModules } from "../src/config/module-navigator";
import { PROJECT_FEATURES } from "../src/config/project-features";
import { TYPE_MODULES } from "../src/config/type-modules";
import { ONBOARDING_JOURNEY_DEFAULTS } from "../src/config/onboarding-journey";
import * as journeyCatalog from "../src/config/journey-catalog";
import {
  JOURNEY_CATALOG,
  onboardingJourneyKey,
  resolveJourneySteps,
  getJourneyDefinition,
  listJourneyKeys,
  findUnclassifiedStepKeys,
  findInvalidStepSlugs,
} from "../src/config/journey-catalog";

/**
 * Coverage for #338 (Jornadas Etapa A — schema Prisma + domínio genérico +
 * bootstrap idempotente).
 *
 * Two sections:
 *
 * 1. "generic foundation (landed)" — exercises what already exists in
 *    `journey-catalog.ts` (`JOURNEY_CATALOG`, `JourneyDefinition`,
 *    `resolveJourneySteps`, `onboardingJourneyKey`, `getJourneyDefinition`,
 *    `listJourneyKeys`). These assertions are mutation-focused (exact keys,
 *    exact trigger fields, reference identity between the adapter and the
 *    catalog) and MUST stay green.
 *
 * 2. "RED spec — still missing" — the two remaining Etapa-A scope items that
 *    have NOT landed yet, quoted straight from the issue's Escopo:
 *      - "Catálogo genérico ... derivado/validado contra PROJECT_NAV,
 *        PROJECT_FEATURES e TYPE_MODULES."
 *      - "Catálogo inicial de ações seguras (`project.new`, `expense.new`,
 *        `receipt.new`, etc.) como enum/lista estável em código."
 *    These are written against an ASSUMED contract (documented inline before
 *    each block) since no separate architect spec file exists for #338 beyond
 *    the GitHub issue text — `backend-expert` should either satisfy this
 *    exact surface or the orchestrator should reconcile naming with QA before
 *    merge. They are expected to fail (RED) until that catalog extension
 *    lands.
 *
 * None of the assertions below hard-code a step/screen COUNT: they iterate
 * `ProjectType`/`PROJECT_NAV`/`PROJECT_FEATURES`/`TYPE_MODULES` so the suite
 * keeps passing unchanged when a journey grows (the epic's own 4→6 step
 * regression scenario, proven in stage E).
 */

describe("journey-catalog — generic foundation (landed)", () => {
  const projectTypes = Object.values(ProjectType);

  it("has exactly one catalog entry per ProjectType, keyed by onboardingJourneyKey(type)", () => {
    const keys = listJourneyKeys();
    expect(new Set(keys)).toEqual(
      new Set(projectTypes.map((t) => onboardingJourneyKey(t))),
    );
    expect(keys).toHaveLength(projectTypes.length);
  });

  it('onboardingJourneyKey follows the documented "onboarding:<PROJECT_TYPE>" convention', () => {
    for (const t of projectTypes) {
      expect(onboardingJourneyKey(t)).toBe(`onboarding:${t}`);
    }
  });

  it("each catalog entry is stored under a map key equal to its own .key field (no key/definition drift)", () => {
    for (const [mapKey, def] of Object.entries(JOURNEY_CATALOG)) {
      expect(def.key).toBe(mapKey);
    }
  });

  it("getJourneyDefinition resolves every known key and returns undefined for an unknown one", () => {
    for (const t of projectTypes) {
      const key = onboardingJourneyKey(t);
      expect(getJourneyDefinition(key)).toBe(JOURNEY_CATALOG[key]);
    }
    expect(getJourneyDefinition("does-not-exist")).toBeUndefined();
  });

  it("every journey has a non-empty name/description and at least one step and one trigger", () => {
    for (const def of Object.values(JOURNEY_CATALOG)) {
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.steps.length).toBeGreaterThan(0);
      expect(def.triggers.length).toBeGreaterThan(0);
    }
  });

  it("step keys are unique within each journey (invariant: stable + unique step keys)", () => {
    for (const def of Object.values(JOURNEY_CATALOG)) {
      const keys = def.steps.map((s) => s.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  // repeatPolicy ONCE_PER_PROJECT (não ONCE_PER_USER) reproduz a semântica do
  // shell legado: o gate era `Project.onboardedAt`, uma coluna DO PROJETO —
  // um usuário com duas REFORMAs via onboarding nas duas. ONCE_PER_USER
  // (chave `tenantId:userId:none`, ignora projectId) bloquearia a segunda
  // depois da primeira conclusão — regressão pega pelos testes de paridade
  // da migração do shell (Fase B, Jornadas).
  it("the onboarding trigger targets exactly its own project type, is not cross-project, and repeats once PER PROJECT (never per user)", () => {
    for (const t of projectTypes) {
      const def = getJourneyDefinition(onboardingJourneyKey(t))!;
      expect(def.triggers).toHaveLength(1);
      const [trigger] = def.triggers;
      expect(trigger).toMatchObject({
        targetProjectType: t,
        targetProjectId: null,
        crossProject: false,
        device: "any",
        repeatPolicy: "ONCE_PER_PROJECT",
        dismissPolicy: "DISMISS_UNTIL_LOGIN",
      });
    }
  });

  it("ONBOARDING_JOURNEY_DEFAULTS re-exports the SAME array reference as the catalog steps (single source of truth, no copy)", () => {
    for (const t of projectTypes) {
      expect(ONBOARDING_JOURNEY_DEFAULTS[t]).toBe(
        JOURNEY_CATALOG[onboardingJourneyKey(t)].steps,
      );
    }
  });

  // Regressão: `journey-bootstrap.service.ts` materializa `JourneyStep.enabled`
  // direto do catálogo (`step.enabledByDefault ?? true`), SEM reimplementar a
  // regra "expense-import substitui expense+import" — essa regra precisa
  // estar CODIFICADA AQUI, no dado do catálogo, e em NENHUM outro lugar
  // (bootstrap e o adaptador legado `onboarding-journey.ts` só leem este
  // campo). Sem isto, qualquer jornada PESSOAL nova materializada pelo
  // bootstrap mostraria expense + import + expense-import juntas — três
  // pedidos seguidos pra lançar a mesma 1ª despesa.
  it("PESSOAL: expense/import nascem desligados no CATÁLOGO (expense-import já é a versão unificada das duas)", () => {
    const pessoalSteps = JOURNEY_CATALOG[onboardingJourneyKey(ProjectType.PESSOAL)].steps;
    const expense = pessoalSteps.find((s) => s.key === "expense")!;
    const importStep = pessoalSteps.find((s) => s.key === "import")!;
    const expenseImport = pessoalSteps.find((s) => s.key === "expense-import")!;

    expect(expense.enabledByDefault).toBe(false);
    expect(importStep.enabledByDefault).toBe(false);
    // expense-import continua ligado por default (ausência de enabledByDefault ⇒ true).
    expect(expenseImport.enabledByDefault).not.toBe(false);
  });

  describe("resolveJourneySteps (generic resolution mechanics)", () => {
    const steps = [
      {
        key: "a",
        label: "A",
        defaultSubtitle: "default A",
        alwaysAvailable: true,
        skippableByDefault: true,
      },
      {
        key: "b",
        label: "B",
        defaultSubtitle: "default B",
        alwaysAvailable: false,
        skippableByDefault: false,
      },
    ];

    it("no overrides -> defaults, in catalog order, all enabled", () => {
      const resolved = resolveJourneySteps(steps);
      expect(resolved).toEqual([
        {
          key: "a",
          label: "A",
          subtitle: "default A",
          enabled: true,
          skippable: true,
          alwaysAvailable: true,
        },
        {
          key: "b",
          label: "B",
          subtitle: "default B",
          enabled: true,
          skippable: false,
          alwaysAvailable: false,
        },
      ]);
    });

    it("enabledByDefault: false -> step nasce desligado sem override (a config vem do catálogo, não de código de consumidor)", () => {
      const stepsWithDefaultOff = [
        ...steps,
        {
          key: "c",
          label: "C",
          defaultSubtitle: "default C",
          alwaysAvailable: true,
          skippableByDefault: true,
          enabledByDefault: false,
        },
      ];
      const resolved = resolveJourneySteps(stepsWithDefaultOff);
      expect(resolved.find((s) => s.key === "c")).toMatchObject({ enabled: false });
      // Um override explícito ainda vence o default do catálogo (mesma regra
      // de qualquer outro campo — override > catálogo).
      const withOverride = resolveJourneySteps(stepsWithDefaultOff, [
        { stepKey: "c", enabled: true },
      ]);
      expect(withOverride.find((s) => s.key === "c")).toMatchObject({ enabled: true });
    });

    it("order override reorders; a tie falls back to catalog index", () => {
      const resolved = resolveJourneySteps(steps, [
        { stepKey: "a", order: 1 },
        { stepKey: "b", order: 0 },
      ]);
      expect(resolved.map((s) => s.key)).toEqual(["b", "a"]);
    });

    it("enabled: false and skippable: false overrides propagate exactly (boundary: explicit false must not fall back to default)", () => {
      const [a] = resolveJourneySteps(steps, [
        { stepKey: "a", enabled: false, skippable: false },
      ]);
      expect(a.enabled).toBe(false);
      expect(a.skippable).toBe(false);
    });

    it("blank/whitespace-only label or subtitle overrides fall back to the catalog default (not to an empty string)", () => {
      const [a] = resolveJourneySteps(steps, [
        { stepKey: "a", label: "   ", subtitle: "" },
      ]);
      expect(a.label).toBe("A");
      expect(a.subtitle).toBe("default A");
    });

    it("an orphaned override (stepKey not present in steps) is silently ignored, never crashes, never appears", () => {
      const resolved = resolveJourneySteps(steps, [
        { stepKey: "ghost", order: 0, enabled: true },
      ]);
      expect(resolved.map((s) => s.key)).toEqual(["a", "b"]);
      expect(resolved).toHaveLength(steps.length);
    });

    it("alwaysAvailable is always taken from the catalog definition, never from the override", () => {
      const resolved = resolveJourneySteps(steps, [
        { stepKey: "a", enabled: true },
        { stepKey: "b", enabled: true },
      ]);
      expect(resolved.find((s) => s.key === "a")!.alwaysAvailable).toBe(true);
      expect(resolved.find((s) => s.key === "b")!.alwaysAvailable).toBe(false);
    });

    it("empty steps array -> empty result, no throw", () => {
      expect(resolveJourneySteps([])).toEqual([]);
    });
  });
});

describe("journey-catalog — RED spec: still missing (Etapa A Escopo, #338)", () => {
  // Cast through `any` (namespace import, not a named import) so a missing
  // export is a runtime `undefined`/assertion failure, not a `tsc --noEmit`
  // compile error that would block the WHOLE suite (including the green
  // "landed" section above) from even running.
  const mod = journeyCatalog as unknown as Record<string, unknown>;

  describe('safe actions catalog ("Catálogo inicial de ações seguras... como enum/lista estável em código")', () => {
    // ASSUMED contract: `JOURNEY_SAFE_ACTIONS: readonly string[]`, stable
    // "noun.verb" tokens matching a `data-journey-action` attribute in the
    // web app — never a free CSS selector.
    it("exports a non-empty, deduplicated JOURNEY_SAFE_ACTIONS list", () => {
      const actions = mod.JOURNEY_SAFE_ACTIONS as string[] | undefined;
      expect(Array.isArray(actions)).toBe(true);
      expect((actions ?? []).length).toBeGreaterThan(0);
      expect(new Set(actions).size).toBe((actions ?? []).length);
    });

    it('every action key is a "noun.verb" token, never a raw CSS selector (#. prefix)', () => {
      const actions = (mod.JOURNEY_SAFE_ACTIONS as string[] | undefined) ?? [];
      for (const action of actions) {
        expect(action).toMatch(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/);
        expect(action.startsWith(".")).toBe(false);
        expect(action.startsWith("#")).toBe(false);
      }
    });

    it("includes the three seed actions named explicitly in the issue: project.new, expense.new, receipt.new", () => {
      const actions = (mod.JOURNEY_SAFE_ACTIONS as string[] | undefined) ?? [];
      expect(actions).toEqual(
        expect.arrayContaining(["project.new", "expense.new", "receipt.new"]),
      );
    });
  });

  describe('catalog validated against PROJECT_NAV / PROJECT_FEATURES / TYPE_MODULES ("derivado/validado contra")', () => {
    // ASSUMED contract: `getJourneyScreenKeys(type): string[]` — the SCREEN_VISIT-
    // eligible screen keys for a type, and `findUncoveredNavRoutes(): Array<{
    // type: ProjectType; slug: string }>` — the coverage-regression primitive
    // the issue explicitly asks for: "Teste de cobertura falha quando uma
    // rota user-facing nova ... não tem definição correspondente no catálogo
    // de Jornadas."
    it("getJourneyScreenKeys covers every PROJECT_NAV slug for every ProjectType (data-driven, no hard-coded counts)", () => {
      const getJourneyScreenKeys = mod.getJourneyScreenKeys as
        | ((t: ProjectType) => string[])
        | undefined;
      expect(typeof getJourneyScreenKeys).toBe("function");
      if (typeof getJourneyScreenKeys !== "function") return;

      for (const t of Object.values(ProjectType)) {
        const navSlugs = getProjectNavModules(t).map((m) => m.slug);
        const catalogSlugs = getJourneyScreenKeys(t);
        for (const slug of navSlugs) {
          expect(
            catalogSlugs,
            `PROJECT_NAV[${t}] renders "${slug}" with no matching journey catalog entry`,
          ).toContain(slug);
        }
      }
    });

    it("every ProjectType with declared PROJECT_FEATURES is reachable from at least one journey catalog screen", () => {
      const getJourneyScreenKeys = mod.getJourneyScreenKeys as
        | ((t: ProjectType) => string[])
        | undefined;
      expect(typeof getJourneyScreenKeys).toBe("function");
      if (typeof getJourneyScreenKeys !== "function") return;

      for (const t of Object.values(ProjectType)) {
        if (PROJECT_FEATURES[t].length > 0) {
          expect(getJourneyScreenKeys(t).length).toBeGreaterThan(0);
        }
      }
    });

    it("findUncoveredNavRoutes() is empty (the coverage-regression primitive the issue asks for)", () => {
      const findUncoveredNavRoutes = mod.findUncoveredNavRoutes as
        | (() => Array<{ type: ProjectType; slug: string }>)
        | undefined;
      expect(typeof findUncoveredNavRoutes).toBe("function");
      if (typeof findUncoveredNavRoutes !== "function") return;
      expect(findUncoveredNavRoutes()).toEqual([]);
    });

    it("findUnclassifiedStepKeys() is empty — every catalog stepKey has a slug or is explicitly slug-less", () => {
      expect(findUnclassifiedStepKeys()).toEqual([]);
    });

    it("findInvalidStepSlugs() is empty — every mapped slug is a real PROJECT_NAV slug", () => {
      expect(findInvalidStepSlugs()).toEqual([]);
    });

    it("a nav-only screen key never claims a module outside TYPE_MODULES[type] (no orphaned catalog entry)", () => {
      const getJourneyScreenKeys = mod.getJourneyScreenKeys as
        | ((t: ProjectType) => string[])
        | undefined;
      if (typeof getJourneyScreenKeys !== "function") return;

      for (const t of Object.values(ProjectType)) {
        const navBySlug = new Map(
          getProjectNavModules(t).map((m) => [m.slug, m.module]),
        );
        for (const slug of getJourneyScreenKeys(t)) {
          const gate = navBySlug.get(slug);
          if (gate) expect(TYPE_MODULES[t]).toContain(gate);
        }
      }
    });
  });
});
