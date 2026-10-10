import { expect, test, type Locator, type Page } from "@playwright/test";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import {
  appliedFixture,
  declarationViewFixture,
  workflowCatalog,
  workflowFixture,
} from "../src/app/projects/[projectId]/maria/_lib/import-workflow-fixtures";

const PROJECT = "maria-csv-ui";
const SESSION = "session-a";
const PATH = `/projects/${PROJECT}/maria?importSessionId=${SESSION}`;
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

function activeQuestionView(): ImportSessionViewV1 {
  return {
    ...declarationViewFixture(),
    searchComplete: true,
    questions: [
      {
        id: "question-first-due",
        lineIds: ["first"],
        field: "firstDueDate",
        text: "Informe firstDueDate para revisar esta compra",
      },
    ],
    actions: ["RESOLVE", "PREPARE", "CANCEL"],
  };
}

type Stub = {
  view: ImportSessionViewV1;
  chatRequests: Array<Record<string, unknown>>;
  confirmationAttempts: number;
  documentaryWrites: string[];
  requests?: Array<{
    method: string;
    path: string;
    body: Record<string, unknown> | null;
  }>;
  interpretationOutcome?:
    | "CANDIDATE"
    | "CLARIFY"
    | "PROVIDER_UNAVAILABLE"
    | "MODEL_OUTPUT_INVALID";
  loseFirstDeferResponse?: "APPLIED" | "NOT_APPLIED";
  deferAbortSettled?: boolean;
  deferReplayView?: ImportSessionViewV1;
  deferAuthoritativeApplications?: number;
  deferReceiptCreations?: number;
  committedDeferReceipt?: Record<string, unknown>;
  continueAnsweringView?: ImportSessionViewV1;
  currentLot?: Record<string, unknown>;
  projects?: Array<Record<string, unknown>>;
  onDocumentaryCommand?: (command: {
    operation: "DECLARE" | "RESOLVE" | "DEFER" | "REACTIVATE";
    body: Record<string, unknown>;
  }) => {
    view: ImportSessionViewV1;
    receipt: Record<string, unknown>;
  };
};

async function syntheticMaria(
  page: Page,
  stub: Stub,
  voice:
    | "UNSUPPORTED"
    | "PERMISSION_DENIED"
    | "TRANSCRIPT_SIMULATION" = "UNSUPPORTED",
) {
  stub.requests ??= [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript((voiceMode) => {
    Reflect.deleteProperty(window, "webkitSpeechRecognition");
    if (voiceMode === "UNSUPPORTED") {
      Reflect.deleteProperty(window, "SpeechRecognition");
      return;
    }
    class PermissionDeniedSpeechRecognition {
      lang = "";
      interimResults = false;
      maxAlternatives = 1;
      continuous = false;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onresult:
        | ((event: {
            results: ArrayLike<ArrayLike<{ transcript: string }>>;
          }) => void)
        | null = null;

      start() {
        this.onstart?.();
        queueMicrotask(() => {
          if (voiceMode === "TRANSCRIPT_SIMULATION") {
            this.onresult?.({
              results: [
                [{ transcript: "duzentos e seis reais e noventa e seis" }],
              ],
            });
            this.onend?.();
            return;
          }
          this.onerror?.({ error: "not-allowed" });
          this.onend?.();
        });
      }

      stop() {
        this.onend?.();
      }

      abort() {
        this.onend?.();
      }
    }
    Object.defineProperty(window, "SpeechRecognition", {
      configurable: true,
      value: PermissionDeniedSpeechRecognition,
    });
  }, voice);
  await page.context().addCookies([
    {
      name: "rf_token",
      value: "synthetic-maria-csv-ui",
      url: process.env.PLAYWRIGHT_PORT
        ? `http://localhost:${process.env.PLAYWRIGHT_PORT}`
        : "http://localhost:3013",
    },
  ]);
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["3001", "43141"].includes(url.port)) return route.continue();
    const path = url.pathname;
    const method = request.method();
    const body =
      method === "GET" || request.postData() === null
        ? null
        : (request.postDataJSON() as Record<string, unknown>);
    stub.requests?.push({ method, path, body });
    if (
      method !== "GET" &&
      (path === "/import-sessions" || path.startsWith("/import-sessions/"))
    )
      stub.documentaryWrites.push(`${method} ${path}`);
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "actor-a",
          username: "actor-a",
          name: "Ana",
          role: "OWNER",
          tenantId: "tenant-a",
          allowedModules: [],
          allowedProjects: [],
          allowedProjectTypes: [],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    if (path === "/projects")
      return route.fulfill(
        json(
          stub.projects ?? [
            { id: PROJECT, name: "Pessoal", type: "PESSOAL" },
            {
              id: "personal",
              name: workflowCatalog.projects[0].name,
              type: "PESSOAL",
            },
            {
              id: "renovation",
              name: workflowCatalog.projects[1].name,
              type: "REFORMA",
            },
          ],
        ),
      );
    if (path === `/projects/${PROJECT}`)
      return route.fulfill(
        json({
          id: PROJECT,
          name: "Pessoal",
          type: "PESSOAL",
          onboardedAt: "2026-10-01T00:00:00.000Z",
        }),
      );
    if (path === `/projects/${PROJECT}/monthly-overview`) {
      const month = {
        mes: "2026-10",
        totalDespesas: 0,
        totalRecebimentos: 0,
        despesasRealizadas: 0,
        recebimentosRealizados: 0,
        saldoMes: 0,
        saldoMesRealizado: 0,
        porOrigem: {},
        porCategoria: [],
      };
      return route.fulfill(
        json({
          mesAtual: "2026-10",
          meses: [month],
          comparativo: {
            current: month,
            previous: null,
            deltaDespesas: 0,
            deltaDespesasPct: null,
            deltaRecebimentos: 0,
            deltaRecebimentosPct: null,
            deltaSaldo: 0,
          },
          mesAtualEntries: [],
          entries: [],
          projetos: [{ id: PROJECT, name: "Pessoal", type: "PESSOAL" }],
          cards: [],
          caixa: {
            hoje: 0,
            saldoInicial: 0,
            temSaldoInicial: true,
            porMes: [{ mes: "2026-10", caixa: 0 }],
          },
          projecao: {
            caixaHoje: 0,
            entrouMes: 0,
            saiuMes: 0,
            faltaPagarMes: 0,
            recebimentosPrevistosMes: 0,
            sobraPrevista: 0,
          },
        }),
      );
    }
    if (path === "/import-sessions")
      return route.fulfill(
        json({
          items: [],
          nextCursor: null,
          entry: { version: 1, kind: "CARD_INVOICE", formats: ["CSV"] },
        }),
      );
    if (
      path === `/import-sessions/${SESSION}/result` &&
      method === "GET" &&
      stub.view.state === "APPLIED"
    )
      return route.fulfill(
        json({ state: "APPLIED", receipt: stub.view.receipt }),
      );
    if (
      path === `/import-sessions/${SESSION}/current-lot/prepare` &&
      method === "POST"
    )
      return route.fulfill(
        json({
          version: 1,
          requestId: body?.requestId,
          operation: "PREPARE_CURRENT_LOT",
          outcome: "CURRENT_LOT_READY",
          revision: stub.view.revision,
        }),
      );
    if (
      path === `/import-sessions/${SESSION}/current-lot/continue` &&
      method === "POST"
    ) {
      if (!stub.continueAnsweringView)
        throw new Error("Continuation fixture is required");
      stub.view = structuredClone(stub.continueAnsweringView);
      return route.fulfill(
        json({
          version: 1,
          requestId: body?.requestId,
          operation: "CONTINUE_ANSWERING",
          outcome: "NEEDS_INPUT",
          revision: stub.view.revision,
        }),
      );
    }
    if (path === `/import-sessions/${SESSION}/current-lot` && method === "GET")
      return route.fulfill(
        json(
          stub.currentLot ?? {
            version: 1,
            state:
              stub.view.guidedReview?.progress === "READY"
                ? "READY"
                : "READY_WITH_PENDING",
            revision: stub.view.revision,
            confirmationHash: "b".repeat(64),
            purchases: [
              {
                title: "COMPRA PRONTA RECONHECIVEL 716",
                merchant: "Loja pronta",
                purchaseDate: "2026-10-09",
                totalCents: 10001,
                installmentIndex: 1,
                installmentCount: 1,
                schedule: {
                  version: 1,
                  occurrences: [
                    {
                      index: 0,
                      parcela: "1/1",
                      valor: 10001,
                      data: "2026-10-28",
                      invoiceDueMonth: "2026-10",
                    },
                  ],
                },
                targets: [],
                disposition: "CREATE",
              },
            ],
            createdEconomicTotalCents: 10001,
            bankCashDeltaCents: 0,
            invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 10001 }],
            hasRemainingWork: stub.view.guidedReview?.progress !== "READY",
            actions: ["CONFIRM"],
          },
        ),
      );
    const documentaryOperation = path.endsWith("/declarations")
      ? "DECLARE"
      : path.endsWith("/resolutions")
        ? "RESOLVE"
        : path.endsWith("/defer")
          ? "DEFER"
          : path.endsWith("/reactivate")
            ? "REACTIVATE"
            : null;
    if (
      documentaryOperation &&
      path.startsWith(`/import-sessions/${SESSION}/`) &&
      method === "POST"
    ) {
      if (
        documentaryOperation !== "PREPARE_CURRENT_LOT" &&
        stub.onDocumentaryCommand
      ) {
        if (!body) throw new Error("Documentary command body is required");
        const result = stub.onDocumentaryCommand({
          operation: documentaryOperation,
          body,
        });
        stub.view = structuredClone(result.view);
        return route.fulfill(json(result.receipt));
      }
      const deferAttempts = stub.requests?.filter(
        (entry) =>
          entry.method === "POST" &&
          entry.path === `/import-sessions/${SESSION}/defer`,
      ).length;
      if (
        documentaryOperation === "DEFER" &&
        stub.deferReplayView &&
        !stub.committedDeferReceipt &&
        (stub.loseFirstDeferResponse === "APPLIED" || deferAttempts === 2)
      ) {
        stub.view = structuredClone(stub.deferReplayView);
        stub.deferAuthoritativeApplications =
          (stub.deferAuthoritativeApplications ?? 0) + 1;
        stub.committedDeferReceipt = {
          version: 1,
          requestId: body?.requestId,
          operation: documentaryOperation,
          outcome: "APPLIED",
          revision: stub.view.revision,
        };
        stub.deferReceiptCreations = (stub.deferReceiptCreations ?? 0) + 1;
      }
      if (
        documentaryOperation === "DEFER" &&
        stub.loseFirstDeferResponse &&
        deferAttempts === 1
      ) {
        await route.abort("connectionreset");
        stub.deferAbortSettled = true;
        return;
      }
      return route.fulfill(
        json(
          documentaryOperation === "DEFER" && stub.committedDeferReceipt
            ? stub.committedDeferReceipt
            : {
                version: 1,
                requestId: body?.requestId,
                operation: documentaryOperation,
                outcome: "APPLIED",
                revision: stub.view.revision,
              },
        ),
      );
    }
    if (
      path === `/import-sessions/${SESSION}/interpretations` &&
      method === "POST"
    ) {
      const outcome = stub.interpretationOutcome ?? "CANDIDATE";
      if (outcome === "PROVIDER_UNAVAILABLE")
        return route.fulfill(
          json(
            {
              statusCode: 503,
              code: "PROVIDER_UNAVAILABLE",
              message: "Provider unavailable",
            },
            503,
          ),
        );
      if (outcome === "MODEL_OUTPUT_INVALID")
        return route.fulfill(
          json(
            {
              statusCode: 502,
              code: "MODEL_OUTPUT_INVALID",
              message: "Model output invalid",
            },
            502,
          ),
        );
      return route.fulfill(
        json(
          outcome === "CLARIFY"
            ? {
                version: 1,
                requestId: body?.requestId,
                outcome: "CLARIFY",
              }
            : {
                version: 1,
                requestId: body?.requestId,
                outcome: "CANDIDATE",
                candidate: {
                  kind: "KNOWN",
                  value: "2026-10-28",
                },
              },
        ),
      );
    }
    if (path === `/import-sessions/${SESSION}` && method === "GET")
      return route.fulfill(json(stub.view));
    if (path === "/tenant/credit-cards")
      return route.fulfill(
        json([
          {
            id: "card-a",
            nickname: "Cartão",
            last4: "1234",
            project: {
              id: stub.view.ownerProjectId,
              name:
                workflowCatalog.projects.find(
                  (project) => project.id === stub.view.ownerProjectId,
                )?.name ?? "Pessoal",
              type: "PESSOAL",
            },
          },
          {
            id: "card-entry",
            nickname: "Cartão da entrada",
            last4: "5678",
            project: { id: PROJECT, name: "Pessoal", type: "PESSOAL" },
          },
        ]),
      );
    if (path === "/agent/chat" && method === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      stub.chatRequests.push(body);
      const turn = body.importTurn as Record<string, unknown>;
      const openReview = turn.intent === "OPEN_REVIEW";
      return route.fulfill(
        json(
          {
            reply: "",
            toolsUsed: [],
            provider: "import-session",
            importOutcome: {
              version: 1,
              kind: openReview ? "OPEN_REVIEW" : "CLARIFY",
              turnId: turn.turnId,
              ref: {
                sessionId: SESSION,
                revision: stub.view.revision,
              },
              acknowledgment: "NONE",
              ...(openReview
                ? {}
                : { reason: "INVALID_VALUE", scopeReview: null }),
            },
          },
          201,
        ),
      );
    }
    if (
      path === `/import-sessions/${SESSION}/confirmation-challenge` &&
      method === "POST"
    ) {
      stub.confirmationAttempts++;
      return route.fulfill(json({ malformed: "falha sintética" }));
    }
    if (path === "/journeys/eligible" || path === "/notifications")
      return route.fulfill(json([]));
    if (path === "/notifications/daily-summary")
      return route.fulfill(
        json({
          data: "2026-10-09",
          hoje: {
            gastos: { total: 0, count: 0, items: [] },
            recebimentos: { total: 0, count: 0, items: [] },
            tarefasAtivas: [],
            vencendoHoje: [],
          },
          proximos7Dias: {
            vencimentos: [],
            tarefasComecando: [],
            lembretes: [],
            manutencoes: [],
            contasRecorrentes: [],
          },
          totalBadge: 0,
        }),
      );
    return route.fulfill(json([]));
  });
  return { consoleErrors };
}

