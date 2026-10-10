import "../../../scripts/test-db-env.cjs";
import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import {
  summaryFixture,
  viewFixture,
} from "../src/app/projects/[projectId]/maria/_lib/import-session-fixtures";

// Dedicated composed-runtime gate with seeded recovery only. No RAW->Maria claim.
const API = "http://127.0.0.1:43141";
const PROJECT = "public-entry-project";
const OTHER_PROJECT = "public-entry-other-project";
const SESSION = "public-entry-session";
const OTHER_SESSION = "public-entry-other-session";
const CARD = "public-entry-card";
const INSTANT = "2026-09-28T15:00:00.000Z";
const PATH = `/projects/${PROJECT}/maria`;
const FILES = [
  {
    name: "alpha.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("date,title,amount\n2026-09-20,ALPHA,12.34\n"),
  },
  {
    name: "beta.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("date,title,amount\n2026-09-21,BETA,56.78\n"),
  },
];
const POSITIVE = { kind: "CARD_INVOICE", formats: ["CSV"] };
const UNAVAILABLE = { kind: "UNAVAILABLE" };
const EMPTY_DAILY_SUMMARY = {
  data: "2026-09-28",
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
};
const user = {
  id: "public-entry-user",
  username: "public-entry-user",
  name: "QA",
  role: "OWNER",
  tenantId: "public-entry-tenant",
  allowedModules: [],
  allowedProjects: [],
  allowedProjectTypes: [],
};
const project = {
  id: PROJECT,
  name: "Pessoal QA",
  type: "PESSOAL",
  onboardedAt: INSTANT,
};
const card = {
  id: CARD,
  nickname: "Cartao QA",
  last4: "9911",
  project: { id: PROJECT, name: "Pessoal QA" },
};
const summary = summaryFixture({
  id: SESSION,
  revision: 1,
  cardId: CARD,
  ownerProjectId: PROJECT,
  attachmentCount: 0,
});
const initialView = () =>
  viewFixture({
    id: SESSION,
    revision: 1,
    cardId: CARD,
    ownerProjectId: PROJECT,
    attachments: [],
    searchComplete: false,
    actions: ["CANCEL"],
  });
const json = (value: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(value),
});
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected wire object");
  return value as Record<string, unknown>;
}
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((done) => {
    release = done;
  });
  return { promise, release };
}
type RequestFact = {
  method: string;
  path: string;
  body: unknown;
  bytes: Buffer | null;
};
type NetworkErrorFact = {
  method: string;
  path: string;
  error: string;
  requestId?: number;
};
type ResponseFact = {
  method: string;
  path: string;
  status: number;
};
type RequestLifecycleFact = {
  requestId: number;
  method: string;
  path: string;
  startedOrder: number;
  startedAtMs: number;
  response?: {
    status: number;
    order: number;
    atMs: number;
  };
  failure?: {
    error: string;
    order: number;
    atMs: number;
  };
  finished?: {
    order: number;
    atMs: number;
  };
};
type ReadSupersessionWindow = {
  cause: string;
  startIndex: number;
  endIndex: number | "finish";
  startRequestOrder: number;
  endRequestOrder: number;
  allow: Array<{
    method: "GET";
    path: string;
    error: "net::ERR_ABORTED";
    maxCount: number;
    eligibleRequestIds?: number[];
  }>;
};
type AcceptedSupersededRead = NetworkErrorFact & {
  cause: string;
};
type ActiveReadSupersession = Omit<
  ReadSupersessionWindow,
  "endIndex" | "endRequestOrder"
> & {
  pending: Set<Request>;
};
type WireOptions = {
  entry?: unknown;
  omitEntry?: boolean;
  page?: unknown;
  listStatus?: number;
  cardStatus?: number;
  hold?: "CREATE" | "RESERVE" | "PUT" | "ANALYZE";
  lose?: "CREATE" | "RESERVE" | "PUT" | "ANALYZE";
  analyzable?: boolean;
  operational?: boolean;
};