type TargetEvidence = {
  cta: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  dock: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  };
  hit: boolean;
  hitText: string | null;
};

async function targetEvidence(
  page: Page,
  target: Locator,
  viewport: (typeof VIEWPORTS)[number],
  label: string,
  preserveScroll = false,
): Promise<TargetEvidence> {
  if (!preserveScroll) await target.scrollIntoViewIfNeeded();
  await expect(target, label).toBeVisible();
  const dock = page.getByRole("navigation", { name: "Navegação principal" });
  const evidence = await target.evaluate((element) => {
    const rectangle = (value: Element) => {
      const box = value.getBoundingClientRect();
      return {
        left: box.left,
        top: box.top,
        right: box.right,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
      };
    };
    const box = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      box.left + box.width / 2,
      box.top + box.height / 2,
    );
    const dock = document.querySelector('[data-dock="minimal"]');
    if (!dock) throw new Error("Mobile dock missing");
    return {
      cta: rectangle(element),
      dock: rectangle(dock),
      hit: hit === element || (hit instanceof Node && element.contains(hit)),
      hitText: hit?.textContent?.trim() ?? null,
    };
  });
  expect(evidence.cta.width, `${label}: width`).toBeGreaterThanOrEqual(44);
  expect(evidence.cta.height, `${label}: height`).toBeGreaterThanOrEqual(44);
  expect(evidence.hit, `${label}: center hit-test (${evidence.hitText})`).toBe(
    true,
  );
  if (viewport.width < 768) {
    await expect(dock).toBeVisible();
    expect(
      evidence.cta.bottom,
      `${label}: bottom clear of fixed dock`,
    ).toBeLessThanOrEqual(evidence.dock.top - 8);
  } else {
    await expect(dock).toBeHidden();
    expect(evidence.dock.height).toBe(0);
  }
  return evidence;
}

async function alignTargetToScrollEnd(target: Locator) {
  await target.evaluate((element) =>
    element.scrollIntoView({ block: "end", inline: "nearest" }),
  );
  await target
    .page()
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
}

async function expectConversationBottomInset(
  conversation: Locator,
  label: string,
) {
  const inset = await conversation.evaluate((element) => {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;visibility:hidden;height:var(--rf-bottom-chrome, 0px)";
    document.body.append(probe);
    const chrome = Number.parseFloat(getComputedStyle(probe).height);
    probe.remove();
    const style = getComputedStyle(element);
    const pixels = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      chrome,
      paddingBottom: pixels(style.paddingBottom),
      scrollPaddingBottom: pixels(style.scrollPaddingBottom),
    };
  });
  expect
    .soft(inset.paddingBottom, `${label}: final content space`)
    .toBe(inset.chrome + 12);
  expect
    .soft(inset.scrollPaddingBottom, `${label}: scroll end inset`)
    .toBe(inset.chrome + 12);
}

async function conversationEvidence(page: Page) {
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });
  const controls = await conversation
    .locator("button, input, select")
    .evaluateAll((elements) =>
      elements
        .filter((element) => {
          const box = element.getBoundingClientRect();
          return box.width > 0 && box.height > 0;
        })
        .map((element) => ({
          tag: element.tagName,
          name:
            element.getAttribute("aria-label") ??
            element.textContent?.trim() ??
            "",
        })),
    );
  const scroll = await conversation.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    const candidates = [element, ...element.querySelectorAll("*")];
    const owners = candidates
      .filter((candidate) => {
        const style = getComputedStyle(candidate);
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          candidate.scrollHeight > candidate.clientHeight + 1
        );
      })
      .map((candidate) =>
        candidate === element
          ? "conversation"
          : `${candidate.tagName.toLowerCase()}.${candidate.className}`,
      );
    const trailing = document.querySelector('[data-dock="minimal"]');
    if (!trailing) throw new Error("Maria composer missing");
    const body = element.getBoundingClientRect();
    const tail = trailing.getBoundingClientRect();
    return {
      owners,
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      remaining:
        element.scrollHeight - element.scrollTop - element.clientHeight,
      dockOverlap: tail.bottom > body.top && tail.top < body.bottom,
    };
  });
  return { controls, scroll };
}

type VisibleControl = {
  role: "button" | "radio" | "disclosure";
  name: string;
  group: string | null;
  width: number;
  height: number;
  centerHit: boolean;
};