async function syntheticWire(page: Page, options: WireOptions = {}) {
  const requests: RequestFact[] = [];
  const unexpected: string[] = [];
  const consoleErrors: string[] = [];
  const responses: ResponseFact[] = [];
  const httpErrors: ResponseFact[] = [];
  const networkErrors: NetworkErrorFact[] = [];
  const requestLifecycles: RequestLifecycleFact[] = [];
  const lifecycleByRequest = new WeakMap<Request, RequestLifecycleFact>();
  let requestSequence = 0;
  let eventSequence = 0;
  const readSupersessions: ReadSupersessionWindow[] = [];
  let activeReadSupersession: ActiveReadSupersession | undefined;
  const readSettlements = new WeakMap<
    Request,
    {
      window: ActiveReadSupersession;
      promise: Promise<void>;
      release: () => void;
    }
  >();
  const resourceErrors: Array<{ url: string; text: string }> = [];
  const fault = deferred();
  const faultDone = deferred();
  let current = viewFixture({
    ...initialView(),
    actions: options.operational ? ["CANCEL", "RESOLVE"] : ["CANCEL"],
  });
  let entry: unknown = Object.hasOwn(options, "entry")
    ? options.entry
    : POSITIVE;
  let currentUser: typeof user | null = user;
  let firstFault = true;
  let puts = 0;
  let analyzes = 0;
  await page.clock.setFixedTime(new Date(INSTANT));
  await page.context().addCookies([
    {
      name: "rf_token",
      value: "public-entry-synthetic",
      url: "http://127.0.0.1:43142",
    },
  ]);
  page.on("pageerror", (error) => consoleErrors.push(error.message));
  page.on("request", (request) => {
    const lifecycle = {
      requestId: ++requestSequence,
      method: request.method(),
      path: new URL(request.url()).pathname,
      startedOrder: ++eventSequence,
      startedAtMs: performance.now(),
    };
    requestLifecycles.push(lifecycle);
    lifecycleByRequest.set(request, lifecycle);
  });
  page.on("response", (response) => {
    const fact = {
      method: response.request().method(),
      path: new URL(response.url()).pathname,
      status: response.status(),
    };
    responses.push(fact);
    if (fact.status >= 400) httpErrors.push(fact);
    const lifecycle = lifecycleByRequest.get(response.request());
    if (lifecycle)
      lifecycle.response = {
        status: fact.status,
        order: ++eventSequence,
        atMs: performance.now(),
      };
  });
  const settleRead = (request: Request) => {
    const settlement = readSettlements.get(request);
    if (!settlement) return;
    settlement.window.pending.delete(request);
    settlement.release();
    readSettlements.delete(request);
  };
  page.on("request", (request) => {
    const window = activeReadSupersession;
    if (!window) return;
    const path = new URL(request.url()).pathname;
    if (
      !window.allow.some(
        (candidate) =>
          candidate.method === request.method() && candidate.path === path,
      )
    )
      return;
    const settlement = deferred();
    window.pending.add(request);
    readSettlements.set(request, { window, ...settlement });
  });
  page.on("requestfailed", (request) => {
    const lifecycle = lifecycleByRequest.get(request);
    const error = request.failure()?.errorText ?? "missing failure";
    if (lifecycle)
      lifecycle.failure = {
        error,
        order: ++eventSequence,
        atMs: performance.now(),
      };
    networkErrors.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      error,
      requestId: lifecycle?.requestId,
    });
    settleRead(request);
  });
  page.on("requestfinished", (request) => {
    const lifecycle = lifecycleByRequest.get(request);
    if (lifecycle)
      lifecycle.finished = {
        order: ++eventSequence,
        atMs: performance.now(),
      };
    settleRead(request);
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (message.text().startsWith("Failed to load resource:"))
      resourceErrors.push({
        url: message.location().url,
        text: message.text(),
      });
    else consoleErrors.push(message.text());
  });
  const respond = async (
    route: Route,
    phase: WireOptions["hold"],
    value: unknown,
    status = 200,
  ) => {
    if (firstFault && (options.hold === phase || options.lose === phase)) {
      firstFault = false;
      if (options.hold === phase) await fault.promise;
      if (options.lose === phase) await route.abort("connectionreset");
      else await route.fulfill(json(value, status));
      faultDone.release();
    } else await route.fulfill(json(value, status));
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1") {
      unexpected.push(
        `external ${request.method()} ${url.origin}${url.pathname}`,
      );
      return route.abort("blockedbyclient");
    }
    if (url.origin !== API) return route.continue();
    const path = url.pathname;
    const method = request.method();
    const bytes = request.postDataBuffer();
    const body: unknown =
      bytes && method !== "PUT" ? request.postDataJSON() : null;
    requests.push({ method, path, body, bytes });
    if (path === "/auth/me") return route.fulfill(json(currentUser));
    if (path === "/auth/logout" && method === "POST") {
      currentUser = null;
      return route.fulfill(json({ ok: true }));
    }
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: true, guestEnabled: false }),
      );
    if (path === "/projects")
      return route.fulfill(json([project, { ...project, id: OTHER_PROJECT }]));
    if ([`/projects/${PROJECT}`, `/projects/${OTHER_PROJECT}`].includes(path))
      return route.fulfill(json({ ...project, id: path.split("/").at(-1) }));
    if (path === "/tenant/credit-cards") {
      const status = options.cardStatus ?? 200;
      return route.fulfill(
        json(
          status === 200
            ? [card, { ...card, id: "same-last4-other-card" }]
            : { statusCode: status },
          status,
        ),
      );
    }
    if (path === "/notifications/daily-summary" && method === "GET")
      return route.fulfill(json(EMPTY_DAILY_SUMMARY));
    if (path === "/journeys/eligible" || path === "/notifications")
      return route.fulfill(json([]));
    if (path.endsWith("/monthly-overview")) {
      const month = {
        mes: "2026-09",
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
          mesAtual: "2026-09",
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
          projetos: [project],
          cards: [],
          caixa: {
            hoje: 0,
            saldoInicial: 0,
            temSaldoInicial: true,
            porMes: [{ mes: "2026-09", caixa: 0 }],
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
    if (path === "/import-sessions" && method === "GET") {
      const status = options.listStatus ?? 200;
      return route.fulfill(
        json(
          options.page ??
            (status === 200
              ? {
                  items: [summary],
                  nextCursor: null,
                  ...(options.omitEntry ? {} : { entry }),
                }
              : { statusCode: status }),
          status,
        ),
      );
    }
    if (path === "/import-sessions" && method === "POST") {
      current = initialView();
      return respond(route, "CREATE", current, 201);
    }
    if (
      path === `/import-sessions/${SESSION}/attachments` &&
      method === "POST"
    ) {
      const files = record(body).files;
      if (!Array.isArray(files))
        throw new Error("Reservation did not carry files");
      current = viewFixture({
        ...current,
        revision: 7,
        actions: ["CANCEL", "UPLOAD"],
        attachments: files.map((raw: unknown) => {
          const file = record(raw);
          if (
            typeof file.id !== "string" ||
            typeof file.fileName !== "string" ||
            typeof file.declaredBytes !== "number"
          )
            throw new Error("Malformed reservation file");
          return {
            id: file.id,
            fileName: file.fileName,
            declaredBytes: file.declaredBytes,
            state: "RESERVED",
            materializedInSession: false,
            canAnalyze: false,
          };
        }),
      });
      return respond(route, "RESERVE", current);
    }
    if (
      path.startsWith(`/import-sessions/${SESSION}/attachments/`) &&
      method === "PUT"
    ) {
      const id = path.split("/").at(-2);
      const index = puts++;
      expect(bytes).toEqual(FILES[index]?.buffer);
      expect(request.headers()["content-type"]).toBe(
        "application/octet-stream",
      );
      current = viewFixture({
        ...current,
        revision: index === 0 ? 11 : 19,
        actions:
          index === 0
            ? ["CANCEL", "UPLOAD"]
            : options.analyzable
              ? ["CANCEL", "ANALYZE"]
              : ["CANCEL"],
        attachments: current.attachments.map((ref) =>
          ref.id === id
            ? {
                ...ref,
                state: "ATTACHED",
                canAnalyze: options.analyzable === true,
              }
            : ref,
        ),
      });
      return respond(route, "PUT", current);
    }
    if (path.endsWith("/analyze") && method === "POST") {
      const index = analyzes++;
      expect(record(body)).toEqual({ expectedRevision: index === 0 ? 19 : 29 });
      const id = path.split("/").at(-2);
      current = viewFixture({
        ...current,
        revision: index === 0 ? 29 : 41,
        actions: index === 0 ? ["CANCEL", "ANALYZE"] : ["CANCEL"],
        attachments: current.attachments.map((ref) =>
          ref.id === id
            ? { ...ref, materializedInSession: true, canAnalyze: false }
            : ref,
        ),
      });
      return respond(route, "ANALYZE", current);
    }
    if (path === `/import-sessions/${SESSION}` && method === "GET")
      return route.fulfill(json(current));
    if (path === `/import-sessions/${OTHER_SESSION}` && method === "GET")
      return route.fulfill(
        json(viewFixture({ ...initialView(), id: OTHER_SESSION })),
      );
    if (path.startsWith("/import-sessions/") && method === "GET")
      return route.fulfill(
        json(
          {
            code: "NOT_FOUND",
            retryable: false,
            sessionId: null,
            currentRevision: null,
            reason: null,
          },
          404,
        ),
      );
    if (path === "/agent/chat" && method === "POST")
      return route.fulfill(
        json({ statusCode: 429, message: "QA quota boundary" }, 429),
      );
    unexpected.push(`${method} ${path}`);
    return route.fulfill(
      json({ statusCode: 599, message: "Unplanned QA request" }, 599),
    );
  });
  const writes = () =>
    requests.filter(
      (r) => r.path.startsWith("/import-sessions") && r.method !== "GET",
    );
  return {
    requests,
    unexpected,
    consoleErrors,
    responses,
    httpErrors,
    networkErrors,
    requestLifecycles,
    resourceErrors,
    fault,
    faultDone,
    writes,
    beginReadSupersession(
      cause: string,
      paths: string[],
      maxCounts: Partial<Record<string, number>> = {},
    ) {
      if (activeReadSupersession)
        throw new Error(
          `Read supersession already active: ${activeReadSupersession.cause}`,
        );
      if (paths.length === 0 || new Set(paths).size !== paths.length)
        throw new Error("Read supersession paths must be non-empty and unique");
      if (
        Object.entries(maxCounts).some(
          ([path, count]) =>
            !paths.includes(path) ||
            !Number.isInteger(count) ||
            (count ?? 0) < 1,
        )
      )
        throw new Error(
          "Read supersession counts must be positive integers for listed paths",
        );
      activeReadSupersession = {
        cause,
        startIndex: networkErrors.length,
        startRequestOrder: eventSequence,
        allow: paths.map((path) => ({
          method: "GET" as const,
          path,
          error: "net::ERR_ABORTED" as const,
          maxCount: maxCounts[path] ?? 1,
        })),
        pending: new Set<Request>(),
      };
    },
    async endReadSupersession(
      includeDeferredFailures = false,
      requireInitialReplacementPath?: string,
    ) {
      if (!activeReadSupersession)
        throw new Error("No read supersession is active");
      const ending = activeReadSupersession;
      while (ending.pending.size > 0)
        await Promise.all(
          [...ending.pending].map(
            (request) => readSettlements.get(request)?.promise,
          ),
        );
      const endRequestOrder = eventSequence;
      if (requireInitialReplacementPath) {
        const allowance = ending.allow.find(
          ({ method, path }) =>
            method === "GET" && path === requireInitialReplacementPath,
        );
        if (!allowance)
          throw new Error(
            `No GET supersession allowance for ${requireInitialReplacementPath}`,
          );
        const proof = initialReadReplacementProof(
          requestLifecycles,
          requireInitialReplacementPath,
          ending.startRequestOrder,
          endRequestOrder,
        );
        expect(proof.valid, proof.reason).toBe(true);
        allowance.eligibleRequestIds = proof.acceptedAbortRequestIds;
      }
      const { pending: _pending, ...completed } = ending;
      readSupersessions.push({
        ...completed,
        endIndex: includeDeferredFailures ? "finish" : networkErrors.length,
        endRequestOrder,
      });
      activeReadSupersession = undefined;
    },
    readSupersessions,
    hasActiveReadSupersession() {
      return activeReadSupersession !== undefined;
    },
    changeEntry(value: unknown) {
      entry = value;
    },
  };
}

async function selectLocalFiles(page: Page) {
  await page
    .getByRole("button", { name: "Nova importação", exact: true })
    .click();
  await page.getByRole("combobox", { name: /cartão/i }).selectOption(CARD);
  await page.locator('input[type="file"]').setInputFiles(FILES);
}
const consent = (page: Page) =>
  page.getByRole("button", {
    name: "Analisar e guardar rascunho",
    exact: true,
  });