async function visibleControlCensus(
  container: Locator,
): Promise<VisibleControl[]> {
  return container
    .locator('button, input[type="radio"], summary')
    .evaluateAll((elements) => {
      const text = (element: Element | null) =>
        element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const labelledBy = (element: Element) =>
        (element.getAttribute("aria-labelledby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => text(document.getElementById(id)))
          .filter(Boolean)
          .join(" ");
      const accessibleName = (element: Element) => {
        const aria = element.getAttribute("aria-label")?.trim();
        if (aria) return aria;
        const referenced = labelledBy(element);
        if (referenced) return referenced;
        if (element instanceof HTMLInputElement) {
          const label = element.closest("label");
          if (label) return text(label);
          if (element.id) {
            const explicit = document.querySelector(
              `label[for="${CSS.escape(element.id)}"]`,
            );
            if (explicit) return text(explicit);
          }
        }
        return text(element);
      };
      const semanticGroup = (element: Element) => {
        const fieldset = element.closest("fieldset");
        if (fieldset) {
          const legend = text(fieldset.querySelector(":scope > legend"));
          if (legend) return legend;
        }
        const region = element.closest(
          "section[aria-label], section[aria-labelledby]",
        );
        if (!region) return null;
        return (
          region.getAttribute("aria-label")?.trim() ||
          labelledBy(region) ||
          null
        );
      };

      return elements.flatMap((element) => {
        if (
          (element instanceof HTMLButtonElement ||
            element instanceof HTMLInputElement) &&
          element.disabled
        )
          return [];
        const box = element.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return [];
        const target =
          element instanceof HTMLInputElement &&
          element.type === "radio" &&
          element.closest("label")
            ? element.closest("label")!
            : element;
        const targetBox = target.getBoundingClientRect();
        const hit = document.elementFromPoint(
          targetBox.left + targetBox.width / 2,
          targetBox.top + targetBox.height / 2,
        );
        return [
          {
            role:
              element instanceof HTMLInputElement
                ? ("radio" as const)
                : element instanceof HTMLElement &&
                    element.tagName === "SUMMARY"
                  ? ("disclosure" as const)
                  : ("button" as const),
            name: accessibleName(element),
            group: semanticGroup(element),
            width: targetBox.width,
            height: targetBox.height,
            centerHit:
              hit === target ||
              (hit instanceof Node && target.contains(hit)) ||
              (hit instanceof Node && hit.contains(target)),
          },
        ];
      });
    });
}

async function expectActiveControlsTappable(container: Locator, label: string) {
  const candidates = container.locator(
    "button:not([disabled]), input:not([disabled]), select:not([disabled]), summary",
  );
  let activeCount = 0;
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    activeCount += 1;
    await candidate.scrollIntoViewIfNeeded();
    const evidence = await candidate.evaluate((element) => {
      const target =
        element instanceof HTMLInputElement &&
        ["radio", "checkbox"].includes(element.type) &&
        element.closest("label")
          ? element.closest("label")!
          : element;
      const box = target.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return {
        identity:
          element.getAttribute("aria-label") ??
          element.textContent?.replace(/\s+/g, " ").trim() ??
          element.tagName,
        width: box.width,
        height: box.height,
        centerHit:
          hit === target || (hit instanceof Node && target.contains(hit)),
      };
    });
    const identity = `${label}: active control "${evidence.identity}"`;
    expect(evidence.width, `${identity} width`).toBeGreaterThanOrEqual(44);
    expect(evidence.height, `${identity} height`).toBeGreaterThanOrEqual(44);
    expect(evidence.centerHit, `${identity} center hit-test`).toBe(true);
  }
  expect(activeCount, `${label}: active control count`).toBeGreaterThan(0);
  const controls = await visibleControlCensus(container);
  return controls;
}

async function expectVisibleControlNamesUnique(
  container: Locator,
  label: string,
) {
  const controls = await visibleControlCensus(container);
  const duplicateNames = Array.from(
    controls.reduce((byName, control) => {
      const key = control.name.toLocaleLowerCase("pt-BR");
      byName.set(key, [...(byName.get(key) ?? []), control]);
      return byName;
    }, new Map<string, VisibleControl[]>()),
  )
    .filter(([, matches]) => matches.length > 1)
    .map(([name, matches]) => ({
      name,
      roles: matches.map(({ role }) => role),
      groups: matches.map(({ group }) => group),
    }));
  expect(
    duplicateNames,
    `${label}: simultaneously visible controls need unique accessible names; ` +
      "a contextual exception is valid only when the semantic group itself distinguishes the control",
  ).toEqual([]);
  return controls;
}

async function expectVisibleMoneyNoWrap(container: Locator, label: string) {
  const values = container.getByText(/^R\$\s/);
  const visibleWhiteSpace: string[] = [];
  for (let index = 0; index < (await values.count()); index += 1) {
    const value = values.nth(index);
    if (await value.isVisible())
      visibleWhiteSpace.push(
        await value.evaluate((element) => getComputedStyle(element).whiteSpace),
      );
  }
  expect(
    visibleWhiteSpace.length,
    `${label}: visible monetary values`,
  ).toBeGreaterThan(0);
  expect(visibleWhiteSpace, `${label}: monetary values must not wrap`).toEqual(
    visibleWhiteSpace.map(() => "nowrap"),
  );
}

async function expectNoHorizontalOverflow(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${label}: horizontal overflow`,
  ).toBeLessThanOrEqual(dimensions.innerWidth);
}

for (const viewport of VIEWPORTS) {
  test(`APPLIED recovery keeps the CSV intake in the conversation and the result entry reachable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "geometry runs once");
    await page.setViewportSize(viewport);
    const applied = appliedFixture();
    applied.id = SESSION;
    if (applied.proposal) applied.proposal.sessionId = SESSION;
    if (applied.receipt) applied.receipt.sessionId = SESSION;
    const stub: Stub = {
      view: applied,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    await expect(page).toHaveURL(`/projects/${PROJECT}/maria`);

    const entry = page.getByRole("button", {
      name: "Importações da Maria",
      exact: true,
    });
    await expect(entry).toBeVisible();
    await entry.scrollIntoViewIfNeeded();
    const evidence = await entry.evaluate((button) => {
      const rectangle = (element: Element | null) => {
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return {
          left: box.left,
          top: box.top,
          right: box.right,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
        };
      };
      const box = button.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      const dock = document.querySelector(".pessoal-minimal-maria-dock");
      const intake = document.querySelector(
        '[aria-label="Importar fatura CSV"]',
      );
      const conversation = document.querySelector(
        '[role="region"][aria-label="Conversa com Maria"]',
      );
      return {
        entry: rectangle(button),
        dock: rectangle(dock),
        intake: rectangle(intake),
        conversation: rectangle(conversation),
        hit: hit === button || (hit instanceof Node && button.contains(hit)),
        hitElement:
          hit instanceof HTMLElement
            ? {
                tag: hit.tagName,
                label: hit.getAttribute("aria-label"),
                text: hit.textContent?.trim().slice(0, 80) ?? "",
              }
            : null,
        dockContainsIntake: Boolean(dock && intake && dock.contains(intake)),
        conversationContainsIntake: Boolean(
          conversation && intake && conversation.contains(intake),
        ),
        intakeIsFinalContent: conversation?.lastElementChild === intake,
      };
    });

    await page.screenshot({
      path: `test-results/maria-dock-containment/${viewport.width}x${viewport.height}.png`,
      fullPage: true,
    });
    testInfo.annotations.push({
      type: "geometry",
      description: JSON.stringify(evidence),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[maria-dock-containment ${viewport.width}x${viewport.height}] ${JSON.stringify(evidence)}`,
    );

    expect(evidence.hit, JSON.stringify(evidence)).toBe(true);
    expect(evidence.conversationContainsIntake).toBe(true);
    expect(evidence.intakeIsFinalContent).toBe(true);
    expect(evidence.dockContainsIntake).toBe(false);
  });
}

test("#716 changed authoritative recovery focuses its alert at 1280px", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "keyboard recovery runs once");
  await page.setViewportSize(VIEWPORTS[2]);
  const initial = activeQuestionView();
  const concurrentlyChanged = activeQuestionView();
  concurrentlyChanged.revision = initial.revision + 1;
  const stub: Stub = {
    view: initial,
    chatRequests: [],
    confirmationAttempts: 0,
    documentaryWrites: [],
    loseFirstDeferResponse: "APPLIED",
    deferReplayView: concurrentlyChanged,
  };
  await syntheticMaria(page, stub);
  await page.goto(PATH);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });
  const requestOffset = (stub.requests ?? []).length;
  await conversation
    .getByRole("button", { name: "Responder depois", exact: true })
    .click();
  await expect.poll(() => stub.deferAbortSettled).toBe(true);
  const consult = conversation.getByRole("button", {
    name: "Consultar estado guardado",
    exact: true,
  });
  await expect(consult).toBeFocused();
  await consult.click();
  const changedAlert = conversation.getByRole("alert").filter({
    hasText: "A importação mudou.",
  });
  await expect(changedAlert).toBeVisible();
  await expect(changedAlert).toBeFocused();
  await expect(
    conversation.getByRole("button", {
      name: "Repetir esta tentativa",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    (stub.requests ?? [])
      .slice(requestOffset)
      .filter(
        ({ path }) =>
          path === `/import-sessions/${SESSION}/defer` ||
          path === `/import-sessions/${SESSION}`,
      )
      .map(({ method, path }) => `${method} ${path}`)
      .slice(-2),
  ).toEqual([
    `POST /import-sessions/${SESSION}/defer`,
    `GET /import-sessions/${SESSION}`,
  ]);
});

for (const viewport of VIEWPORTS) {
  test(`all import actions remain reachable above the dock at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const stub: Stub = {
      view: activeQuestionView(),
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    const runtime = await syntheticMaria(page, stub);
    await page.goto(PATH);
    await expect(page.getByRole("heading", { name: "Maria" })).toBeVisible();

    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    await expect(
      conversation.getByRole("button", { name: "Prefiro digitar" }),
    ).toHaveCount(0);
    await expect(
      conversation.getByRole("button", { name: "Prefiro falar" }),
    ).toHaveCount(0);
    const answer = conversation.getByLabel("Sua resposta", {
      exact: true,
    });
    await answer.fill("2026-10-28");
    const inspectAnswer = conversation.getByRole("button", {
      name: "Conferir informação",
    });
    const evidence: Record<string, unknown> = {
      inspectAnswer: await targetEvidence(
        page,
        inspectAnswer,
        viewport,
        "Conferir informação",
      ),
    };
    await inspectAnswer.click();
    const saveAnswer = conversation.getByRole("button", {
      name: "Guardar informação",
    });
    evidence.saveAnswer = await targetEvidence(
      page,
      saveAnswer,
      viewport,
      "Guardar informação",
    );
    const response = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname ===
          `/import-sessions/${SESSION}/resolutions` &&
        candidate.request().method() === "POST",
    );
    await saveAnswer.click();
    expect((await response).status()).toBe(200);
    expect(stub.chatRequests).toEqual([]);

    stub.view = declarationViewFixture();
    await page.reload();
    const documentary = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const optionalText = documentary.getByRole("button", {
      name: "Prefiro digitar",
      exact: true,
    });
    evidence.optionalText = await targetEvidence(
      page,
      optionalText,
      viewport,
      "Prefiro digitar",
    );
    await optionalText.click();
    const unavailableMic = documentary.getByRole("button", {
      name: "Prefiro falar",
      exact: true,
    });
    evidence.unavailableMic = await targetEvidence(
      page,
      unavailableMic,
      viewport,
      "Prefiro falar",
    );

    await documentary
      .getByLabel("Sua resposta", { exact: true })
      .fill("100,01");
    const inspect = documentary.getByRole("button", {
      name: "Conferir informação",
    });
    evidence.inspect = await targetEvidence(
      page,
      inspect,
      viewport,
      "Conferir informação",
    );
    await inspect.click();
    const save = documentary.getByRole("button", {
      name: "Guardar e continuar",
    });
    evidence.save = await targetEvidence(
      page,
      save,
      viewport,
      "Guardar e continuar",
    );
    const saveResponse = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname ===
          `/import-sessions/${SESSION}/declarations` &&
        candidate.request().method() === "POST",
    );
    await save.click();
    expect((await saveResponse).status()).toBe(200);

    stub.view = workflowFixture();
    await page.reload();
    const ready = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const readyReview = ready.getByRole("button", {
      name: "Revisar compras prontas",
    });
    evidence.readyReview = await targetEvidence(
      page,
      readyReview,
      viewport,
      "Revisar compras prontas",
    );
    const readyResponse = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname ===
          `/import-sessions/${SESSION}/current-lot/prepare` &&
        candidate.request().method() === "POST",
    );
    await readyReview.click();
    expect((await readyResponse).status()).toBe(200);

    const review = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const confirm = review.getByRole("button", {
      name: "Confirmar compras deste lote",
      exact: true,
    });
    await expect(confirm).toBeVisible();
    evidence.confirm = await targetEvidence(
      page,
      confirm,
      viewport,
      "Confirmar compras deste lote",
    );
    const beforeConfirmation = await conversationEvidence(page);
    const confirmationResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/import-sessions/${SESSION}/confirmation-challenge` &&
        response.request().method() === "POST",
    );
    await confirm.click();
    expect((await confirmationResponse).status()).toBe(200);
    expect(stub.confirmationAttempts).toBe(1);
    await expect(review.getByRole("alert")).toBeVisible();

    const census = await conversationEvidence(page);
    evidence.census = { beforeConfirmation, afterFailure: census };
    expect(
      beforeConfirmation.controls.map((control) => control.name),
    ).toContain("Confirmar compras deste lote");
    expect(census.scroll.owners).toEqual(["conversation"]);
    expect(census.scroll.scrollTop).toBeGreaterThan(0);
    expect(census.scroll.remaining).toBeLessThanOrEqual(1);
    expect(census.scroll.dockOverlap).toBe(false);

    await expectNoHorizontalOverflow(
      page,
      `${viewport.width}x${viewport.height}`,
    );
    await testInfo.attach(
      `mobile-scroll-${viewport.width}x${viewport.height}`,
      {
        body: JSON.stringify(evidence, null, 2),
        contentType: "application/json",
      },
    );
    expect(runtime.consoleErrors).toEqual([]);
  });

  test(`CSV selection remains local until documentary consent at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const stub: Stub = {
      view: activeQuestionView(),
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    const runtime = await syntheticMaria(page, stub);
    await page.goto(`/projects/${PROJECT}/maria`);

    const picker = page.getByLabel("Anexar CSV da fatura");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute("accept", ".csv,text/csv");
    await page.getByLabel("Cartão da fatura").selectOption("card-entry");
    await picker.setInputFiles({
      name: "fatura.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("date,title,amount\n2026-10-01,Tinta,12.34\n"),
    });
    expect(stub.documentaryWrites).toEqual([]);
    await expect(page.getByRole("status")).toContainText(
      "Arquivo selecionado. Nada foi enviado.",
    );

    const consent = page.getByRole("button", {
      name: "Analisar e guardar rascunho",
    });
    await consent.scrollIntoViewIfNeeded();
    const consentEvidence = await consent.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(
        box.left + box.width / 2,
        box.top + box.height / 2,
      );
      return {
        width: box.width,
        height: box.height,
        hit: hit === element || (hit instanceof Node && element.contains(hit)),
      };
    });
    expect(consentEvidence.width).toBeGreaterThanOrEqual(44);
    expect(consentEvidence.height).toBeGreaterThanOrEqual(44);
    expect(consentEvidence.hit).toBe(true);
    await expect(
      page.getByRole("button", { name: "Confirmar lote", exact: true }),
    ).toHaveCount(0);
    await expectNoHorizontalOverflow(
      page,
      `documentary consent ${viewport.width}x${viewport.height}`,
    );

    await page.reload();
    expect(stub.documentaryWrites).toEqual([]);
    expect(runtime.consoleErrors).toEqual([]);
  });
}