const mutationCounts = (requests: RequestFact[]) => [
  requests.filter((r) => r.method === "POST" && r.path === "/import-sessions")
    .length,
  requests.filter((r) => r.method === "POST" && r.path.endsWith("/attachments"))
    .length,
  requests.filter((r) => r.method === "PUT").length,
  requests.filter((r) => r.method === "POST" && r.path.endsWith("/analyze"))
    .length,
];

async function openSeededRecovery(
  page: Page,
  wire: Awaited<ReturnType<typeof syntheticWire>>,
) {
  const detailPath = `/import-sessions/${SESSION}`;
  wire.beginReadSupersession(
    "seeded deeplink hydration supersedes its initial session detail read",
    [detailPath],
  );
  await page.goto(`${PATH}?importSessionId=${SESSION}`);
  await expect(
    page.getByRole("region", {
      name: "Conversa da importação",
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(
      () =>
        wire.responses.filter(
          (response) =>
            response.method === "GET" &&
            response.path === detailPath &&
            response.status === 200,
        ).length,
    )
    .toBe(1);
  await wire.endReadSupersession(false, detailPath);
}

const INTENTIONAL_CROSS_PANEL_LABEL_DUPLICATES = {
  Enviar: ["financial-copilot", "maria-import"],
};

async function collectPanelButtonLabels(
  panels: Record<string, Locator>,
  expectedDuplicates: Record<string, string[]> = {},
) {
  const labelsByPanel: Record<string, string[]> = {};
  for (const [panel, root] of Object.entries(panels)) {
    const labels = await root.getByRole("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const ariaLabel = button.getAttribute("aria-label")?.trim();
        const text = button.textContent?.replace(/\s+/g, " ").trim();
        return ariaLabel || text || "";
      }),
    );
    expect(labels).not.toContain("");
    labelsByPanel[panel] = [...labels].sort();
  }

  const occurrences = new Map<string, string[]>();
  for (const [panel, labels] of Object.entries(labelsByPanel))
    for (const label of labels)
      occurrences.set(label, [...(occurrences.get(label) ?? []), panel]);
  const duplicates = Object.fromEntries(
    [...occurrences.entries()]
      .filter(([, panelsForLabel]) => panelsForLabel.length > 1)
      .map(([label, panelsForLabel]) => [label, [...panelsForLabel].sort()])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  expect(duplicates).toEqual(expectedDuplicates);
  await test.info().attach("public-entry-panel-button-labels", {
    body: JSON.stringify({ labelsByPanel, duplicates }, null, 2),
    contentType: "application/json",
  });
  return labelsByPanel;
}

async function target(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const result = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = (x: number, y: number) => {
      const top = document.elementFromPoint(x, y);
      return top === element || (top !== null && element.contains(top));
    };
    return {
      width: rect.width,
      height: rect.height,
      center: hit(rect.x + rect.width / 2, rect.y + rect.height / 2),
      corner: hit(rect.x + 8, rect.y + 8),
    };
  });
  expect(result.width).toBeGreaterThanOrEqual(44);
  expect(result.height).toBeGreaterThanOrEqual(44);
  expect([result.center, result.corner]).toEqual([true, true]);
}

function initialReadReplacementProof(
  lifecycles: RequestLifecycleFact[],
  path: string,
  afterOrder: number,
  throughOrder: number,
) {
  const reads = lifecycles
    .filter(
      (request) =>
        request.method === "GET" &&
        request.path === path &&
        request.startedOrder > afterOrder &&
        request.startedOrder <= throughOrder,
    )
    .sort((left, right) => left.startedOrder - right.startedOrder);
  const aborted = reads.filter(
    (request) => request.failure?.error === "net::ERR_ABORTED",
  );
  if (aborted.length === 0) {
    const successful = reads.some(
      (request) => request.response?.status === 200,
    );
    return {
      valid: successful,
      reason: successful
        ? "No superseded read required acceptance"
        : "Seeded detail hydration had neither a 200 response nor an abort",
      acceptedAbortRequestIds: [] as number[],
    };
  }
  if (aborted.length !== 1)
    return {
      valid: false,
      reason: `Expected at most one aborted seeded detail read, received ${aborted.length}`,
      acceptedAbortRequestIds: [] as number[],
    };
  const initial = reads[0];
  const failed = aborted[0];
  if (!initial || failed.requestId !== initial.requestId)
    return {
      valid: false,
      reason: "The aborted seeded detail read was not the initial request",
      acceptedAbortRequestIds: [] as number[],
    };
  if (!failed.failure)
    return {
      valid: false,
      reason: "The initial seeded detail read has no failure event",
      acceptedAbortRequestIds: [] as number[],
    };
  const replacement = reads.find(
    (request) =>
      request.startedOrder > failed.startedOrder &&
      request.response?.status === 200 &&
      request.response.order > failed.failure!.order &&
      request.response.atMs > failed.failure!.atMs,
  );
  if (!replacement)
    return {
      valid: false,
      reason:
        "The initial aborted seeded detail read had no later 200 replacement",
      acceptedAbortRequestIds: [] as number[],
    };
  return {
    valid: true,
    reason: "Initial seeded detail read was replaced by a later 200 response",
    acceptedAbortRequestIds: [failed.requestId],
  };
}

function partitionNetworkErrors(
  errors: NetworkErrorFact[],
  windows: ReadSupersessionWindow[],
) {
  const accepted: AcceptedSupersededRead[] = [];
  const unexpected: NetworkErrorFact[] = [];
  const counts = new Map<string, number>();
  errors.forEach((error, index) => {
    const window = windows.find(
      (candidate) =>
        index >= candidate.startIndex &&
        (candidate.endIndex === "finish" || index < candidate.endIndex),
    );
    const allowance = window?.allow.find(
      (candidate) =>
        candidate.method === error.method &&
        candidate.path === error.path &&
        candidate.error === error.error &&
        (candidate.eligibleRequestIds === undefined ||
          (error.requestId !== undefined &&
            candidate.eligibleRequestIds.includes(error.requestId))),
    );
    const key =
      window && allowance
        ? `${window.cause}\u0000${allowance.method}\u0000${allowance.path}`
        : "";
    const count = key ? (counts.get(key) ?? 0) : 0;
    if (window && allowance && count < allowance.maxCount) {
      counts.set(key, count + 1);
      accepted.push({ ...error, cause: window.cause });
    } else {
      unexpected.push(error);
    }
  });
  return { accepted, unexpected };
}