for (const viewport of VIEWPORTS.filter(({ width }) => width < 768)) {
  for (const voiceMode of ["UNSUPPORTED", "PERMISSION_DENIED"] as const) {
    test(`microphone ${voiceMode.toLowerCase()} keeps text usable at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "mobile capability matrix runs once",
      );
      await page.setViewportSize(viewport);
      const stub: Stub = {
        view: declarationViewFixture(),
        chatRequests: [],
        confirmationAttempts: 0,
        documentaryWrites: [],
      };
      const runtime = await syntheticMaria(page, stub, voiceMode);
      await page.goto(PATH);
      expect(
        await page.evaluate(() => "SpeechRecognition" in window),
        `speech-recognition capability for ${voiceMode}`,
      ).toBe(voiceMode === "PERMISSION_DENIED");

      const conversation = page.getByRole("region", {
        name: "Conversa da importação",
      });
      const voice = conversation.getByRole("button", {
        name: "Prefiro falar",
      });
      await expect(voice).toBeEnabled();
      await voice.click();

      const disclosure = conversation.getByText(
        /Seu texto será enviado ao provedor de IA apenas para interpretar esta resposta/,
      );
      await expect(disclosure).toBeVisible();
      const denial = conversation.getByRole("alert").filter({
        hasText: "Não foi possível usar o microfone.",
      });
      await expect(denial).toHaveCount(0);
      const capture = conversation.getByRole("button", {
        name: "Usar microfone",
        exact: true,
      });
      await expect(capture).toBeEnabled();
      await capture.click();
      await expect(denial).toBeVisible();
      expect(stub.chatRequests).toEqual([]);
      expect(
        (stub.requests ?? []).filter(
          (request) =>
            request.method === "POST" &&
            request.path === `/import-sessions/${SESSION}/interpretations`,
        ),
      ).toEqual([]);

      const optionalText = conversation.getByLabel("Sua resposta em texto", {
        exact: true,
      });
      await expect(optionalText).toBeEnabled();
      await expect(optionalText).toBeFocused();
      await optionalText.fill("28 de outubro de 2026");
      await expect(optionalText).toHaveValue("28 de outubro de 2026");

      const answer = conversation.getByLabel("Sua resposta", { exact: true });
      await answer.fill("100,01");
      await conversation
        .getByRole("button", { name: "Conferir informação" })
        .click();
      const response = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname ===
            `/import-sessions/${SESSION}/declarations` &&
          candidate.request().method() === "POST",
      );
      await conversation
        .getByRole("button", { name: "Guardar e continuar" })
        .click();
      expect((await response).status()).toBe(200);
      expect(stub.chatRequests).toEqual([]);
      await expect(answer).toBeEnabled();
      await expectNoHorizontalOverflow(
        page,
        `microphone ${voiceMode} ${viewport.width}px`,
      );
      expect(runtime.consoleErrors).toEqual([]);
    });
  }
}

test("#716 transcript simulation and interpretation candidate cannot persist before explicit save", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "quality evidence runs once");
  await page.setViewportSize(VIEWPORTS[2]);
  const documentary = declarationViewFixture();
  const initialRevision = documentary.revision;
  const initialLines = structuredClone(documentary.lines);
  const stub: Stub = {
    view: documentary,
    chatRequests: [],
    confirmationAttempts: 0,
    documentaryWrites: [],
    onDocumentaryCommand: ({ operation, body }) => {
      expect(operation).toBe("RESOLVE");
      expect(body.questionId).toBe("question-guided-0");
      expect(body.answer).toEqual(GUIDED_RESOLUTION_STEPS[0]!.answer);
      const fresh = structuredClone(stub.view);
      applyGuidedAnswer(fresh, GUIDED_RESOLUTION_STEPS[0]!);
      fresh.revision += 1;
      fresh.questions = [];
      fresh.state = "READY";
      fresh.actions = ["PREPARE", "CANCEL"];
      setCanonicalGuidedReview(fresh, {
        progress: "READY",
        actions: ["REVIEW_READY"],
        focus: null,
      });
      return {
        view: fresh,
        receipt: {
          version: 1,
          requestId: body.requestId,
          operation: "RESOLVE",
          outcome: "APPLIED",
          revision: fresh.revision,
        },
      };
    },
  };
  await syntheticMaria(page, stub, "TRANSCRIPT_SIMULATION");
  await page.goto(PATH);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });
  await conversation
    .getByRole("button", { name: "Prefiro falar", exact: true })
    .click();
  await conversation
    .getByRole("button", { name: "Usar microfone", exact: true })
    .click();
  const transcript = conversation.getByLabel("Sua resposta em texto", {
    exact: true,
  });
  await expect(transcript).toHaveValue(
    "duzentos e seis reais e noventa e seis",
  );
  expect(importMutations(stub)).toEqual([]);
  expect(stub.view.revision).toBe(initialRevision);
  expect(stub.view.lines).toEqual(initialLines);

  await conversation
    .getByRole("button", { name: "Interpretar resposta", exact: true })
    .click();
  await expect(
    conversation.getByRole("region", {
      name: "Prévia da resposta interpretada",
    }),
  ).toBeVisible();
  const providerPreview = conversation.getByRole("region", {
    name: "Prévia da resposta interpretada",
  });
  await expect(
    providerPreview.getByRole("button", {
      name: "Guardar informação",
      exact: true,
    }),
  ).toHaveCount(1);
  await expect(
    providerPreview.getByRole("button", {
      name: "Guardar e continuar",
      exact: true,
    }),
  ).toHaveCount(0);
  expect(
    importMutations(stub).map(({ method, path }) => `${method} ${path}`),
  ).toEqual([`POST /import-sessions/${SESSION}/interpretations`]);
  expect(stub.view.revision).toBe(initialRevision);
  expect(stub.view.lines).toEqual(initialLines);
  expect(stub.chatRequests).toEqual([]);

  stub.view = guidedResolutionView();
  await page.reload();
  const firstStep = GUIDED_RESOLUTION_STEPS[0]!;
  const guidedForm = conversation.locator("form").first();
  const option = await guidedOptionControl(guidedForm, firstStep);
  await option.check();
  await guidedForm
    .getByRole("button", { name: "Conferir informação", exact: true })
    .click();
  const guidedPreview = conversation.getByRole("region", {
    name: "Confira antes de guardar",
  });
  await expect(guidedPreview).toBeVisible();
  expect(stub.view.lines[0]!.decision).toEqual({ kind: "UNRESOLVED" });
  expect(
    (stub.requests ?? []).filter(
      ({ path }) => path === `/import-sessions/${SESSION}/resolutions`,
    ),
  ).toEqual([]);

  await guidedPreview
    .getByRole("button", { name: "Guardar e continuar", exact: true })
    .click();
  await expect
    .poll(() => stub.view.lines[0]!.decision)
    .toEqual(firstStep.answer.value);
  expect(
    (stub.requests ?? [])
      .filter(
        ({ method, path }) =>
          method === "POST" &&
          path === `/import-sessions/${SESSION}/resolutions`,
      )
      .map(({ body }) => body),
  ).toEqual([
    {
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 40,
      questionId: "question-guided-0",
      answer: firstStep.answer,
    },
  ]);
  expect(stub.chatRequests).toEqual([]);
});

async function browserSurfaceAudit(page: Page) {
  return page.evaluate(() => {
    const attributes = Array.from(document.querySelectorAll("*")).flatMap(
      (element) =>
        ["aria-label", "aria-description", "aria-describedby", "title"].flatMap(
          (name) => {
            const value = element.getAttribute(name);
            return value ? [`${name}=${value}`] : [];
          },
        ),
    );
    return {
      visibleText: document.body.innerText,
      accessibilityAttributes: attributes,
    };
  });
}

function importMutations(stub: Stub) {
  return (stub.requests ?? []).filter(
    (request) =>
      request.method !== "GET" &&
      (request.path === "/agent/chat" ||
        request.path.startsWith(`/import-sessions/${SESSION}/`)),
  );
}

type GuidedResolutionStep = {
  lineId: string;
  title: string;
  field: "decision" | "targets" | "tipoDespesa" | "categoriaMaoDeObra";
  option: string;
  answer: Record<string, unknown>;
};

type CanonicalGuidedReviewWire = {
  progress: "ANSWERING" | "READY" | "READY_WITH_PENDING";
  actions: Array<"CONTINUE_ANSWERING" | "REVIEW_READY">;
  focus: {
    questionId: string;
    lineId: string;
    control: "DECISION" | "TARGETS" | "EXPENSE_TYPE" | "LABOR_CATEGORY";
    prompt: string;
    context: {
      title: string;
      merchant: string | null;
      amountCents: number | null;
      purchaseDate: string | null;
    };
    options: Array<{
      label: string;
      answer: Record<string, unknown>;
    }>;
    purchaseOrdinal: number;
    purchaseTotal: number;
    questionOrdinal: number;
    questionTotal: number;
  } | null;
};

const GUIDED_CONTROL_BY_FIELD = {
  decision: "DECISION",
  targets: "TARGETS",
  tipoDespesa: "EXPENSE_TYPE",
  categoriaMaoDeObra: "LABOR_CATEGORY",
} as const;

const GUIDED_PROMPT_BY_FIELD = {
  decision: "O que você quer fazer com esta compra?",
  targets: "Qual é o destino desta compra?",
  tipoDespesa: "Qual é o tipo desta despesa?",
  categoriaMaoDeObra: "Qual é a categoria desta mão de obra?",
} as const;

function setCanonicalGuidedReview(
  view: ImportSessionViewV1,
  guidedReview: CanonicalGuidedReviewWire,
) {
  view.guidedReview = guidedReview;
}

function canonicalGuidedReview(view: ImportSessionViewV1) {
  const guidedReview = view.guidedReview as
    | CanonicalGuidedReviewWire
    | null
    | undefined;
  if (!guidedReview) throw new Error("Missing canonical guided review");
  return guidedReview;
}

function guidedReviewForStep(
  view: ImportSessionViewV1,
  step: GuidedResolutionStep,
  questionId: string,
  questionOrdinal: number,
  questionTotal: number,
): CanonicalGuidedReviewWire {
  const lineIndex = view.lines.findIndex((line) => line.id === step.lineId);
  const line = view.lines[lineIndex];
  if (!line) throw new Error(`Missing guided line ${step.lineId}`);
  return {
    progress: "ANSWERING",
    actions: ["CONTINUE_ANSWERING"],
    focus: {
      questionId,
      lineId: line.id,
      control: GUIDED_CONTROL_BY_FIELD[step.field],
      prompt: GUIDED_PROMPT_BY_FIELD[step.field],
      context: {
        title: line.titulo,
        merchant: line.fornecedor,
        amountCents: line.amountCents,
        purchaseDate: line.dataCompra,
      },
      options: [{ label: step.option, answer: structuredClone(step.answer) }],
      purchaseOrdinal: lineIndex + 1,
      purchaseTotal: view.lines.length,
      questionOrdinal,
      questionTotal,
    },
  };
}

function expectCanonicalGuidedReview(guidedReview: CanonicalGuidedReviewWire) {
  expect(Object.keys(guidedReview).sort()).toEqual([
    "actions",
    "focus",
    "progress",
  ]);
  expect(JSON.stringify(guidedReview)).not.toMatch(
    /"version"|"question"|"line"|"projectLabel"|"roomLabel"|"provenance"/,
  );
  if (guidedReview.focus === null) return;
  const focus = guidedReview.focus;
  expect(Object.keys(focus).sort()).toEqual(
    [
      "questionId",
      "lineId",
      "control",
      "prompt",
      "context",
      "options",
      "purchaseOrdinal",
      "purchaseTotal",
      "questionOrdinal",
      "questionTotal",
    ].sort(),
  );
  expect(Object.keys(focus.context).sort()).toEqual(
    ["title", "merchant", "amountCents", "purchaseDate"].sort(),
  );
  expect(focus.purchaseOrdinal).toBeGreaterThanOrEqual(1);
  expect(focus.purchaseOrdinal).toBeLessThanOrEqual(focus.purchaseTotal);
  expect(focus.questionOrdinal).toBeGreaterThanOrEqual(1);
  expect(focus.questionOrdinal).toBeLessThanOrEqual(focus.questionTotal);
  expect(focus.options.length).toBeGreaterThan(0);
  for (const option of focus.options) {
    expect(Object.keys(option).sort()).toEqual(["answer", "label"]);
    expect(option.label.trim()).toBe(option.label);
    expect(option.label.length).toBeGreaterThan(0);
    expect(option.answer.kind).toBe(focus.control);
    if (focus.control !== "TARGETS") continue;
    const value = option.answer.value;
    expect(Array.isArray(value)).toBe(true);
    if (!Array.isArray(value)) continue;
    expect([0, 1]).toContain(value.length);
    if (value.length === 1) {
      const target = value[0] as Record<string, unknown>;
      expect(Object.keys(target).sort()).toEqual([
        "amountCents",
        "projectId",
        "roomId",
      ]);
      expect(Number.isSafeInteger(target.amountCents)).toBe(true);
      expect(Number(target.amountCents)).toBeGreaterThan(0);
    }
  }
}

const GUIDED_RESOLUTION_STEPS: readonly GuidedResolutionStep[] = [
  {
    lineId: "purchase-twin-a",
    title: "LOJA GEMEA PRIMEIRA",
    field: "decision",
    option: "Criar mesmo parecendo repetida",
    answer: {
      kind: "DECISION",
      value: { kind: "CREATE", acceptNaturalDuplicate: true },
    },
  },
  {
    lineId: "purchase-twin-a",
    title: "LOJA GEMEA PRIMEIRA",
    field: "targets",
    option: "Sem destino em outro projeto",
    answer: { kind: "TARGETS", value: [] },
  },
  {
    lineId: "purchase-twin-a",
    title: "LOJA GEMEA PRIMEIRA",
    field: "tipoDespesa",
    option: "Material de construção",
    answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
  },
  {
    lineId: "purchase-twin-b",
    title: "LOJA GEMEA SEGUNDA",
    field: "decision",
    option: "Criar mesmo parecendo repetida",
    answer: {
      kind: "DECISION",
      value: { kind: "CREATE", acceptNaturalDuplicate: true },
    },
  },
  {
    lineId: "purchase-twin-b",
    title: "LOJA GEMEA SEGUNDA",
    field: "targets",
    option: "Sem destino em outro projeto",
    answer: { kind: "TARGETS", value: [] },
  },
  {
    lineId: "purchase-twin-b",
    title: "LOJA GEMEA SEGUNDA",
    field: "tipoDespesa",
    option: "Material de construção",
    answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
  },
  {
    lineId: "purchase-reforma",
    title: "MATERIAL REFORMA EXATO",
    field: "decision",
    option: "Criar uma nova compra",
    answer: {
      kind: "DECISION",
      value: { kind: "CREATE", acceptNaturalDuplicate: false },
    },
  },
  {
    lineId: "purchase-reforma",
    title: "MATERIAL REFORMA EXATO",
    field: "targets",
    option: "Reforma autorizada pelo servidor",
    answer: {
      kind: "TARGETS",
      value: [
        {
          projectId: "renovation",
          roomId: null,
          amountCents: 25_001,
        },
      ],
    },
  },
  {
    lineId: "purchase-reforma",
    title: "MATERIAL REFORMA EXATO",
    field: "tipoDespesa",
    option: "Material de construção",
    answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
  },
] as const;

function guidedResolutionView(): ImportSessionViewV1 {
  const base = declarationViewFixture();
  const seed = base.lines[0]!;
  base.lines = [
    {
      ...structuredClone(seed),
      id: "purchase-twin-a",
      observationIds: ["observation-twin-a"],
      titulo: "LOJA GEMEA PRIMEIRA",
      amountCents: 10_001,
      targets: null,
      tipoDespesa: null,
      decision: { kind: "UNRESOLVED" },
    },
    {
      ...structuredClone(seed),
      id: "purchase-twin-b",
      observationIds: ["observation-twin-b"],
      titulo: "LOJA GEMEA SEGUNDA",
      amountCents: 10_001,
      targets: null,
      tipoDespesa: null,
      decision: { kind: "UNRESOLVED" },
    },
    {
      ...structuredClone(seed),
      id: "purchase-reforma",
      observationIds: ["observation-reforma"],
      titulo: "MATERIAL REFORMA EXATO",
      amountCents: 25_001,
      targets: null,
      tipoDespesa: null,
      decision: { kind: "UNRESOLVED" },
    },
  ];
  base.selectedLineIds = base.lines.map((line) => line.id);
  base.declaredFacts = [];
  base.reviewBlockers = [];
  base.searchComplete = true;
  base.proposal = null;
  base.state = "NEEDS_INPUT";
  base.revision = 40;
  base.actions = ["RESOLVE", "CANCEL"];
  base.questions = [
    {
      id: "question-guided-0",
      lineIds: [GUIDED_RESOLUTION_STEPS[0]!.lineId],
      field: GUIDED_RESOLUTION_STEPS[0]!.field,
      text: "internal question copy must not render",
    },
  ];
  setCanonicalGuidedReview(
    base,
    guidedReviewForStep(
      base,
      GUIDED_RESOLUTION_STEPS[0]!,
      "question-guided-0",
      1,
      3,
    ),
  );
  return base;
}

function applyGuidedAnswer(
  view: ImportSessionViewV1,
  step: GuidedResolutionStep,
) {
  const line = view.lines.find((candidate) => candidate.id === step.lineId);
  if (!line) throw new Error(`Missing synthetic line ${step.lineId}`);
  if (step.field === "decision")
    line.decision = structuredClone(step.answer.value) as typeof line.decision;
  if (step.field === "targets")
    line.targets = structuredClone(step.answer.value) as typeof line.targets;
  if (step.field === "tipoDespesa")
    line.tipoDespesa = String(step.answer.value) as typeof line.tipoDespesa;
}

async function guidedOptionControl(form: Locator, step: GuidedResolutionStep) {
  const radio = form.getByRole("radio", { name: step.option, exact: true });
  const select = form.getByRole("combobox");
  await expect(
    radio.or(select),
    `${step.field} must expose the server-authorized Portuguese option`,
  ).toHaveCount(1);
  return (await radio.count()) === 1 ? radio : select;
}

async function chooseGuidedOption(form: Locator, step: GuidedResolutionStep) {
  const control = await guidedOptionControl(form, step);
  if ((await control.getAttribute("type")) === "radio") await control.check();
  else await control.selectOption({ label: step.option });
  return control;
}

for (const viewport of VIEWPORTS) {
  test(`#716 guided purchase decisions use exactly nine authoritative resolutions at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const initial = guidedResolutionView();
    let commandIndex = 0;
    const stub: Stub = {
      view: initial,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
      projects: [
        { id: PROJECT, name: "Pessoal", type: "PESSOAL" },
        { id: "personal", name: "Origem pessoal", type: "PESSOAL" },
        {
          id: "renovation",
          name: "Reforma autorizada pelo servidor",
          type: "REFORMA",
        },
      ],
      onDocumentaryCommand: ({ operation, body }) => {
        expect(operation).toBe("RESOLVE");
        const step = GUIDED_RESOLUTION_STEPS[commandIndex];
        if (!step) throw new Error("Unexpected extra documentary command");
        expect(body).toEqual({
          version: 1,
          requestId: expect.any(String),
          expectedRevision: initial.revision + commandIndex,
          questionId: `question-guided-${commandIndex}`,
          answer: step.answer,
        });
        const fresh = structuredClone(stub.view);
        applyGuidedAnswer(fresh, step);
        fresh.revision += 1;
        commandIndex += 1;
        const next = GUIDED_RESOLUTION_STEPS[commandIndex];
        fresh.questions = next
          ? [
              {
                id: `question-guided-${commandIndex}`,
                lineIds: [next.lineId],
                field: next.field,
                text: "internal question copy must not render",
              },
            ]
          : [];
        if (!next) {
          fresh.state = "READY";
          fresh.actions = ["PREPARE", "CANCEL"];
          setCanonicalGuidedReview(fresh, {
            progress: "READY",
            actions: ["REVIEW_READY"],
            focus: null,
          });
        } else {
          setCanonicalGuidedReview(
            fresh,
            guidedReviewForStep(
              fresh,
              next,
              `question-guided-${commandIndex}`,
              (commandIndex % 3) + 1,
              3,
            ),
          );
        }
        return {
          view: fresh,
          receipt: {
            version: 1,
            requestId: body.requestId,
            operation: "RESOLVE",
            outcome: "APPLIED",
            revision: fresh.revision,
          },
        };
      },
    };
    const runtime = await syntheticMaria(page, stub);
    await page.goto(PATH);

    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    expect(
      await page.evaluate(() => document.activeElement?.tagName),
      "mount must not steal focus",
    ).toBe("BODY");

    for (const [index, step] of GUIDED_RESOLUTION_STEPS.entries()) {
      const guidedReview = canonicalGuidedReview(stub.view);
      expectCanonicalGuidedReview(guidedReview);
      expect(guidedReview.focus).toMatchObject({
        questionId: `question-guided-${index}`,
        lineId: step.lineId,
        control: GUIDED_CONTROL_BY_FIELD[step.field],
        prompt: GUIDED_PROMPT_BY_FIELD[step.field],
        purchaseOrdinal: Math.floor(index / 3) + 1,
        purchaseTotal: 3,
        questionOrdinal: (index % 3) + 1,
        questionTotal: 3,
        options: [{ label: step.option, answer: step.answer }],
      });
      const form = conversation.locator("form").first();
      const purchase = conversation.getByRole("region", {
        name: `Compra ${Math.floor(index / 3) + 1} de 3`,
        exact: true,
      });
      await expect(purchase).toContainText(step.title);
      const money = purchase.getByText(/^R\$\s/);
      expect(
        await money.evaluate((element) => getComputedStyle(element).whiteSpace),
        "recognized purchase amount must not wrap",
      ).toBe("nowrap");
      const heading = await form.getByRole("heading").innerText();
      expect(heading).not.toContain(step.field);
      const control = await chooseGuidedOption(form, step);
      const clickTarget = control.locator("xpath=..");
      if ((await control.getAttribute("type")) === "radio") {
        const box = await clickTarget.boundingBox();
        expect(
          box?.height,
          `${step.field} option hit area`,
        ).toBeGreaterThanOrEqual(44);
      }

      await form
        .getByRole("button", { name: "Conferir informação", exact: true })
        .click();
      const preview = conversation.getByRole("region", {
        name: "Confira antes de guardar",
      });
      await expect(preview).toContainText(step.option);
      await expect(preview).not.toContainText(
        "internal question copy must not render",
      );
      expect(await preview.innerText()).not.toMatch(
        /observation-|purchase-(?:twin|reforma)|question-guided|provenance/i,
      );
      const save = preview.getByRole("button", {
        name: "Guardar e continuar",
        exact: true,
      });
      await targetEvidence(
        page,
        save,
        viewport,
        `${step.field} Guardar e continuar`,
      );
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          new URL(candidate.url()).pathname ===
            `/import-sessions/${SESSION}/resolutions`,
      );
      await save.click();
      expect((await response).status()).toBe(200);

      if (index + 1 < GUIDED_RESOLUTION_STEPS.length) {
        const next = GUIDED_RESOLUTION_STEPS[index + 1]!;
        const nextForm = conversation.locator("form").first();
        await expect(nextForm).toBeVisible();
        const nextControl = await guidedOptionControl(nextForm, next);
        await expect(
          nextControl,
          "only the next server-selected control receives focus",
        ).toBeFocused();
      }
    }

    const mutations = importMutations(stub);
    expect(mutations.map(({ method, path }) => `${method} ${path}`)).toEqual(
      Array.from(
        { length: 9 },
        () => `POST /import-sessions/${SESSION}/resolutions`,
      ),
    );
    expect(stub.chatRequests).toEqual([]);
    expect(
      (stub.requests ?? []).filter(({ path }) =>
        [
          `/import-sessions/${SESSION}/interpretations`,
          `/import-sessions/${SESSION}/defer`,
        ].includes(path),
      ),
    ).toEqual([]);
    expect(commandIndex).toBe(9);
    expectCanonicalGuidedReview(canonicalGuidedReview(stub.view));
    expect(canonicalGuidedReview(stub.view)).toEqual({
      progress: "READY",
      actions: ["REVIEW_READY"],
      focus: null,
    });

    const labels = await conversation
      .getByRole("button")
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => {
            const box = button.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          })
          .map(
            (button) =>
              button.getAttribute("aria-label") ??
              button.textContent?.trim() ??
              "",
          ),
      );
    expect(new Set(labels).size, "visible button labels must be unique").toBe(
      labels.length,
    );
    const surface = JSON.stringify(await browserSurfaceAudit(page));
    for (const internal of [
      "purchase-twin-a",
      "purchase-twin-b",
      "purchase-reforma",
      "question-guided",
      "MATERIAL_CONSTRUCAO",
      "tipoDespesa",
      "targets",
      "decision",
    ])
      expect(
        surface,
        `private/internal token leaked: ${internal}`,
      ).not.toContain(internal);
    await expectNoHorizontalOverflow(
      page,
      `guided resolutions ${viewport.width}x${viewport.height}`,
    );
    expect(runtime.consoleErrors).toEqual([]);
  });
}

test("#716 labor type requires its own server question and typed labor-category command", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "contract runs once");
  await page.setViewportSize(VIEWPORTS[1]);
  const view = guidedResolutionView();
  view.lines = [view.lines[0]!];
  view.selectedLineIds = [view.lines[0]!.id];
  view.questions = [
    {
      id: "question-labor-type",
      lineIds: [view.lines[0]!.id],
      field: "tipoDespesa",
      text: "private labor type field",
    },
  ];
  const laborSteps = [
    {
      lineId: view.lines[0]!.id,
      title: view.lines[0]!.titulo,
      field: "tipoDespesa",
      option: "Mão de obra",
      answer: { kind: "EXPENSE_TYPE", value: "MAO_DE_OBRA" },
    },
    {
      lineId: view.lines[0]!.id,
      title: view.lines[0]!.titulo,
      field: "categoriaMaoDeObra",
      option: "Eletricista",
      answer: { kind: "LABOR_CATEGORY", value: "ELETRICISTA" },
    },
  ] as const satisfies readonly GuidedResolutionStep[];
  setCanonicalGuidedReview(
    view,
    guidedReviewForStep(view, laborSteps[0], "question-labor-type", 1, 2),
  );
  const commands: Record<string, unknown>[] = [];
  const stub: Stub = {
    view,
    chatRequests: [],
    confirmationAttempts: 0,
    documentaryWrites: [],
    onDocumentaryCommand: ({ operation, body }) => {
      expect(operation).toBe("RESOLVE");
      commands.push(structuredClone(body));
      const fresh = structuredClone(stub.view);
      fresh.revision += 1;
      if (commands.length === 1) {
        expect(body.answer).toEqual({
          kind: "EXPENSE_TYPE",
          value: "MAO_DE_OBRA",
        });
        fresh.lines[0]!.tipoDespesa = "MAO_DE_OBRA";
        fresh.questions = [
          {
            id: "question-labor-category",
            lineIds: [fresh.lines[0]!.id],
            field: "categoriaMaoDeObra",
            text: "private labor category field",
          },
        ];
        setCanonicalGuidedReview(
          fresh,
          guidedReviewForStep(
            fresh,
            laborSteps[1],
            "question-labor-category",
            2,
            2,
          ),
        );
      } else {
        expect(body.answer).toEqual({
          kind: "LABOR_CATEGORY",
          value: "ELETRICISTA",
        });
        fresh.lines[0]!.categoriaMaoDeObra = "ELETRICISTA";
        fresh.questions = [];
        fresh.state = "READY";
        fresh.actions = ["PREPARE", "CANCEL"];
        setCanonicalGuidedReview(fresh, {
          progress: "READY",
          actions: ["REVIEW_READY"],
          focus: null,
        });
      }
      return {
        view: fresh,
        receipt: {
          version: 1,
          requestId: body.requestId,
          operation: "RESOLVE",
          outcome: "APPLIED",
          revision: fresh.revision,
        },
      };
    },
  };
  await syntheticMaria(page, stub);
  await page.goto(PATH);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });

  for (const [index, step] of laborSteps.entries()) {
    const guidedReview = canonicalGuidedReview(stub.view);
    expectCanonicalGuidedReview(guidedReview);
    expect(guidedReview.focus).toMatchObject({
      questionId:
        index === 0 ? "question-labor-type" : "question-labor-category",
      lineId: step.lineId,
      control: GUIDED_CONTROL_BY_FIELD[step.field],
      purchaseOrdinal: 1,
      purchaseTotal: 1,
      questionOrdinal: index + 1,
      questionTotal: 2,
      options: [{ label: step.option, answer: step.answer }],
    });
    const form = conversation.locator("form").first();
    const control = await guidedOptionControl(form, step);
    if ((await control.getAttribute("type")) === "radio") await control.check();
    else await control.selectOption({ label: step.option });
    await form
      .getByRole("button", { name: "Conferir informação", exact: true })
      .click();
    const preview = conversation.getByRole("region", {
      name: "Confira antes de guardar",
    });
    await expect(preview).toContainText(step.option);
    await expect(preview).not.toContainText("private labor");
    expect(await preview.innerText()).not.toMatch(
      /observation-|purchase-twin|question-labor|provenance/i,
    );
    const response = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname ===
          `/import-sessions/${SESSION}/resolutions`,
    );
    await preview
      .getByRole("button", { name: "Guardar e continuar", exact: true })
      .click();
    expect((await response).status()).toBe(200);
  }
  expect(commands).toHaveLength(2);
  expect(canonicalGuidedReview(stub.view)).toEqual({
    progress: "READY",
    actions: ["REVIEW_READY"],
    focus: null,
  });
  expect(stub.chatRequests).toEqual([]);
});

test("#716 visible buttons, radios, and disclosures have unique accessible names", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "contract census runs once");
  await page.setViewportSize(VIEWPORTS[2]);
  const guided = guidedResolutionView();
  const purchase = {
    title: "COMPRA PRONTA UM",
    merchant: "Loja um",
    purchaseDate: "2026-10-09",
    totalCents: 10_001,
    installmentIndex: 1,
    installmentCount: 1,
    schedule: {
      version: 1,
      occurrences: [
        {
          index: 0,
          parcela: "1/1",
          valor: 10_001,
          data: "2026-10-28",
          invoiceDueMonth: "2026-10",
        },
      ],
    },
    targets: [],
    disposition: "CREATE",
  };
  const stub: Stub = {
    view: guided,
    currentLot: {
      version: 1,
      state: "READY",
      revision: workflowFixture().revision,
      confirmationHash: "d".repeat(64),
      purchases: [
        purchase,
        {
          ...structuredClone(purchase),
          title: "COMPRA PRONTA DOIS",
          merchant: "Loja dois",
          totalCents: 20_002,
          schedule: {
            version: 1,
            occurrences: [
              {
                index: 0,
                parcela: "1/1",
                valor: 20_002,
                data: "2026-11-28",
                invoiceDueMonth: "2026-11",
              },
            ],
          },
        },
      ],
      createdEconomicTotalCents: 30_003,
      bankCashDeltaCents: 0,
      invoiceDeltas: [
        { invoiceDueMonth: "2026-10", amountCents: 10_001 },
        { invoiceDueMonth: "2026-11", amountCents: 20_002 },
      ],
      hasRemainingWork: false,
      actions: ["CONFIRM"],
    },
    chatRequests: [],
    confirmationAttempts: 0,
    documentaryWrites: [],
  };
  await syntheticMaria(page, stub);
  await page.goto(PATH);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });
  await expect(conversation.locator("form")).toBeVisible();
  const answeringControls = await expectVisibleControlNamesUnique(
    conversation,
    "guided answer",
  );
  expect(answeringControls.map(({ role }) => role)).toEqual(
    expect.arrayContaining(["button", "radio"]),
  );

  stub.view = workflowFixture();
  await page.reload();
  await conversation
    .getByRole("button", { name: "Revisar compras prontas", exact: true })
    .click();
  await expect(
    conversation
      .getByRole("list", { name: "Compras prontas deste lote" })
      .getByRole("listitem"),
  ).toHaveCount(2);
  const reviewControls = await expectActiveControlsTappable(
    conversation,
    "two-purchase ready review",
  );
  expect(
    reviewControls.filter(({ role }) => role === "disclosure"),
  ).toHaveLength(2);
  await expectVisibleControlNamesUnique(
    conversation,
    "two-purchase ready review",
  );
});