async function finishEvidence(
  page: Page,
  wire: Awaited<ReturnType<typeof syntheticWire>>,
  expectedHttp: Array<{ method: string; path: string; status: number }> = [],
  expectedNetwork: Array<{
    method: string;
    path: string;
    error: string | RegExp;
  }> = [],
) {
  if (wire.hasActiveReadSupersession())
    throw new Error("Read supersession window was not closed after assertions");
  const partitionedNetwork = partitionNetworkErrors(
    wire.networkErrors,
    wire.readSupersessions,
  );
  const expectedHttpWithoutSupersededReads = expectedHttp.filter(
    (httpError) =>
      !partitionedNetwork.accepted.some(
        (networkError) =>
          networkError.method === httpError.method &&
          networkError.path === httpError.path,
      ),
  );
  expect(wire.unexpected).toEqual([]);
  expect(wire.consoleErrors).toEqual([]);
  expect([expectedHttp, expectedHttpWithoutSupersededReads]).toContainEqual(
    wire.httpErrors,
  );
  expect(
    partitionedNetwork.unexpected.map(({ method, path, error }) => ({
      method,
      path,
      error,
    })),
  ).toEqual(
    expectedNetwork.map((error) => ({
      ...error,
      error:
        typeof error.error === "string"
          ? error.error
          : expect.stringMatching(error.error),
    })),
  );
  for (const error of wire.resourceErrors) {
    expect(
      [...expectedHttp, ...expectedNetwork, ...partitionedNetwork.accepted].map(
        (fact) => fact.path,
      ),
    ).toContain(new URL(error.url).pathname);
  }
  await test.info().attach("public-entry-wire-and-errors", {
    body: JSON.stringify(
      {
        requests: wire.requests,
        httpErrors: wire.httpErrors,
        networkErrors: wire.networkErrors,
        requestLifecycles: wire.requestLifecycles,
        responses: wire.responses,
        acceptedSupersededReadCount: partitionedNetwork.accepted.length,
        acceptedSupersededReads: partitionedNetwork.accepted,
        readSupersessionWindows: wire.readSupersessions,
        consoleErrors: wire.consoleErrors,
        resourceErrors: wire.resourceErrors,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}

for (const width of [375, 390, 1280]) {
  test.describe(`PublicEntry synthetic protocol @${width}`, () => {
    test.use({ viewport: { width, height: width === 1280 ? 800 : 844 } });
    test("consent_is_first_write_and_own_url_echo_keeps_one_live_document_sequence", async ({
      page,
    }, info) => {
      const wire = await syntheticWire(page, { hold: "PUT" });
      await page.goto(PATH);
      await selectLocalFiles(page);
      expect(wire.writes()).toEqual([]);
      await target(consent(page));
      await page.screenshot({
        path: info.outputPath(`${width}-before-consent.png`),
      });
      wire.beginReadSupersession(
        "own URL publication supersedes its prefetched Maria document",
        [PATH],
      );
      await consent(page).dblclick();
      await expect
        .poll(() => mutationCounts(wire.requests))
        .toEqual([1, 1, 1, 0]);
      await expect(page).toHaveURL(new RegExp(`importSessionId=${SESSION}`));
      expect(
        wire.requests.filter((r) => r.path.endsWith("/attachments"))[0]?.body,
      ).toEqual({
        expectedRevision: 1,
        files: FILES.map((file) => ({
          id: expect.any(String),
          fileName: file.name,
          declaredBytes: file.buffer.length,
          mime: file.mimeType,
        })),
      });
      const created = record(
        wire.requests.find(
          (r) => r.method === "POST" && r.path === "/import-sessions",
        )?.body,
      );
      expect(created).toEqual({
        version: 1,
        cardId: CARD,
        createRequestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        consentPolicyVersion: 1,
        consentAnalyze: true,
      });
      // The first PUT remains blocked across the CREATE URL/presentation echo.
      expect(mutationCounts(wire.requests)).toEqual([1, 1, 1, 0]);
      wire.fault.release();
      await wire.faultDone.promise;
      await expect
        .poll(() => mutationCounts(wire.requests))
        .toEqual([1, 1, 2, 0]);
      expect(
        wire.requests.filter((r) => r.method === "PUT").map((r) => r.bytes),
      ).toEqual(FILES.map((file) => file.buffer));
      await page.screenshot({
        path: info.outputPath(`${width}-raw-pending.png`),
      });
      await wire.endReadSupersession();
      await finishEvidence(page, wire);
    });
  });
}

test.describe("PublicEntry synthetic faults @375", () => {
  test.use({ viewport: { width: 375, height: 844 } });
  test("one_list_read_serves_page_and_entry_and_preconsent_cancel_is_local", async ({
    page,
  }) => {
    const wire = await syntheticWire(page);
    await page.goto(PATH);
    await expect(
      page.getByRole("button", { name: "Nova importação", exact: true }),
    ).toBeVisible();
    expect(
      wire.requests.filter(
        (r) => r.path === "/import-sessions" && r.method === "GET",
      ),
    ).toHaveLength(1);
    await selectLocalFiles(page);
    const selectedFiles = page.getByRole("list", {
      name: "Arquivos selecionados",
      exact: true,
    });
    const alphaItem = selectedFiles
      .getByRole("listitem")
      .filter({ hasText: "alpha.csv" });
    const betaItem = selectedFiles
      .getByRole("listitem")
      .filter({ hasText: "beta.csv" });
    const alphaRemove = alphaItem.getByRole("button", {
      name: "Remover arquivo 1: alpha.csv",
      exact: true,
    });
    const betaRemove = betaItem.getByRole("button", {
      name: "Remover arquivo 2: beta.csv",
      exact: true,
    });
    await expect(
      selectedFiles.getByRole("button", {
        name: /^Remover arquivo \d+: /,
      }),
    ).toHaveCount(2);
    await expect(alphaRemove).toHaveAccessibleName(
      "Remover arquivo 1: alpha.csv",
    );
    await expect(betaRemove).toHaveAccessibleName(
      "Remover arquivo 2: beta.csv",
    );
    await alphaRemove.click();
    await expect(alphaItem).toHaveCount(0);
    await expect(betaItem).toHaveCount(1);
    await expect(
      betaItem.getByRole("button", {
        name: "Remover arquivo 1: alpha.csv",
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(
      betaItem.getByRole("button", {
        name: "Remover arquivo 1: beta.csv",
        exact: true,
      }),
    ).toHaveAccessibleName("Remover arquivo 1: beta.csv");
    await page
      .getByRole("button", { name: "Cancelar seleção", exact: true })
      .click();
    await expect(consent(page)).toBeDisabled();
    expect(wire.writes()).toEqual([]);
    const controls = partitionNetworkErrors(
      [
        { method: "GET", path: PATH, error: "net::ERR_ABORTED" },
        { method: "GET", path: PATH, error: "net::ERR_ABORTED" },
        { method: "GET", path: PATH, error: "net::ERR_ABORTED" },
        { method: "POST", path: PATH, error: "net::ERR_ABORTED" },
        { method: "PUT", path: PATH, error: "net::ERR_ABORTED" },
        { method: "GET", path: "/agent/chat", error: "net::ERR_ABORTED" },
        {
          method: "GET",
          path: "/tenant/credit-cards",
          error: "net::ERR_ABORTED",
        },
        { method: "GET", path: PATH, error: "net::ERR_CONNECTION_RESET" },
      ],
      [
        {
          cause: "control: only an in-window document GET is superseded",
          startIndex: 1,
          endIndex: 8,
          startRequestOrder: 0,
          endRequestOrder: 0,
          allow: [
            {
              method: "GET",
              path: PATH,
              error: "net::ERR_ABORTED",
              maxCount: 1,
            },
          ],
        },
      ],
    );
    expect(controls.accepted).toEqual([
      {
        method: "GET",
        path: PATH,
        error: "net::ERR_ABORTED",
        cause: "control: only an in-window document GET is superseded",
      },
    ]);
    expect(controls.unexpected).toEqual([
      { method: "GET", path: PATH, error: "net::ERR_ABORTED" },
      { method: "GET", path: PATH, error: "net::ERR_ABORTED" },
      { method: "POST", path: PATH, error: "net::ERR_ABORTED" },
      { method: "PUT", path: PATH, error: "net::ERR_ABORTED" },
      { method: "GET", path: "/agent/chat", error: "net::ERR_ABORTED" },
      {
        method: "GET",
        path: "/tenant/credit-cards",
        error: "net::ERR_ABORTED",
      },
      { method: "GET", path: PATH, error: "net::ERR_CONNECTION_RESET" },
    ]);
    const detailPath = `/import-sessions/${SESSION}`;
    const detailControls = partitionNetworkErrors(
      [
        { method: "GET", path: detailPath, error: "net::ERR_ABORTED" },
        { method: "GET", path: detailPath, error: "net::ERR_ABORTED" },
        { method: "POST", path: detailPath, error: "net::ERR_ABORTED" },
        {
          method: "GET",
          path: `/import-sessions/${OTHER_SESSION}`,
          error: "net::ERR_ABORTED",
        },
      ],
      [
        {
          cause: "control: only the in-window session detail GET is superseded",
          startIndex: 1,
          endIndex: 4,
          startRequestOrder: 0,
          endRequestOrder: 0,
          allow: [
            {
              method: "GET",
              path: detailPath,
              error: "net::ERR_ABORTED",
              maxCount: 1,
            },
          ],
        },
      ],
    );
    expect(detailControls.accepted).toEqual([
      {
        method: "GET",
        path: detailPath,
        error: "net::ERR_ABORTED",
        cause: "control: only the in-window session detail GET is superseded",
      },
    ]);
    expect(detailControls.unexpected).toEqual([
      { method: "GET", path: detailPath, error: "net::ERR_ABORTED" },
      { method: "POST", path: detailPath, error: "net::ERR_ABORTED" },
      {
        method: "GET",
        path: `/import-sessions/${OTHER_SESSION}`,
        error: "net::ERR_ABORTED",
      },
    ]);
    expect(
      initialReadReplacementProof(
        [
          {
            requestId: 1,
            method: "GET",
            path: detailPath,
            startedOrder: 1,
            startedAtMs: 10,
            response: { status: 200, order: 2, atMs: 11 },
            finished: { order: 3, atMs: 12 },
          },
          {
            requestId: 2,
            method: "GET",
            path: detailPath,
            startedOrder: 4,
            startedAtMs: 13,
            failure: {
              error: "net::ERR_ABORTED",
              order: 5,
              atMs: 14,
            },
          },
        ],
        detailPath,
        0,
        5,
      ),
    ).toEqual({
      valid: false,
      reason: "The aborted seeded detail read was not the initial request",
      acceptedAbortRequestIds: [],
    });
    await finishEvidence(page, wire);
  });
  test("own_url_publication_does_not_abort_pending_reservation", async ({
    page,
  }) => {
    const wire = await syntheticWire(page, { hold: "RESERVE" });
    await page.goto(PATH);
    await selectLocalFiles(page);
    wire.beginReadSupersession(
      "own URL publication supersedes its prefetched Maria document",
      [PATH],
    );
    await consent(page).click();
    await expect
      .poll(() => mutationCounts(wire.requests))
      .toEqual([1, 1, 0, 0]);
    await expect(page).toHaveURL(new RegExp(`importSessionId=${SESSION}`));
    wire.fault.release();
    await wire.faultDone.promise;
    await expect
      .poll(() => mutationCounts(wire.requests))
      .toEqual([1, 1, 2, 0]);
    await wire.endReadSupersession();
    await finishEvidence(page, wire);
  });
  test("invalid_refresh_drops_old_positive_entry_but_preserves_recovery_page", async ({
    page,
  }) => {
    const wire = await syntheticWire(page);
    await page.goto(PATH);
    await expect(
      page.getByRole("button", { name: "Nova importação", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Importações da Maria", exact: true })
      .click();
    wire.changeEntry({ kind: "CARD_INVOICE", formats: [] });
    await page.getByRole("tab", { name: "Concluídas", exact: true }).click();
    await page.getByRole("tab", { name: "Em andamento", exact: true }).click();
    await expect(page.getByRole("alert").first()).toBeVisible();
    await expect(page.getByTestId("import-session-row")).toHaveCount(1);
    await expect(
      page.getByRole("button", { name: "Nova importação", exact: true }),
    ).toHaveCount(0);
    expect(wire.writes()).toEqual([]);
    await finishEvidence(page, wire);
  });
  test("unknown_create_result_requires_explicit_retry_with_same_identity", async ({
    page,
  }) => {
    const wire = await syntheticWire(page, { lose: "CREATE" });
    await page.goto(PATH);
    await selectLocalFiles(page);
    await consent(page).click();
    await wire.faultDone.promise;
    await expect(page.getByRole("alert").first()).toBeVisible();
    await page
      .getByRole("button", {
        name: /^(?:Consultar estado guardado|Consultar estado dos documentos|Consultar novamente)$/,
      })
      .click();
    await expect
      .poll(
        () =>
          wire.requests.filter(
            (r) => r.path === "/import-sessions" && r.method === "GET",
          ).length,
      )
      .toBe(2);
    await expect(page).not.toHaveURL(/importSessionId=/);
    expect(mutationCounts(wire.requests)).toEqual([1, 0, 0, 0]);
    wire.beginReadSupersession(
      "explicit CREATE retry publishes the owned URL over its prefetch",
      [PATH],
    );
    await page
      .getByRole("button", {
        name: /^(?:Repetir esta tentativa|Tentar novamente|Tentar de novo)$/,
      })
      .click();
    await expect
      .poll(() => mutationCounts(wire.requests))
      .toEqual([2, 1, 2, 0]);
    const creates = wire.requests.filter(
      (r) => r.path === "/import-sessions" && r.method === "POST",
    );
    expect(creates[1]?.body).toEqual(creates[0]?.body);
    await wire.endReadSupersession();
    await finishEvidence(
      page,
      wire,
      [],
      [
        {
          method: "POST",
          path: "/import-sessions",
          error: /^net::ERR_CONNECTION_RESET$/,
        },
      ],
    );
  });
  test("generic_route_sends_no_importTurn_or_documentary_write", async ({
    page,
  }) => {
    const wire = await syntheticWire(page, { entry: UNAVAILABLE });
    await page.goto(PATH);
    await page.getByRole("textbox").last().fill("Como esta meu mes?");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect
      .poll(() => wire.requests.filter((r) => r.path === "/agent/chat").length)
      .toBe(1);
    await expect
      .poll(() => wire.httpErrors)
      .toEqual([{ method: "POST", path: "/agent/chat", status: 429 }]);
    expect(
      record(wire.requests.find((r) => r.path === "/agent/chat")?.body),
    ).not.toHaveProperty("importTurn");
    expect(wire.writes()).toEqual([]);
    await finishEvidence(page, wire, [
      { method: "POST", path: "/agent/chat", status: 429 },
    ]);
  });
  for (const id of ["", "invalid/id", "inaccessible-session"]) {
    test(`invalid_or_inaccessible_deeplink_is_explicit_not_generic_${id}`, async ({
      page,
    }) => {
      const wire = await syntheticWire(page);
      if (id === "inaccessible-session")
        wire.beginReadSupersession(
          "invalid detail result supersedes its own session read",
          ["/import-sessions/inaccessible-session"],
        );
      await page.goto(`${PATH}?importSessionId=${encodeURIComponent(id)}`);
      await expect(page.getByRole("alert").first()).toBeVisible();
      await expect(page.getByRole("textbox")).toHaveCount(0);
      expect(wire.writes()).toEqual([]);
      expect(wire.requests.filter((r) => r.path === "/agent/chat")).toEqual([]);
      if (id === "inaccessible-session") {
        await expect
          .poll(
            () =>
              wire.httpErrors.filter(
                (error) =>
                  error.method === "GET" &&
                  error.path === "/import-sessions/inaccessible-session" &&
                  error.status === 404,
              ).length +
              wire.networkErrors.filter(
                (error) =>
                  error.method === "GET" &&
                  error.path === "/import-sessions/inaccessible-session" &&
                  error.error === "net::ERR_ABORTED",
              ).length,
          )
          .toBeGreaterThan(0);
        await wire.endReadSupersession(true);
      }
      const expectedDetailHttp = [
        {
          method: "GET",
          path: "/import-sessions/inaccessible-session",
          status: 404,
        },
      ];
      await finishEvidence(
        page,
        wire,
        id === "inaccessible-session" ? expectedDetailHttp : [],
      );
    });
  }
  for (const [name, options] of [
    ["missing", { omitEntry: true }],
    ["empty", { entry: { kind: "CARD_INVOICE", formats: [] } }],
    [
      "sparse-wire-null",
      { entry: { kind: "CARD_INVOICE", formats: Array(1) } },
    ],
    ["duplicate", { entry: { kind: "CARD_INVOICE", formats: ["CSV", "CSV"] } }],
    ["unknown", { entry: { kind: "CARD_INVOICE", formats: ["ZIP"] } }],
  ] satisfies Array<[string, WireOptions]>) {
    test(`valid_recovery_page_survives_${name}_entry_without_enabling_intake`, async ({
      page,
    }) => {
      const wire = await syntheticWire(page, options);
      await page.goto(PATH);
      await expect(page.getByRole("alert").first()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Nova importação", exact: true }),
      ).toHaveCount(0);
      await page
        .getByRole("button", { name: "Importações da Maria", exact: true })
        .click();
      await expect(page.getByTestId("import-session-row")).toHaveCount(1);
      await page.getByTestId("import-session-row").click();
      await expect(
        page.getByRole("button", { name: "Cancelar importação", exact: true }),
      ).toBeVisible();
      expect(wire.writes()).toEqual([]);
      await finishEvidence(page, wire);
    });
  }
  for (const badPage of [
    { items: null, nextCursor: null, entry: POSITIVE },
    { items: [summary], nextCursor: 17, entry: POSITIVE },
    {
      items: [{ ...summary, actions: ["INVENTED"] }],
      nextCursor: null,
      entry: POSITIVE,
    },
  ]) {
    test(`invalid_page_is_not_salvaged_${JSON.stringify(badPage)}`, async ({
      page,
    }) => {
      const wire = await syntheticWire(page, { page: badPage });
      await page.goto(PATH);
      await page
        .getByRole("button", { name: "Importações da Maria", exact: true })
        .click();
      await expect(page.getByRole("alert").first()).toBeVisible();
      await expect(page.getByTestId("import-session-row")).toHaveCount(0);
      expect(wire.writes()).toEqual([]);
      await finishEvidence(page, wire);
    });
  }
  for (const source of ["list", "cards"] as const) {
    for (const status of [403, 500]) {
      test(`${source}_${status}_does_not_become_empty_success`, async ({
        page,
      }) => {
        const wire = await syntheticWire(
          page,
          source === "list" ? { listStatus: status } : { cardStatus: status },
        );
        await page.goto(PATH);
        if (source === "cards")
          await page
            .getByRole("button", { name: "Nova importação", exact: true })
            .click();
        else
          await page
            .getByRole("button", { name: "Importações da Maria", exact: true })
            .click();
        await expect(page.getByRole("alert").first()).toBeVisible();
        expect(wire.writes()).toEqual([]);
        await finishEvidence(page, wire, [
          {
            method: "GET",
            path:
              source === "list" ? "/import-sessions" : "/tenant/credit-cards",
            status,
          },
        ]);
      });
    }
  }
  test("operational_recovery_selects_authorized_context_and_reload_does_not_create", async ({
    page,
  }) => {
    const wire = await syntheticWire(page, { operational: true });
    await page.goto(PATH);
    await page
      .getByRole("button", { name: "Importações da Maria", exact: true })
      .click();
    await page.getByTestId("import-session-row").click();
    wire.beginReadSupersession(
      "continuation URL publication supersedes the prefetched Maria document",
      [PATH],
    );
    await page
      .getByRole("button", { name: "Continuar na Maria", exact: true })
      .click();
    await expect(page).toHaveURL(new RegExp(`importSessionId=${SESSION}`));
    await wire.endReadSupersession();
    wire.beginReadSupersession(
      "explicit reload supersedes Maria document and session detail reads",
      [PATH, `/import-sessions/${SESSION}`],
    );
    await page.reload();
    expect(wire.writes()).toEqual([]);
    await wire.endReadSupersession();
    await finishEvidence(page, wire);
  });
  test("synthetic_eligible_references_use_received_nonconsecutive_revisions_once", async ({
    page,
  }) => {
    const wire = await syntheticWire(page, { analyzable: true });
    await page.goto(PATH);
    await selectLocalFiles(page);
    wire.beginReadSupersession(
      "document workflow publication supersedes Maria document and session detail reads",
      [PATH, `/import-sessions/${SESSION}`],
    );
    await consent(page).click();
    await expect
      .poll(() => mutationCounts(wire.requests))
      .toEqual([1, 1, 2, 2]);
    expect(
      wire.requests
        .filter((r) => r.path.endsWith("/analyze"))
        .map((r) => r.body),
    ).toEqual([{ expectedRevision: 19 }, { expectedRevision: 29 }]);
    const analyzeRequests = wire.requests.filter(
      (request) =>
        request.method === "POST" && request.path.endsWith("/analyze"),
    );
    await expect
      .poll(() =>
        wire.responses
          .filter(
            (response) =>
              response.method === "POST" && response.path.endsWith("/analyze"),
          )
          .map((response) => ({
            method: response.method,
            path: response.path,
            status: response.status,
          })),
      )
      .toEqual(
        analyzeRequests.map((request) => ({
          method: request.method,
          path: request.path,
          status: 200,
        })),
      );
    await wire.endReadSupersession();
    await finishEvidence(page, wire);
  });
  for (const change of ["user", "project", "session", "unmount"] as const) {
    test(`external_${change}_fences_late_create_without_resurrection`, async ({
      page,
    }) => {
      const wire = await syntheticWire(page, { hold: "CREATE" });
      await page.goto(PATH);
      await selectLocalFiles(page);
      await consent(page).click();
      await expect
        .poll(() => mutationCounts(wire.requests))
        .toEqual([1, 0, 0, 0]);
      if (change === "user") {
        wire.beginReadSupersession(
          "user-menu logout routing supersedes authorization documents",
          ["/no-permission", "/login"],
          { "/no-permission": 2, "/login": 2 },
        );
        await page.getByRole("button", { name: /^Mais opções \(7\)$/ }).click();
        await page
          .getByRole("button", { name: "Sair (QA)", exact: true })
          .click();
        await expect(page).toHaveURL(/\/login$/);
      } else if (change === "project")
        await page.goto(`/projects/${OTHER_PROJECT}/maria`);
      else if (change === "session")
        await page.evaluate(
          (url) => window.history.pushState(null, "", url),
          `${PATH}?importSessionId=${OTHER_SESSION}`,
        );
      else await page.goto("/projects");
      wire.fault.release();
      await wire.faultDone.promise;
      await expect(page).not.toHaveURL(
        new RegExp(`importSessionId=${SESSION}(?:&|$)`),
      );
      expect(mutationCounts(wire.requests)).toEqual([1, 0, 0, 0]);
      expect(wire.requests.filter((r) => r.path.endsWith("/cancel"))).toEqual(
        [],
      );
      if (change === "user") {
        // Chromium may deliver requestfailed after the causal assertions even
        // though the auth-document requests were superseded by this logout.
        await wire.endReadSupersession(true);
      }
      await finishEvidence(
        page,
        wire,
        [],
        [
          {
            method: "POST",
            path: "/import-sessions",
            error: /^net::ERR_ABORTED$/,
          },
        ],
      );
    });
  }
  for (const phase of ["CREATE", "RESERVE", "PUT", "ANALYZE"] as const) {
    test(`uncertain_${phase}_is_GET_first_not_automatic_replay`, async ({
      page,
    }) => {
      const wire = await syntheticWire(page, {
        lose: phase,
        analyzable: phase === "ANALYZE",
      });
      await page.goto(PATH);
      await selectLocalFiles(page);
      wire.beginReadSupersession(
        `uncertain ${phase} publication supersedes its prefetched Maria document`,
        [PATH],
      );
      await consent(page).click();
      await wire.faultDone.promise;
      await expect(page.getByRole("alert").first()).toBeVisible();
      await wire.endReadSupersession();
      const before = wire.requests.length;
      if (phase !== "CREATE")
        wire.beginReadSupersession(
          `uncertain ${phase} recovery supersedes its session detail read`,
          [`/import-sessions/${SESSION}`],
        );
      await page
        .getByRole("button", {
          name: /^(?:Consultar estado guardado|Consultar estado dos documentos|Consultar novamente|Tentar de novo|Repetir esta tentativa)$/,
        })
        .click();
      await expect
        .poll(
          () =>
            wire.requests
              .slice(before)
              .filter((r) => r.path.startsWith("/import-sessions")).length,
        )
        .toBeGreaterThan(0);
      const first = wire.requests
        .slice(before)
        .find((r) => r.path.startsWith("/import-sessions"));
      expect([first?.method, first?.path]).toEqual([
        "GET",
        phase === "CREATE" ? "/import-sessions" : `/import-sessions/${SESSION}`,
      ]);
      expect(mutationCounts(wire.requests)).toEqual(
        phase === "CREATE"
          ? [1, 0, 0, 0]
          : phase === "RESERVE"
            ? [1, 1, 0, 0]
            : phase === "PUT"
              ? [1, 1, 1, 0]
              : [1, 1, 2, 1],
      );
      if (phase === "CREATE")
        await expect(page).not.toHaveURL(/importSessionId=/);
      const failed = wire.requests.find((request) =>
        phase === "CREATE"
          ? request.method === "POST" && request.path === "/import-sessions"
          : phase === "RESERVE"
            ? request.path.endsWith("/attachments")
            : phase === "PUT"
              ? request.method === "PUT"
              : request.path.endsWith("/analyze"),
      );
      if (!failed) throw new Error("Lost-response phase was not reached");
      if (phase !== "CREATE") await wire.endReadSupersession();
      await finishEvidence(
        page,
        wire,
        [],
        [
          {
            method: failed.method,
            path: failed.path,
            error: /^net::ERR_CONNECTION_RESET$/,
          },
        ],
      );
    });
  }
  test("contextual_429_never_falls_back_to_generic_or_financial_confirmation", async ({
    page,
  }) => {
    const wire = await syntheticWire(page, { entry: UNAVAILABLE });
    await openSeededRecovery(page, wire);
    await page.getByRole("textbox").last().fill("sim");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect
      .poll(() => wire.requests.filter((r) => r.path === "/agent/chat").length)
      .toBe(1);
    await expect
      .poll(() => wire.httpErrors)
      .toEqual([{ method: "POST", path: "/agent/chat", status: 429 }]);
    await expect(page.getByRole("alert").first()).toBeVisible();
    const chats = wire.requests.filter((r) => r.path === "/agent/chat");
    expect(chats).toHaveLength(1);
    expect(record(record(chats[0]?.body).importTurn)).toMatchObject({
      sessionId: SESSION,
      expectedRevision: 1,
      literalAnswer: "sim",
    });
    expect(
      wire.requests.filter((r) =>
        /\/(challenge|confirm|execute)$/.test(r.path),
      ),
    ).toEqual([]);
    const mariaLabels = await collectPanelButtonLabels({
      "maria-import": page.getByRole("region", {
        name: "Conversa da importação",
        exact: true,
      }),
    });
    expect(mariaLabels).toEqual({
      "maria-import": [
        "Consultar estado guardado",
        "Enviar",
        "Iniciar conversa por voz",
        "Responder por voz",
      ],
    });
    expect(wire.writes()).toEqual([]);
    await finishEvidence(page, wire, [
      { method: "POST", path: "/agent/chat", status: 429 },
    ]);
  });
});

test.describe("PublicEntry contextual/financial channel separation @1280", () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test("financial_widget_does_not_inherit_the_open_import_session", async ({
    page,
  }) => {
    const wire = await syntheticWire(page, { entry: UNAVAILABLE });
    await openSeededRecovery(page, wire);
    await page.getByRole("textbox").last().fill("sim");
    await page.getByRole("button", { name: "Enviar", exact: true }).click();
    await expect
      .poll(() => wire.requests.filter((r) => r.path === "/agent/chat").length)
      .toBe(1);
    await expect
      .poll(() => wire.httpErrors)
      .toEqual([{ method: "POST", path: "/agent/chat", status: 429 }]);
    await expect(page.getByRole("alert").first()).toBeVisible();
    await page
      .getByRole("button", { name: "Abrir Copiloto Financeiro", exact: true })
      .click();
    const genericInput = page.getByPlaceholder(
      "Pergunte sobre suas finanças...",
      { exact: true },
    );
    await genericInput.fill("Como esta meu mes?");
    await genericInput.press("Enter");
    await expect
      .poll(() => wire.requests.filter((r) => r.path === "/agent/chat").length)
      .toBe(2);
    await expect
      .poll(() => wire.httpErrors)
      .toEqual([
        { method: "POST", path: "/agent/chat", status: 429 },
        { method: "POST", path: "/agent/chat", status: 429 },
      ]);
    const chats = wire.requests.filter((r) => r.path === "/agent/chat");
    expect(record(record(chats[0]?.body).importTurn).sessionId).toBe(SESSION);
    expect(record(chats[1]?.body)).not.toHaveProperty("importTurn");
    const financialForm = page.locator("form").filter({
      has: page.getByPlaceholder("Pergunte sobre suas finanças...", {
        exact: true,
      }),
    });
    const labels = await collectPanelButtonLabels(
      {
        "maria-import": page.getByRole("region", {
          name: "Conversa da importação",
          exact: true,
        }),
        "financial-copilot": financialForm.locator(".."),
      },
      INTENTIONAL_CROSS_PANEL_LABEL_DUPLICATES,
    );
    expect(labels).toEqual({
      "maria-import": [
        "Consultar estado guardado",
        "Enviar",
        "Iniciar conversa por voz",
        "Responder por voz",
      ],
      "financial-copilot": [
        "Abrir conversa por voz",
        "Enviar",
        "Falar com o copiloto",
        "Fechar",
        "Ouvir",
      ],
    });
    expect(wire.writes()).toEqual([]);
    await finishEvidence(page, wire, [
      { method: "POST", path: "/agent/chat", status: 429 },
      { method: "POST", path: "/agent/chat", status: 429 },
    ]);
  });
});

function ipc(
  child: ChildProcess,
  kind: string,
  timeoutMs: number,
  request?: object,
): Promise<Record<string, unknown>> {
  return new Promise((done, fail) => {
    let timer: NodeJS.Timeout;
    let sendComplete = request === undefined;
    let response: Record<string, unknown> | undefined;
    const finish = () => {
      if (!sendComplete || !response) return;
      cleanup();
      done(response);
    };
    const reject = (error: Error) => {
      cleanup();
      fail(error);
    };
    const onError = (error: Error) =>
      reject(new Error(`Fixture error before ${kind}`, { cause: error }));
    const onExit = (code: number | null) => {
      reject(new Error(`Fixture exited before ${kind}: ${code}`));
    };
    const onClose = (code: number | null) => {
      reject(new Error(`Fixture closed before ${kind}: ${code}`));
    };
    const onMessage = (raw: unknown) => {
      try {
        const message = record(raw);
        if (message.kind === "ERROR") {
          reject(new Error(String(message.message)));
        } else if (message.kind === kind) {
          response = message;
          finish();
        }
      } catch (error) {
        reject(
          new Error(`Fixture sent an invalid message before ${kind}`, {
            cause: error,
          }),
        );
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("message", onMessage);
    };
    timer = setTimeout(
      () => reject(new Error(`Fixture timed out waiting for ${kind}`)),
      timeoutMs,
    );
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("message", onMessage);
    if (request) {
      try {
        child.send(request, (error) => {
          if (error)
            reject(
              new Error(`Fixture failed to send request for ${kind}`, {
                cause: error,
              }),
            );
          else {
            sendComplete = true;
            finish();
          }
        });
      } catch (error) {
        reject(
          new Error(`Fixture threw while sending request for ${kind}`, {
            cause: error,
          }),
        );
      }
    }
  });
}

function closeFixture(child: ChildProcess): Promise<void> {
  return new Promise((done, fail) => {
    let timer: NodeJS.Timeout;
    let sent = false;
    let closedMessage = false;
    let exited = false;
    let closed = false;
    const finish = () => {
      if (!sent || !closedMessage || !exited || !closed) return;
      cleanup();
      done();
    };
    const reject = (error: Error) => {
      cleanup();
      fail(error);
    };
    const onError = (error: Error) =>
      reject(
        new Error("Fixture emitted an error during CLOSE", { cause: error }),
      );
    const onMessage = (raw: unknown) => {
      try {
        const message = record(raw);
        if (message.kind === "ERROR")
          reject(new Error(String(message.message)));
        else if (message.kind === "CLOSED") {
          closedMessage = true;
          finish();
        }
      } catch (error) {
        reject(
          new Error("Fixture sent an invalid message during CLOSE", {
            cause: error,
          }),
        );
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0 || signal !== null)
        return reject(
          new Error(
            `Fixture exit was not clean: code=${code} signal=${signal}`,
          ),
        );
      exited = true;
      finish();
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (code !== 0 || signal !== null)
        return reject(
          new Error(
            `Fixture close was not clean: code=${code} signal=${signal}`,
          ),
        );
      closed = true;
      finish();
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("close", onClose);
    };
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Fixture CLOSE timed out: sent=${sent} CLOSED=${closedMessage} exit=${exited} close=${closed}`,
          ),
        ),
      10_000,
    );
    child.on("error", onError);
    child.on("message", onMessage);
    child.on("exit", onExit);
    child.on("close", onClose);
    if (!child.connected)
      return reject(new Error("Fixture IPC was disconnected before CLOSE"));
    try {
      child.send({ kind: "CLOSE" }, (error) => {
        if (error)
          reject(new Error("Fixture failed to send CLOSE", { cause: error }));
        else {
          sent = true;
          finish();
        }
      });
    } catch (error) {
      reject(new Error("Fixture threw while sending CLOSE", { cause: error }));
    }
  });
}

function waitForProcessStop(
  child: ChildProcess,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve(true);
  return new Promise((done, fail) => {
    let exited = false;
    let closed = false;
    const finish = () => {
      if (!exited || !closed) return;
      cleanup();
      done(true);
    };
    const onError = (error: Error) => {
      cleanup();
      fail(error);
    };
    const onExit = () => {
      exited = true;
      finish();
    };
    const onClose = () => {
      closed = true;
      finish();
    };
    const timer = setTimeout(() => {
      cleanup();
      done(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("close", onClose);
    if (child.exitCode !== null || child.signalCode !== null) {
      cleanup();
      done(true);
    }
  });
}

async function cleanupFailedFixture(
  child: ChildProcess | undefined,
): Promise<Error | undefined> {
  try {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    if (await waitForProcessStop(child, 5_000)) return;
    const pid = child.pid;
    if (typeof pid !== "number" || pid <= 0)
      return new Error("Fixture cleanup has no known child PID");
    const escalations = [`Fixture PID ${pid} required SIGTERM`];
    if (!child.kill("SIGTERM"))
      escalations.push(`Fixture PID ${pid} rejected SIGTERM`);
    if (await waitForProcessStop(child, 3_000))
      return new Error(escalations.join("; "));
    escalations.push(`Fixture PID ${pid} required SIGKILL`);
    if (!child.kill("SIGKILL"))
      escalations.push(`Fixture PID ${pid} rejected SIGKILL`);
    if (!(await waitForProcessStop(child, 2_000)))
      escalations.push(`Fixture PID ${pid} remained alive after SIGKILL`);
    return new Error(escalations.join("; "));
  } catch (error) {
    return new Error("Fixture cleanup observation failed", { cause: error });
  }
}

test.describe("PublicEntry REAL default-OFF route; seeded recovery, not RAW extraction", () => {
  let child: ChildProcess | undefined;
  test.beforeAll(async () => {
    let starting: ChildProcess | undefined;
    try {
      starting = fork(
        resolve(
          "../api/src/test-utils/import-session.entry.browser-fixture.gatespec.ts",
        ),
        [],
        {
          cwd: resolve("../api"),
          execArgv: ["-r", "ts-node/register"],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            TZ: "UTC",
            NODE_ENV: "test",
            NODE_OPTIONS: `--require=${resolve("../../scripts/test-db-env.cjs")}`,
            JWT_SECRET: "public-entry-disposable-test-secret-20261008-only",
            AUTH_ENABLE_REGISTER: "1",
            CORS_ORIGIN: "http://127.0.0.1:43142",
          },
          stdio: ["ignore", "inherit", "inherit", "ipc"],
        },
      );
      child = starting;
      await ipc(starting, "READY", 15_000);
    } catch (error) {
      const cleanup = await cleanupFailedFixture(starting);
      if (cleanup)
        throw new AggregateError(
          [error, cleanup],
          "Fixture startup and cleanup failed",
        );
      throw error;
    }
  });
  test.afterAll(async () => {
    if (!child) return;
    try {
      await closeFixture(child);
    } catch (error) {
      const cleanup = await cleanupFailedFixture(child);
      if (cleanup)
        throw new AggregateError(
          [error, cleanup],
          "Fixture CLOSE and cleanup failed",
        );
      throw error;
    }
  });
  for (const width of [375, 390, 1280]) {
    test(`real_signup_OFF_recovery_deeplink_and_layout_${width}`, async ({
      page,
    }, info) => {
      await page.setViewportSize({ width, height: width === 1280 ? 800 : 844 });
      await page.clock.setFixedTime(new Date(INSTANT));
      const failures: string[] = [];
      const writes: string[] = [];
      const unauthenticatedAuthProbe = {
        responses: 0,
        resourceErrors: 0,
      };
      page.on("pageerror", (error) =>
        failures.push(`pageerror ${error.message}`),
      );
      page.on("console", (message) => {
        if (message.type() !== "error") return;
        const location = message.location().url;
        if (
          message.text().startsWith("Failed to load resource:") &&
          location &&
          new URL(location).pathname === "/auth/me"
        ) {
          unauthenticatedAuthProbe.resourceErrors++;
          return;
        }
        failures.push(`console ${message.text()}`);
      });
      page.on("response", (response) => {
        if (response.status() < 400) return;
        const request = response.request();
        const url = new URL(response.url());
        if (
          response.status() === 401 &&
          request.method() === "GET" &&
          url.origin === API &&
          url.pathname === "/auth/me"
        ) {
          unauthenticatedAuthProbe.responses++;
          return;
        }
        failures.push(`${response.status()} ${response.url()}`);
      });
      page.on("request", (request) => {
        if (
          new URL(request.url()).pathname.startsWith("/import-sessions") &&
          request.method() !== "GET"
        )
          writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      });
      await page.route("**/*", (route) => {
        if (new URL(route.request().url()).hostname !== "127.0.0.1") {
          failures.push(`external ${route.request().url()}`);
          return route.abort("blockedbyclient");
        }
        return route.continue();
      });
      await page.goto("/register");
      await page.getByLabel(/^seu nome$/i).fill("PublicEntry QA");
      await page
        .getByLabel(/email/i)
        .fill(`public-entry-${width}@example.test`);
      await page.getByLabel(/^senha$/i).fill("Local-only-qa-credential-2026");
      await page
        .getByRole("checkbox", { name: /organizar minha vida financeira/i })
        .check();
      await page.getByRole("button", { name: /criar minha conta/i }).click();
      await expect(page).toHaveURL(/\/projects\/[^/]+\/conta$/);
      await page
        .getByRole("button", { name: "Fechar jornada", exact: true })
        .click();
      const meResponse = await page.request.get(`${API}/auth/me`);
      expect(meResponse.status()).toBe(200);
      const me = record(await meResponse.json());
      const projectsResponse = await page.request.get(`${API}/projects`);
      expect(projectsResponse.status()).toBe(200);
      const projects: unknown = await projectsResponse.json();
      if (!Array.isArray(projects))
        throw new Error("Signup project list is invalid");
      const pessoalProjects = projects
        .map(record)
        .filter((row) => row.type === "PESSOAL");
      expect(pessoalProjects).toHaveLength(1);
      const [owned] = pessoalProjects;
      if (typeof me.id !== "string" || typeof owned?.id !== "string")
        throw new Error("Real signup did not create its owner/project");
      if (!child) throw new Error("Fixture was not initialized");
      const seed = await ipc(child, "RECOVERY", 10_000, {
        kind: "RECOVERY",
        userId: me.id,
        projectId: owned.id,
      });
      const path = `/projects/${owned.id}/maria`;
      await page.goto(path);
      await expect(page.getByRole("textbox").last()).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Nova importação", exact: true }),
      ).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      const recovery = page.getByRole("button", {
        name: "Importações da Maria",
        exact: true,
      });
      await target(recovery);
      await recovery.click();
      const recoveryRow = page.getByTestId("import-session-row");
      await expect(recoveryRow).toHaveCount(1);
      await recoveryRow.click();
      await target(
        page.getByRole("button", { name: "Cancelar importação", exact: true }),
      );
      await page.screenshot({
        path: info.outputPath(`${width}-real-off-recovery.png`),
      });
      await page.goto(`${path}?importSessionId=${seed.draftId}`);
      await page.reload();
      await expect(page).toHaveURL(
        new RegExp(`importSessionId=${seed.draftId}`),
      );
      expect(writes).toEqual([]);
      await page.goto(path);
      await recovery.click();
      await page.getByRole("tab", { name: "Concluídas", exact: true }).click();
      await expect(recoveryRow).toHaveCount(1);
      await recoveryRow.click();
      const resultResponse = await page.request.get(
        `${API}/import-sessions/${seed.appliedId}/result`,
      );
      expect(resultResponse.status()).toBe(200);
      const result = record(await resultResponse.json());
      expect(result.state).toBe("APPLIED");
      const receipt = record(result.receipt);
      const snapshot = record(receipt.snapshot);
      expect(receipt.items).toEqual([
        expect.objectContaining({ outcome: "CREATED" }),
      ]);
      expect(snapshot.createdEconomicTotalCents).toBe(2_147_483_647);
      expect(snapshot.lines).toEqual([
        expect.objectContaining({ totalCents: 2_147_483_647 }),
      ]);
      const money = page.getByText(/21\.474\.836,47/).first();
      await expect(money).toBeVisible();
      expect(
        await money.evaluate((el) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return new Set(
            [...range.getClientRects()].map((rect) => Math.round(rect.top)),
          ).size;
        }),
      ).toBe(1);
      expect(await money.textContent()).toMatch(/21\.474\.836,47/);
      expect(await money.textContent()).not.toMatch(/[-−]/);
      await page.screenshot({
        path: info.outputPath(`${width}-real-recovery-positive-money.png`),
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(writes).toEqual([]);
      expect(unauthenticatedAuthProbe).toEqual({
        responses: 2,
        resourceErrors: 2,
      });
      expect(failures).toEqual([]);
    });
  }
});