for (const viewport of VIEWPORTS) {
  test(`#716 mixed ready state is server-owned, private, and operable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const mixed = guidedResolutionView();
    applyGuidedAnswer(mixed, GUIDED_RESOLUTION_STEPS[0]!);
    applyGuidedAnswer(mixed, GUIDED_RESOLUTION_STEPS[1]!);
    applyGuidedAnswer(mixed, GUIDED_RESOLUTION_STEPS[2]!);
    mixed.lines[1]!.decision = {
      kind: "CREATE",
      acceptNaturalDuplicate: true,
    };
    mixed.questions = [
      {
        id: "question-pending-target",
        lineIds: [mixed.lines[1]!.id],
        field: "targets",
        text: "private pending target",
      },
      {
        id: "question-pending-decision",
        lineIds: [mixed.lines[2]!.id],
        field: "decision",
        text: "private pending decision",
      },
    ];
    mixed.revision = 73;
    mixed.state = "READY";
    mixed.actions = ["RESOLVE", "PREPARE", "CANCEL"];
    setCanonicalGuidedReview(
      mixed,
      guidedReviewForStep(
        mixed,
        {
          lineId: mixed.lines[1]!.id,
          title: mixed.lines[1]!.titulo,
          field: "targets",
          option: "Sem destino em outro projeto",
          answer: { kind: "TARGETS", value: [] },
        },
        "question-pending-target",
        2,
        3,
      ),
    );
    const mixedFocus = canonicalGuidedReview(mixed).focus;
    if (!mixedFocus) throw new Error("Mixed fixture requires a guided focus");
    const continued = structuredClone(mixed);
    continued.revision = mixed.revision + 1;
    continued.state = "NEEDS_INPUT";
    continued.actions = ["RESOLVE", "CANCEL"];
    setCanonicalGuidedReview(continued, {
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: mixedFocus,
    });
    setCanonicalGuidedReview(mixed, {
      progress: "READY_WITH_PENDING",
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
      focus: null,
    });
    const currentLot = {
      version: 1,
      state: "READY_WITH_PENDING",
      revision: 73,
      confirmationHash: "c".repeat(64),
      purchases: [
        {
          title: "LOJA GEMEA PRIMEIRA",
          merchant: "Loja pronta",
          purchaseDate: "2026-10-09",
          totalCents: 10_001,
          installmentIndex: 1,
          installmentCount: 1,
          schedule: {
            version: 1,
            occurrences: [
              {
                index: 0,
                parcela: "1/1",
                valor: 10_001,
                data: "2026-10-28",
                invoiceDueMonth: "2026-10",
              },
            ],
          },
          targets: [],
          disposition: "CREATE",
        },
      ],
      createdEconomicTotalCents: 10_001,
      bankCashDeltaCents: 0,
      invoiceDeltas: [{ invoiceDueMonth: "2026-10", amountCents: 10_001 }],
      hasRemainingWork: true,
      actions: ["CONFIRM"],
    };
    const stub: Stub = {
      view: mixed,
      continueAnsweringView: continued,
      currentLot,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const review = conversation.getByRole("button", {
      name: "Revisar as prontas agora",
      exact: true,
    });
    const keepAnswering = conversation.getByRole("button", {
      name: "Continuar respondendo",
      exact: true,
    });
    await expect(review).toHaveCount(1);
    await expect(keepAnswering).toHaveCount(1);
    await expectActiveControlsTappable(
      conversation,
      `mixed choice ${viewport.width}x${viewport.height}`,
    );
    await expectNoHorizontalOverflow(
      page,
      `mixed choice ${viewport.width}x${viewport.height}`,
    );
    const continuationOffset = (stub.requests ?? []).length;
    await keepAnswering.click();
    await expect
      .poll(
        () =>
          (stub.requests ?? [])
            .slice(continuationOffset)
            .filter(
              ({ path }) =>
                path === `/import-sessions/${SESSION}/current-lot/continue` ||
                path === `/import-sessions/${SESSION}`,
            ).length,
      )
      .toBe(2);
    const continuationRequests = (stub.requests ?? [])
      .slice(continuationOffset)
      .filter(
        ({ path }) =>
          path === `/import-sessions/${SESSION}/current-lot/continue` ||
          path === `/import-sessions/${SESSION}` ||
          path === "/agent/chat",
      );
    expect(
      continuationRequests.map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      `POST /import-sessions/${SESSION}/current-lot/continue`,
      `GET /import-sessions/${SESSION}`,
    ]);
    expect(continuationRequests[0]?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: 73,
    });
    expect(stub.view.revision).toBe(74);
    expect(canonicalGuidedReview(stub.view)).toEqual(
      canonicalGuidedReview(continued),
    );
    const pendingPurchase = conversation.getByRole("region", {
      name: "Compra 2 de 3",
      exact: true,
    });
    await expect(pendingPurchase).toContainText("LOJA GEMEA SEGUNDA");
    await expectVisibleMoneyNoWrap(
      pendingPurchase,
      `mixed pending purchase ${viewport.width}x${viewport.height}`,
    );
    await expectActiveControlsTappable(
      conversation,
      `mixed pending answer ${viewport.width}x${viewport.height}`,
    );
    await expect(
      conversation.getByRole("radio", {
        name: "Sem destino em outro projeto",
        exact: true,
      }),
      "the authoritative continuation focus receives keyboard focus",
    ).toBeFocused();
    await expectNoHorizontalOverflow(
      page,
      `mixed pending answer ${viewport.width}x${viewport.height}`,
    );
    expect(mixed.lines[1]!.decision).toEqual({
      kind: "CREATE",
      acceptNaturalDuplicate: true,
    });
    expect(
      importMutations(stub).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([`POST /import-sessions/${SESSION}/current-lot/continue`]);
    expect(stub.chatRequests).toEqual([]);

    stub.view = structuredClone(mixed);
    await page.reload();
    const reviewOffset = (stub.requests ?? []).length;
    await conversation
      .getByRole("button", {
        name: "Revisar as prontas agora",
        exact: true,
      })
      .click();
    await expect
      .poll(
        () =>
          (stub.requests ?? [])
            .slice(reviewOffset)
            .filter(
              ({ path }) =>
                path === `/import-sessions/${SESSION}/current-lot` ||
                path === `/import-sessions/${SESSION}/current-lot/prepare` ||
                path === "/agent/chat",
            ).length,
      )
      .toBe(1);
    expect(
      (stub.requests ?? [])
        .slice(reviewOffset)
        .filter(
          ({ path }) =>
            path === `/import-sessions/${SESSION}/current-lot` ||
            path === `/import-sessions/${SESSION}/current-lot/prepare` ||
            path === "/agent/chat",
        )
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([`GET /import-sessions/${SESSION}/current-lot`]);
    const readyList = conversation.getByRole("list", {
      name: "Compras prontas deste lote",
    });
    await expect(readyList.getByRole("listitem")).toHaveCount(1);
    await expect(readyList).toContainText("LOJA GEMEA PRIMEIRA");
    await expect(conversation).toContainText(
      "Há outras compras fora deste lote. Elas continuam no rascunho para depois.",
    );
    await expectVisibleMoneyNoWrap(
      readyList,
      `mixed ready list ${viewport.width}x${viewport.height}`,
    );
    await expectActiveControlsTappable(
      conversation,
      `mixed ready review ${viewport.width}x${viewport.height}`,
    );
    await expectNoHorizontalOverflow(
      page,
      `mixed ready review ${viewport.width}x${viewport.height}`,
    );
    const privateSurface = JSON.stringify(await browserSurfaceAudit(page));
    for (const pendingSecret of [
      "LOJA GEMEA SEGUNDA",
      "MATERIAL REFORMA EXATO",
      "25001",
      "R$ 250,01",
      "purchase-twin-b",
      "purchase-reforma",
      "question-pending",
    ])
      expect(
        privateSurface,
        `pending data leaked into ready-only review: ${pendingSecret}`,
      ).not.toContain(pendingSecret);

    stub.view = structuredClone(mixed);
    await page.reload();
    const reloadedConversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    await expect(
      reloadedConversation.getByRole("button", {
        name: "Revisar as prontas agora",
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      reloadedConversation.getByRole("button", {
        name: "Continuar respondendo",
        exact: true,
      }),
    ).toHaveCount(1);
    expect(JSON.stringify(await browserSurfaceAudit(page))).not.toMatch(
      /LOJA GEMEA SEGUNDA|MATERIAL REFORMA EXATO|question-pending/,
    );
    expect(stub.view.lines[1]!.decision).toEqual({
      kind: "CREATE",
      acceptNaturalDuplicate: true,
    });
  });
}

test("#716 null guided focus falls back only to an actually selected pending documentary question", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "contract runs once");
  await page.setViewportSize(VIEWPORTS[1]);
  const view = declarationViewFixture();
  const [selectedQuestion, unselectedQuestion] = view.questions;
  if (!selectedQuestion || !unselectedQuestion)
    throw new Error("Documentary fallback fixture requires two questions");
  view.selectedLineIds = ["first"];
  view.questions = [unselectedQuestion, selectedQuestion];
  setCanonicalGuidedReview(view, {
    progress: "ANSWERING",
    actions: ["CONTINUE_ANSWERING"],
    focus: null,
  });
  const stub: Stub = {
    view,
    chatRequests: [],
    confirmationAttempts: 0,
    documentaryWrites: [],
  };
  const runtime = await syntheticMaria(page, stub);
  await page.goto(PATH);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });
  const selectedPurchase = conversation.getByRole("region", {
    name: "Compra 1 de 2",
    exact: true,
  });
  await expect(selectedPurchase).toBeVisible();
  await expect(
    conversation.getByRole("region", {
      name: "Compra 2 de 2",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    conversation.getByLabel("Sua resposta", { exact: true }),
  ).toHaveCount(1);
  expect(importMutations(stub)).toEqual([]);
  expect(stub.chatRequests).toEqual([]);
  expect(runtime.consoleErrors).toEqual([]);
});

test("#716 server-owned continuation with null focus never falls back to a guided raw question", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "contract runs once");
  await page.setViewportSize(VIEWPORTS[1]);
  const view = guidedResolutionView();
  setCanonicalGuidedReview(view, {
    progress: "READY_WITH_PENDING",
    actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
    focus: null,
  });
  const continued = structuredClone(view);
  continued.revision = view.revision + 1;
  continued.state = "NEEDS_INPUT";
  continued.actions = ["RESOLVE", "CANCEL"];
  setCanonicalGuidedReview(continued, {
    progress: "ANSWERING",
    actions: ["CONTINUE_ANSWERING"],
    focus: null,
  });
  const stub: Stub = {
    view,
    continueAnsweringView: continued,
    chatRequests: [],
    confirmationAttempts: 0,
    documentaryWrites: [],
  };
  const runtime = await syntheticMaria(page, stub);
  await page.goto(PATH);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });
  await expect(conversation.locator("form")).toHaveCount(0);
  const continuationOffset = (stub.requests ?? []).length;
  await conversation
    .getByRole("button", {
      name: "Continuar respondendo",
      exact: true,
    })
    .click();
  await expect(conversation.locator("form")).toHaveCount(0);
  await expect(
    conversation.getByText("Há mais perguntas sobre estas compras.", {
      exact: false,
    }),
  ).toHaveCount(1);
  const continuationRequests = (stub.requests ?? [])
    .slice(continuationOffset)
    .filter(
      ({ path }) =>
        path === `/import-sessions/${SESSION}/current-lot/continue` ||
        path === `/import-sessions/${SESSION}` ||
        path === "/agent/chat",
    );
  const transitionIndex = continuationRequests.findIndex(
    ({ method, path }) =>
      method === "POST" &&
      path === `/import-sessions/${SESSION}/current-lot/continue`,
  );
  expect(transitionIndex).toBeGreaterThanOrEqual(0);
  expect(
    continuationRequests
      .slice(transitionIndex)
      .map(({ method, path }) => `${method} ${path}`),
  ).toEqual([
    `POST /import-sessions/${SESSION}/current-lot/continue`,
    `GET /import-sessions/${SESSION}`,
  ]);
  expect(
    continuationRequests.find(
      ({ path }) => path === `/import-sessions/${SESSION}/current-lot/continue`,
    )?.body,
  ).toEqual({
    version: 1,
    requestId: expect.any(String),
    expectedRevision: 40,
  });
  expect(stub.view.revision).toBe(41);
  expect(canonicalGuidedReview(stub.view)).toEqual({
    progress: "ANSWERING",
    actions: ["CONTINUE_ANSWERING"],
    focus: null,
  });
  expect(stub.chatRequests).toEqual([]);
  expect(runtime.consoleErrors).toEqual([]);
});

test("#716 desktop keyboard order follows answer, preview, alternatives, defer, and review focus", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop", "keyboard path runs once");
  const viewport = VIEWPORTS[2];
  await page.setViewportSize(viewport);
  const initial = guidedResolutionView();
  const firstStep = GUIDED_RESOLUTION_STEPS[0]!;
  let commandIndex = 0;
  const stub: Stub = {
    view: initial,
    chatRequests: [],
    confirmationAttempts: 0,
    documentaryWrites: [],
    onDocumentaryCommand: ({ operation, body }) => {
      if (commandIndex === 0) {
        expect(operation).toBe("RESOLVE");
        expect(body.questionId).toBe("question-guided-0");
        expect(body.answer).toEqual(firstStep.answer);
        const nextGuided = structuredClone(initial);
        applyGuidedAnswer(nextGuided, firstStep);
        nextGuided.revision = initial.revision + 1;
        nextGuided.questions = [
          {
            id: "question-guided-1",
            lineIds: [GUIDED_RESOLUTION_STEPS[1]!.lineId],
            field: GUIDED_RESOLUTION_STEPS[1]!.field,
            text: "internal question copy must not render",
          },
        ];
        setCanonicalGuidedReview(
          nextGuided,
          guidedReviewForStep(
            nextGuided,
            GUIDED_RESOLUTION_STEPS[1]!,
            "question-guided-1",
            2,
            3,
          ),
        );
        commandIndex += 1;
        return {
          view: nextGuided,
          receipt: {
            version: 1,
            requestId: body.requestId,
            operation: "RESOLVE",
            outcome: "APPLIED",
            revision: nextGuided.revision,
          },
        };
      }
      expect(operation).toBe("DECLARE");
      expect(body.questionId).toBe("oq_first_amount");
      expect(body.answer).toEqual({ kind: "KNOWN", value: 20_696 });
      const ready = workflowFixture();
      ready.revision = initial.revision + 2;
      if (!ready.proposal) throw new Error("Ready fixture lost its proposal");
      ready.proposal.revision = ready.revision;
      commandIndex += 1;
      return {
        view: ready,
        receipt: {
          version: 1,
          requestId: body.requestId,
          operation: "DECLARE",
          outcome: "APPLIED",
          revision: ready.revision,
        },
      };
    },
  };
  const runtime = await syntheticMaria(page, stub);
  await page.goto(PATH);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });

  const serverOption = conversation.getByRole("radio", {
    name: firstStep.option,
    exact: true,
  });
  await serverOption.focus();
  await expect(serverOption).toBeFocused();
  await page.keyboard.press("Space");
  await page.keyboard.press("Tab");
  const inspectGuided = conversation.getByRole("button", {
    name: "Conferir informação",
    exact: true,
  });
  await expect(inspectGuided).toBeFocused();
  await page.keyboard.press("Enter");
  const guidedPreview = conversation.getByRole("region", {
    name: "Confira antes de guardar",
  });
  await expect(guidedPreview).toBeVisible();
  await page.keyboard.press("Tab");
  const saveGuided = guidedPreview.getByRole("button", {
    name: "Guardar e continuar",
    exact: true,
  });
  await expect(saveGuided).toBeFocused();
  await page.keyboard.press("Enter");

  const nextControl = conversation.getByRole("radio", {
    name: GUIDED_RESOLUTION_STEPS[1]!.option,
    exact: true,
  });
  await expect(
    nextControl,
    "the first control of the next accepted server question receives focus",
  ).toBeFocused();
  stub.view = declarationViewFixture();
  stub.view.revision = initial.revision + 1;
  await page.reload();
  const documentaryControl = conversation.getByLabel("Sua resposta", {
    exact: true,
  });
  await documentaryControl.fill("206,96");
  await documentaryControl.focus();
  await page.keyboard.press("Tab");
  const inspectDocumentary = conversation.getByRole("button", {
    name: "Conferir informação",
    exact: true,
  });
  await expect(inspectDocumentary).toBeFocused();
  await page.keyboard.press("Enter");
  const documentaryPreview = conversation.getByRole("region", {
    name: "Prévia da informação",
  });
  await expect(documentaryPreview).toBeVisible();
  await page.keyboard.press("Tab");
  const saveDocumentary = documentaryPreview.getByRole("button", {
    name: "Guardar e continuar",
    exact: true,
  });
  await expect(saveDocumentary).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    conversation.getByRole("button", {
      name: "Prefiro digitar",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    conversation.getByRole("button", {
      name: "Prefiro falar",
      exact: true,
    }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    conversation.getByRole("button", {
      name: "Responder depois",
      exact: true,
    }),
  ).toBeFocused();

  await saveDocumentary.click();
  const review = conversation.getByRole("button", {
    name: "Revisar compras prontas",
    exact: true,
  });
  await expect(review).toBeVisible();
  await review.click();
  await expect(
    conversation.getByRole("heading", {
      name: "Revisão do lote",
      exact: true,
    }),
  ).toBeFocused();
  expect(commandIndex).toBe(2);
  await expectNoHorizontalOverflow(page, "1280px keyboard path");
  expect(runtime.consoleErrors).toEqual([]);
});

for (const viewport of VIEWPORTS) {
  test(`#716 structured answer is one recognizable purchase, private, deterministic, and tappable at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const view = declarationViewFixture();
    view.lines[0]!.titulo = "TINTA AZUL RECONHECIVEL 716";
    view.lines[0]!.fornecedor = "Loja São João";
    view.lines[1]!.titulo = "COMPRA FORA DO FOCO 716";
    const stub: Stub = {
      view,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);

    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const focusedPurchases = conversation.getByRole("region", {
      name: "Compra 1 de 2",
      exact: true,
    });
    await expect.soft(focusedPurchases).toHaveCount(1);
    await expect
      .soft(focusedPurchases)
      .toContainText("TINTA AZUL RECONHECIVEL 716");
    await expect
      .soft(focusedPurchases)
      .not.toContainText("COMPRA FORA DO FOCO 716");

    const amount = conversation.getByLabel("Sua resposta", { exact: true });
    await amount.fill("206,96");
    const inspect = conversation.getByRole("button", {
      name: "Conferir informação",
    });
    await targetEvidence(page, inspect, viewport, "Conferir informação");
    await inspect.click();
    const save = conversation.getByRole("button", {
      name: "Guardar e continuar",
    });
    await targetEvidence(page, save, viewport, "Guardar e continuar");
    await save.click();
    await expect.poll(() => importMutations(stub).length).toBeGreaterThan(0);

    const mutations = importMutations(stub);
    const structured = mutations.at(-1);
    expect.soft(structured?.method).toBe("POST");
    expect
      .soft(structured?.path)
      .toBe(`/import-sessions/${SESSION}/declarations`);
    expect.soft(structured?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: view.revision,
      questionId: "oq_first_amount",
      answer: { kind: "KNOWN", value: 20696 },
    });
    expect
      .soft(mutations.map((request) => request.path))
      .not.toContain("/agent/chat");

    const surface = await browserSurfaceAudit(page);
    const rendered = JSON.stringify(surface);
    for (const forbidden of [
      "oq_first_amount",
      "observation-first",
      "amountCents",
      "lineId",
      "questionId",
    ])
      expect
        .soft(rendered, `private browser token ${forbidden}`)
        .not.toContain(forbidden);
    await expectNoHorizontalOverflow(
      page,
      `#716 structured ${viewport.width}x${viewport.height}`,
    );
  });

  test(`#716 focused question has no residual scroll margin at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const stub: Stub = {
      view: activeQuestionView(),
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    const focusedQuestion = page
      .getByRole("region", { name: "Conversa da importação" })
      .getByRole("region", {
        name: "Qual é a data do primeiro vencimento?",
      });
    await expect(focusedQuestion).toBeVisible();

    expect(
      await focusedQuestion.evaluate(
        (element) => getComputedStyle(element).scrollMarginBottom,
      ),
    ).toBe("0px");
  });

  test(`#716 focused question end-alignment leaves its action near the usable edge at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const stub: Stub = {
      view: activeQuestionView(),
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const defer = conversation.getByRole("button", {
      name: "Responder depois",
      exact: true,
    });
    const focusedQuestion = conversation.getByRole("region", {
      name: "Qual é a data do primeiro vencimento?",
    });
    await expect(defer).toBeEnabled();
    await expect(focusedQuestion).toBeVisible();

    await alignTargetToScrollEnd(focusedQuestion);
    const evidence = await targetEvidence(
      page,
      defer,
      viewport,
      "Responder depois",
      true,
    );
    const scrollport = await conversation.boundingBox();
    if (!scrollport) throw new Error("Conversation scrollport missing");
    const actionGap =
      viewport.width < 768
        ? evidence.dock.top - evidence.cta.bottom
        : scrollport.y + scrollport.height - evidence.cta.bottom;
    const scrollMarginBottom = await focusedQuestion.evaluate(
      (element) => getComputedStyle(element).scrollMarginBottom,
    );
    await testInfo.attach(
      `focused action ${viewport.width}x${viewport.height} measurements`,
      {
        body: Buffer.from(
          JSON.stringify(
            { ...evidence, scrollport, actionGap, scrollMarginBottom },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      },
    );
    await testInfo.attach(
      `focused action ${viewport.width}x${viewport.height} screenshot`,
      {
        body: await page.screenshot(),
        contentType: "image/png",
      },
    );
    if (viewport.width < 768) {
      expect(
        actionGap,
        `focused action: mobile dock gap at ${viewport.width}x${viewport.height}`,
      ).toBeGreaterThanOrEqual(8);
      expect(
        actionGap,
        `focused action: mobile dock gap at ${viewport.width}x${viewport.height}`,
      ).toBeLessThanOrEqual(64);
    } else {
      expect(
        actionGap,
        `focused action: desktop scrollport gap at ${viewport.width}x${viewport.height}`,
      ).toBeGreaterThanOrEqual(11);
      expect(
        actionGap,
        `focused action: desktop scrollport gap at ${viewport.width}x${viewport.height}`,
      ).toBeLessThanOrEqual(24);
    }
  });

  test(`#716 Responder depois keeps the dock inset and one normal click emits one POST at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const initial = activeQuestionView();
    const stub: Stub = {
      view: initial,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const defer = conversation.getByRole("button", {
      name: "Responder depois",
      exact: true,
    });
    await expect(defer).toBeEnabled();

    await expectConversationBottomInset(
      conversation,
      `Responder depois ${viewport.width}x${viewport.height}`,
    );
    await alignTargetToScrollEnd(defer);
    await targetEvidence(page, defer, viewport, "Responder depois");
    const requestOffset = (stub.requests ?? []).length;
    await defer.click();

    await expect
      .poll(
        () =>
          (stub.requests ?? [])
            .slice(requestOffset)
            .filter(
              ({ method, path }) =>
                method === "GET" && path === `/import-sessions/${SESSION}`,
            ).length,
      )
      .toBe(1);
    const relevant = (stub.requests ?? [])
      .slice(requestOffset)
      .filter(
        ({ path }) =>
          path === `/import-sessions/${SESSION}/defer` ||
          path === `/import-sessions/${SESSION}`,
      );
    expect(relevant.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST /import-sessions/${SESSION}/defer`,
      `GET /import-sessions/${SESSION}`,
    ]);
    expect(relevant[0]?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: initial.revision,
      lineId: "first",
    });
    expect(
      importMutations(stub).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([`POST /import-sessions/${SESSION}/defer`]);
  });

  test(`#716 ready review is current-lot GET-only before a separate confirmation at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const readyView = workflowFixture();
    readyView.lines[0]!.titulo = "COMPRA PRONTA RECONHECIVEL 716";
    readyView.lines[1]!.titulo = "SEGREDO ADIADO 716";
    if (!readyView.proposal) throw new Error("Ready fixture lost its proposal");
    if (readyView.proposal.lines[0]?.kind === "CREATE")
      readyView.proposal.lines[0].titulo = "COMPRA PRONTA RECONHECIVEL 716";
    if (readyView.proposal.lines[1]?.kind === "CREATE") {
      readyView.proposal.lines[1].titulo = "SEGREDO ADIADO 716";
    }
    setCanonicalGuidedReview(readyView, {
      progress: "READY",
      actions: ["REVIEW_READY"],
      focus: null,
    });
    const stub: Stub = {
      view: readyView,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const open = conversation.getByRole("button", {
      name: "Revisar as prontas agora",
    });
    await targetEvidence(page, open, viewport, "Revisar as prontas agora");
    const reviewOffset = (stub.requests ?? []).length;
    await open.click();
    await expect
      .poll(
        () =>
          (stub.requests ?? [])
            .slice(reviewOffset)
            .filter(
              (request) =>
                request.path ===
                  `/import-sessions/${SESSION}/current-lot/prepare` ||
                request.path === `/import-sessions/${SESSION}/current-lot`,
            ).length,
      )
      .toBe(1);

    const workflowRequests = (stub.requests ?? [])
      .slice(reviewOffset)
      .filter(
        (request) =>
          request.path === `/import-sessions/${SESSION}/current-lot/prepare` ||
          request.path === `/import-sessions/${SESSION}/current-lot` ||
          request.path === "/agent/chat",
      );
    expect
      .soft(workflowRequests.map(({ method, path }) => `${method} ${path}`))
      .toEqual([`GET /import-sessions/${SESSION}/current-lot`]);
    expect.soft(workflowRequests[0]?.body).toBeNull();

    const reviewSurface = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const review = reviewSurface.getByRole("list", {
      name: "Compras prontas deste lote",
    });
    await expect(
      reviewSurface.getByRole("heading", {
        name: "Revisão do lote",
        exact: true,
      }),
    ).toBeFocused();
    await expect
      .soft(review.getByRole("listitem"))
      .toHaveCount(1, { timeout: 1_000 });
    await expect
      .soft(review)
      .toContainText("COMPRA PRONTA RECONHECIVEL 716", { timeout: 1_000 });
    const surface = await browserSurfaceAudit(page);
    const rendered = JSON.stringify(surface);
    for (const hidden of [
      "SEGREDO ADIADO 716",
      "deferredObservationIds",
      "deferredAttachmentIds",
      "ignoredCount",
      "hiddenCount",
      "lineId",
      "observationId",
    ])
      expect.soft(rendered, `ready-only leak ${hidden}`).not.toContain(hidden);

    const confirm = reviewSurface.getByRole("button", {
      name: "Confirmar compras deste lote",
      exact: true,
    });
    await expect.soft(confirm).toHaveCount(1, { timeout: 1_000 });
    expect.soft(stub.confirmationAttempts).toBe(0);
    if ((await confirm.count()) === 1) {
      await targetEvidence(
        page,
        confirm,
        viewport,
        "Confirmar compras deste lote",
      );
      await confirm.click();
    }
    await expect.poll(() => stub.confirmationAttempts).toBe(1);
    await expectNoHorizontalOverflow(
      page,
      `#716 current lot ${viewport.width}x${viewport.height}`,
    );
  });

  test(`#716 case A reconciles commit-before-abort through one authoritative GET and no replay at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const initial = activeQuestionView();
    const deferred = activeQuestionView();
    deferred.revision = initial.revision + 1;
    deferred.lines[0]!.decision = { kind: "DEFER" };
    deferred.selectedLineIds = deferred.selectedLineIds.filter(
      (lineId) => lineId !== "first",
    );
    const stub: Stub = {
      view: initial,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
      loseFirstDeferResponse: "APPLIED",
      deferReplayView: deferred,
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const defer = conversation.getByRole("button", {
      name: "Responder depois",
      exact: true,
    });
    await expect(defer).toBeVisible();
    await expect(defer).toBeEnabled();
    const commandRequestOffset = (stub.requests ?? []).length;
    await targetEvidence(page, defer, viewport, "Responder depois");
    await defer.click();
    await expect.poll(() => stub.deferAbortSettled).toBe(true);
    const consult = conversation.getByRole("button", {
      name: "Consultar estado guardado",
      exact: true,
    });
    await expect(consult).toBeVisible();
    await expect(consult).toBeEnabled();
    await expect(
      consult,
      "unknown mutation outcome moves focus to authoritative query",
    ).toBeFocused();
    await expect(
      conversation.getByRole("button", {
        name: "Repetir esta tentativa",
        exact: true,
      }),
    ).toHaveCount(0);
    await targetEvidence(page, consult, viewport, "Consultar estado guardado");
    await consult.click();
    await expect(
      conversation.getByRole("button", {
        name: "Revisar compras prontas",
        exact: true,
      }),
      "an applied authoritative state moves focus to the next actionable state",
    ).toBeFocused();

    const deferRequests = (stub.requests ?? []).filter(
      (request) =>
        request.method === "POST" &&
        request.path === `/import-sessions/${SESSION}/defer`,
    );
    expect(deferRequests).toHaveLength(1);
    expect(deferRequests[0]?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: initial.revision,
      lineId: "first",
    });
    expect(stub.deferAuthoritativeApplications).toBe(1);
    expect(stub.deferReceiptCreations).toBe(1);
    expect(stub.view.revision).toBe(deferred.revision);
    expect(stub.view.selectedLineIds).not.toContain("first");
    const recoveryRequests = (stub.requests ?? [])
      .slice(commandRequestOffset)
      .filter(
        (request) =>
          request.path === `/import-sessions/${SESSION}/defer` ||
          request.path === `/import-sessions/${SESSION}`,
      );
    expect(
      recoveryRequests.map((request) => `${request.method} ${request.path}`),
    ).toEqual([
      `POST /import-sessions/${SESSION}/defer`,
      `GET /import-sessions/${SESSION}`,
    ]);
    const deferredSummary = page.getByText("Compras para retomar depois", {
      exact: true,
    });
    await expect(deferredSummary).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: "Continuar compra 1 de 2",
        exact: true,
      }),
    ).toBeVisible();
    expect(
      importMutations(stub).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([`POST /import-sessions/${SESSION}/defer`]);
  });

  test(`#716 case B offers one byte-identical retry only after GET proves no commit at ${viewport.width}x${viewport.height}`, async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "viewport matrix runs once");
    await page.setViewportSize(viewport);
    const initial = activeQuestionView();
    const deferred = activeQuestionView();
    deferred.revision = initial.revision + 1;
    deferred.lines[0]!.decision = { kind: "DEFER" };
    deferred.selectedLineIds = deferred.selectedLineIds.filter(
      (lineId) => lineId !== "first",
    );
    const stub: Stub = {
      view: initial,
      chatRequests: [],
      confirmationAttempts: 0,
      documentaryWrites: [],
      loseFirstDeferResponse: "NOT_APPLIED",
      deferReplayView: deferred,
    };
    await syntheticMaria(page, stub);
    await page.goto(PATH);
    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    const defer = conversation.getByRole("button", {
      name: "Responder depois",
      exact: true,
    });
    await expect(defer).toBeVisible();
    await expect(defer).toBeEnabled();
    const commandRequestOffset = (stub.requests ?? []).length;
    await defer.click();
    await expect.poll(() => stub.deferAbortSettled).toBe(true);

    const consult = conversation.getByRole("button", {
      name: "Consultar estado guardado",
      exact: true,
    });
    await expect(consult).toBeEnabled();
    await expect(
      consult,
      "unknown mutation outcome moves focus to authoritative query",
    ).toBeFocused();
    await expect(
      conversation.getByRole("button", {
        name: "Repetir esta tentativa",
        exact: true,
      }),
    ).toHaveCount(0);
    await consult.click();

    const retry = conversation.getByRole("button", {
      name: "Repetir esta tentativa",
      exact: true,
    });
    await expect(retry).toBeVisible();
    await expect(retry).toBeEnabled();
    await expect(
      retry,
      "a proven-not-applied mutation moves focus to its single retry",
    ).toBeFocused();
    await expect(consult).toHaveCount(0);
    expect(stub.deferAuthoritativeApplications ?? 0).toBe(0);
    await targetEvidence(page, retry, viewport, "Repetir esta tentativa");
    await retry.click();

    await expect(
      page.getByRole("button", {
        name: "Continuar compra 1 de 2",
        exact: true,
      }),
    ).toBeVisible();
    const deferRequests = (stub.requests ?? []).filter(
      ({ method, path }) =>
        method === "POST" && path === `/import-sessions/${SESSION}/defer`,
    );
    expect(deferRequests).toHaveLength(2);
    expect(deferRequests[0]?.body).toEqual({
      version: 1,
      requestId: expect.any(String),
      expectedRevision: initial.revision,
      lineId: "first",
    });
    expect(deferRequests[1]?.body).toEqual(deferRequests[0]?.body);
    expect(stub.deferAuthoritativeApplications).toBe(1);
    expect(stub.deferReceiptCreations).toBe(1);
    expect(
      (stub.requests ?? [])
        .slice(commandRequestOffset)
        .filter(
          ({ path }) =>
            path === `/import-sessions/${SESSION}/defer` ||
            path === `/import-sessions/${SESSION}`,
        )
        .map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      `POST /import-sessions/${SESSION}/defer`,
      `GET /import-sessions/${SESSION}`,
      `POST /import-sessions/${SESSION}/defer`,
      `GET /import-sessions/${SESSION}`,
    ]);
    expect(
      importMutations(stub).map(({ method, path }) => `${method} ${path}`),
    ).toEqual([
      `POST /import-sessions/${SESSION}/defer`,
      `POST /import-sessions/${SESSION}/defer`,
    ]);
  });
}

for (const viewport of VIEWPORTS) {
  for (const failure of [
    {
      outcome: "CLARIFY" as const,
      status: 200,
      copy: /Não foi possível entender com segurança\. Use os controles acima ou ajuste o texto\./,
      restoresFocus: false,
    },
    {
      outcome: "PROVIDER_UNAVAILABLE" as const,
      status: 503,
      copy: /Não foi possível interpretar agora\. Seu texto foi mantido; tente novamente ou use os controles acima\./,
      restoresFocus: true,
    },
    {
      outcome: "MODEL_OUTPUT_INVALID" as const,
      status: 502,
      copy: /Não foi possível interpretar agora\. Seu texto foi mantido; tente novamente ou use os controles acima\./,
      restoresFocus: true,
    },
  ]) {
    test(`#716 ${failure.outcome} is explicit and recoverable at ${viewport.width}px`, async ({
      page,
    }, testInfo) => {
      test.skip(
        testInfo.project.name !== "desktop",
        "viewport matrix runs once",
      );
      await page.setViewportSize(viewport);
      const stub: Stub = {
        view: declarationViewFixture(),
        chatRequests: [],
        confirmationAttempts: 0,
        documentaryWrites: [],
        interpretationOutcome: failure.outcome,
      };
      const runtime = await syntheticMaria(page, stub);
      await page.goto(PATH);
      const conversation = page.getByRole("region", {
        name: "Conversa da importação",
      });
      await conversation
        .getByRole("button", { name: "Prefiro digitar", exact: true })
        .click();
      await expect(
        conversation.getByText(
          /Seu texto será enviado ao provedor de IA apenas para interpretar/,
        ),
      ).toBeVisible();
      const optionalText = conversation.getByLabel("Sua resposta em texto", {
        exact: true,
      });
      await optionalText.fill("9 de outubro de 2026");
      const interpret = conversation.getByRole("button", {
        name: "Interpretar resposta",
        exact: true,
      });
      await targetEvidence(
        page,
        interpret,
        viewport,
        `${failure.outcome} interpretation`,
      );
      const interpretationResponse = page.waitForResponse(
        (candidate) =>
          new URL(candidate.url()).pathname ===
            `/import-sessions/${SESSION}/interpretations` &&
          candidate.request().method() === "POST",
      );
      await interpret.click();
      expect((await interpretationResponse).status()).toBe(failure.status);

      const alert = conversation.getByRole("alert").filter({
        hasText: failure.copy,
      });
      await expect.soft(alert).toBeVisible();
      const interpretationRequests = (stub.requests ?? []).filter(
        (request) =>
          request.method === "POST" &&
          request.path === `/import-sessions/${SESSION}/interpretations`,
      );
      expect(interpretationRequests).toHaveLength(1);
      expect(interpretationRequests[0]?.body).toEqual({
        version: 1,
        requestId: expect.any(String),
        expectedRevision: stub.view.revision,
        questionId: "oq_first_amount",
        text: "9 de outubro de 2026",
        consentExternalProcessing: true,
      });
      await expect.soft(optionalText).toHaveValue("9 de outubro de 2026");
      if (failure.restoresFocus) await expect.soft(optionalText).toBeFocused();
      else await expect.soft(optionalText).toBeEnabled();

      await expect(
        conversation.getByRole("region", {
          name: "Prévia da resposta interpretada",
        }),
      ).toHaveCount(0);
      await expect(
        conversation.getByRole("button", { name: "Guardar informação" }),
      ).toHaveCount(0);
      const structured = conversation.getByLabel("Sua resposta", {
        exact: true,
      });
      await targetEvidence(
        page,
        structured,
        viewport,
        `${failure.outcome} structured fallback`,
      );
      await structured.fill("100,01");
      await expect(
        conversation.getByRole("button", { name: "Conferir informação" }),
      ).toBeEnabled();

      const surface = await browserSurfaceAudit(page);
      expect(surface.visibleText).not.toMatch(
        /oq_first_amount|session-a|lineId|questionId|requestId|proposalHash/i,
      );
      expect(surface.accessibilityAttributes.join("\n")).not.toMatch(
        /oq_first_amount|session-a|lineId|questionId|requestId|proposalHash/i,
      );
      expect(stub.chatRequests).toEqual([]);
      expect(importMutations(stub).map((request) => request.path)).toEqual([
        `/import-sessions/${SESSION}/interpretations`,
      ]);
      expect(runtime.consoleErrors).toEqual(
        failure.outcome === "CLARIFY"
          ? []
          : [
              expect.stringMatching(
                failure.outcome === "PROVIDER_UNAVAILABLE" ? /503/ : /502/,
              ),
            ],
      );
    });
  }
}
