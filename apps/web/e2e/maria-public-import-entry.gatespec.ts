import "../../../scripts/test-db-env.cjs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from "@playwright/test";
import type { ImportSessionViewV1 } from "@reformaflow/domain";

const PORT = Number(process.env.PLAYWRIGHT_PORT ?? 3013);
const WEB_ORIGIN = `http://localhost:${PORT}`;
const API_BASE = new URL(
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001",
);
const API_ORIGIN = API_BASE.origin;
const API_PREFIX = API_BASE.pathname.replace(/\/+$/, "");
const PROJECT = "ordered-browser-project";
const SESSION = "ordered-browser-session";
const OTHER_SESSION = "ordered-browser-other-session";
const CARD = "ordered-browser-card";
const INSTANT = "2026-10-10T12:00:00.000Z";
const EXPIRES_AT = "2026-10-17T12:00:00.000Z";
const MARIA_PATH = `/projects/${PROJECT}/maria`;
const SESSION_URL = `${MARIA_PATH}?importSessionId=${SESSION}`;
const DETAIL_PATH = `/import-sessions/${SESSION}`;

const user = {
  id: "ordered-browser-user",
  username: "ordered-browser-user",
  name: "QA",
  role: "OWNER",
  tenantId: "ordered-browser-tenant",
  allowedModules: [],
  allowedProjects: [PROJECT],
  allowedProjectTypes: ["PESSOAL"],
};
const project = {
  id: PROJECT,
  name: "Pessoal QA",
  type: "PESSOAL",
  onboardedAt: INSTANT,
};
const sessionView = (id = SESSION): ImportSessionViewV1 => ({
  version: 1,
  id,
  ownerProjectId: PROJECT,
  cardId: CARD,
  state: "DRAFT",
  revision: 1,
  expiresAt: EXPIRES_AT,
  attachments: [],
  lines: [],
  selectedLineIds: [],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["UPLOAD", "CANCEL"],
});
const summary = {
  id: SESSION,
  state: "DRAFT",
  revision: 1,
  cardId: CARD,
  ownerProjectId: PROJECT,
  createdAt: INSTANT,
  expiresAt: EXPIRES_AT,
  appliedAt: null,
  attachmentCount: 0,
  hasConfirmation: false,
  continuationSessionId: null,
  actions: ["UPLOAD", "CANCEL"],
};

type Lifecycle = {
  requestId: number;
  method: string;
  origin: string;
  path: string;
  startedOrder: number;
  response?: { status: number; order: number };
  failure?: { error: string; order: number };
  finished?: { order: number };
  bodySessionId?: string | null;
  bodyRead?: "complete" | "failed";
};

type DetailStep =
  | { kind: "hold" }
  | { kind: "json"; bodySessionId: string }
  | { kind: "failed-body" };

type DetailServer = {
  origin: string;
  setPlan: (steps: DetailStep[]) => void;
  detailRequestCount: () => number;
  abortedRequestOrdinals: () => number[];
  close: () => Promise<void>;
};

type BrowserEvidence = {
  detailReads: Lifecycle[];
  drainBodyReads: () => Promise<void>;
};

type Harness = {
  server: DetailServer;
  evidence: BrowserEvidence;
  unexpectedRequests: string[];
};

function apiPath(pathname: string) {
  if (!API_PREFIX) return pathname;
  if (pathname === API_PREFIX) return "/";
  return pathname.startsWith(`${API_PREFIX}/`)
    ? pathname.slice(API_PREFIX.length)
    : pathname;
}

function corsHeaders(request: Request) {
  const headers = request.headers();
  return {
    "Access-Control-Allow-Origin": headers.origin ?? WEB_ORIGIN,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers":
      headers["access-control-request-headers"] ??
      "content-type,x-rf-import-ui",
  };
}

function jsonResponse(request: Request, value: unknown, status = 200) {
  return {
    status,
    contentType: "application/json",
    headers: corsHeaders(request),
    body: JSON.stringify(value),
  };
}

function serverCorsHeaders(request: IncomingMessage) {
  const origin =
    typeof request.headers.origin === "string"
      ? request.headers.origin
      : WEB_ORIGIN;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers":
      request.headers["access-control-request-headers"] ??
      "content-type,x-rf-import-ui",
    Vary: "Origin",
  };
}

async function createDetailServer(): Promise<DetailServer> {
  let plan: DetailStep[] = [];
  let requestCount = 0;
  const aborted = new Set<number>();
  const sockets = new Set<import("node:net").Socket>();

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method !== "GET" || url.pathname !== DETAIL_PATH) {
      response.writeHead(404, serverCorsHeaders(request));
      response.end();
      return;
    }

    const ordinal = ++requestCount;
    const step = plan.shift() ?? { kind: "json", bodySessionId: SESSION };
    if (step.kind === "hold") {
      response.once("close", () => {
        if (!response.writableEnded) aborted.add(ordinal);
      });
      return;
    }

    const body = Buffer.from(
      JSON.stringify(
        sessionView(step.kind === "json" ? step.bodySessionId : SESSION),
      ),
    );
    if (step.kind === "failed-body") {
      response.writeHead(200, {
        ...serverCorsHeaders(request),
        "Content-Type": "application/json",
        "Content-Length": String(body.byteLength + 64),
      });
      response.flushHeaders();
      response.write(body.subarray(0, Math.min(48, body.byteLength)), () =>
        response.destroy(),
      );
      return;
    }

    response.writeHead(200, {
      ...serverCorsHeaders(request),
      "Content-Type": "application/json",
      "Content-Length": String(body.byteLength),
    });
    response.end(body);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    setPlan(steps) {
      if (requestCount !== 0)
        throw new Error(
          "Detail response plan must be set before the first read",
        );
      plan = [...steps];
    },
    detailRequestCount: () => requestCount,
    abortedRequestOrdinals: () =>
      [...aborted].sort((left, right) => left - right),
    async close() {
      if (!server.listening) return;
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await closed;
    },
  };
}

function collectBrowserEvidence(context: BrowserContext): BrowserEvidence {
  const detailReads: Lifecycle[] = [];
  const byRequest = new WeakMap<Request, Lifecycle>();
  const pendingBodyReads = new Set<Promise<void>>();
  let requestSequence = 0;
  let eventSequence = 0;

  context.on("request", (request) => {
    const requestId = ++requestSequence;
    const url = new URL(request.url());
    const path = apiPath(url.pathname);
    if (
      url.origin !== API_ORIGIN ||
      request.method() !== "GET" ||
      path !== DETAIL_PATH
    ) {
      eventSequence++;
      return;
    }
    const lifecycle: Lifecycle = {
      requestId,
      method: request.method(),
      origin: url.origin,
      path,
      startedOrder: ++eventSequence,
    };
    detailReads.push(lifecycle);
    byRequest.set(request, lifecycle);
  });
  context.on("response", (response) => {
    const order = ++eventSequence;
    const lifecycle = byRequest.get(response.request());
    if (!lifecycle) return;
    lifecycle.response = { status: response.status(), order };
    const bodyRead = response
      .json()
      .then((value: unknown) => {
        const body =
          typeof value === "object" && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : null;
        lifecycle.bodySessionId =
          body && typeof body.id === "string" ? body.id : null;
        lifecycle.bodyRead = "complete";
      })
      .catch(() => {
        lifecycle.bodySessionId = null;
        lifecycle.bodyRead = "failed";
      });
    pendingBodyReads.add(bodyRead);
    void bodyRead.then(() => pendingBodyReads.delete(bodyRead));
  });
  context.on("requestfailed", (request) => {
    const order = ++eventSequence;
    const lifecycle = byRequest.get(request);
    if (!lifecycle) return;
    lifecycle.failure = {
      error: request.failure()?.errorText ?? "missing failure",
      order,
    };
  });
  context.on("requestfinished", (request) => {
    const order = ++eventSequence;
    const lifecycle = byRequest.get(request);
    if (!lifecycle) return;
    lifecycle.finished = { order };
  });

  return {
    detailReads,
    async drainBodyReads() {
      while (pendingBodyReads.size > 0)
        await Promise.all([...pendingBodyReads]);
    },
  };
}

async function installHarness(
  context: BrowserContext,
  page: Page,
): Promise<Harness> {
  const server = await createDetailServer();
  const evidence = collectBrowserEvidence(context);
  const unexpectedRequests: string[] = [];

  await page.clock.setFixedTime(new Date(INSTANT));
  await context.addCookies([
    {
      name: "rf_token",
      value: "ordered-browser-synthetic",
      url: WEB_ORIGIN,
    },
  ]);
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === WEB_ORIGIN) return route.continue();
    if (url.origin !== API_ORIGIN) {
      unexpectedRequests.push(
        `${request.method()} ${url.origin}${url.pathname}`,
      );
      return route.abort("blockedbyclient");
    }

    const path = apiPath(url.pathname);
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: corsHeaders(request),
      });
    if (request.method() === "GET" && path === DETAIL_PATH)
      return route.continue({
        url: `${server.origin}${path}${url.search}`,
      });
    if (path === "/auth/me") return route.fulfill(jsonResponse(request, user));
    if (path === "/auth/config")
      return route.fulfill(
        jsonResponse(request, {
          registerEnabled: false,
          guestEnabled: false,
        }),
      );
    if (path === "/projects")
      return route.fulfill(jsonResponse(request, [project]));
    if (path === `/projects/${PROJECT}`)
      return route.fulfill(jsonResponse(request, project));
    if (path === "/import-sessions" && request.method() === "GET") {
      const state = url.searchParams.get("state");
      return route.fulfill(
        jsonResponse(request, {
          items: state === "applied" ? [] : [summary],
          nextCursor: null,
          entry: { kind: "CARD_INVOICE", formats: ["CSV"] },
        }),
      );
    }
    if (path === "/tenant/credit-cards")
      return route.fulfill(jsonResponse(request, []));
    if (path === "/notifications/daily-summary")
      return route.fulfill(
        jsonResponse(request, {
          data: "2026-10-10",
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
    if (path === "/journeys/eligible" || path === "/notifications")
      return route.fulfill(jsonResponse(request, []));
    if (path.endsWith("/monthly-overview"))
      return route.fulfill(jsonResponse(request, null));

    unexpectedRequests.push(`${request.method()} ${path}`);
    return route.fulfill(jsonResponse(request, { statusCode: 599 }, 599));
  });

  return { server, evidence, unexpectedRequests };
}

function safeLifecycle(lifecycle: Lifecycle) {
  return {
    requestId: lifecycle.requestId,
    method: lifecycle.method,
    origin: lifecycle.origin,
    path: lifecycle.path,
    startedOrder: lifecycle.startedOrder,
    response: lifecycle.response ?? null,
    failure: lifecycle.failure ?? null,
    finished: lifecycle.finished ?? null,
    bodySessionId: lifecycle.bodySessionId ?? null,
    bodyRead: lifecycle.bodyRead ?? null,
  };
}

async function finishEvidence(
  page: Page,
  harness: Harness,
  expectedSessionId: string,
  otherPages: Page[] = [],
) {
  await Promise.all(
    [page, ...otherPages].map((trackedPage) =>
      trackedPage.waitForLoadState("networkidle"),
    ),
  );
  await harness.evidence.drainBodyReads();
  const reads = [...harness.evidence.detailReads].sort(
    (left, right) => left.startedOrder - right.startedOrder,
  );
  await test.info().attach("maria-session-read-lifecycle", {
    body: JSON.stringify(
      {
        sessionPath: DETAIL_PATH,
        expectedBodySessionId: expectedSessionId,
        detailReads: reads.map(safeLifecycle),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  if (harness.unexpectedRequests.length > 0)
    throw new Error(
      `Unexpected browser requests: ${harness.unexpectedRequests.join(", ")}`,
    );
  if (reads.length !== 2)
    throw new Error(
      `Expected exactly two session detail GETs after drain; received ${reads.length}`,
    );

  const [initial, replacement] = reads;
  if (!initial || !replacement || initial.requestId === replacement.requestId)
    throw new Error("Session detail GETs do not have distinct request IDs");
  if (initial.origin !== API_ORIGIN || replacement.origin !== API_ORIGIN)
    throw new Error("Session detail GET was not sent to the configured API");
  if (
    !initial.failure ||
    initial.failure.error !== "net::ERR_ABORTED" ||
    initial.response ||
    initial.finished
  )
    throw new Error(
      "Initial detail GET did not abort before receiving a response",
    );
  if (initial.failure.order <= initial.startedOrder)
    throw new Error("Initial detail failure did not follow its request start");
  if (replacement.startedOrder <= initial.failure.order)
    throw new Error("Replacement detail GET started before the initial abort");
  if (replacement.failure)
    throw new Error("Replacement detail GET failed before its body completed");
  if (replacement.response?.status !== 200)
    throw new Error("Replacement detail GET did not receive HTTP 200");
  if (!replacement.finished)
    throw new Error("Replacement detail GET has no requestfinished event");
  if (replacement.finished.order <= replacement.response.order)
    throw new Error(
      "Replacement requestfinished did not follow its 200 response",
    );
  if (replacement.bodyRead !== "complete")
    throw new Error("Replacement response body could not be read completely");
  if (replacement.bodySessionId !== expectedSessionId)
    throw new Error("Replacement response body belongs to a different session");

  return { reads };
}

async function visitMariaBase(page: Page) {
  await page.goto(MARIA_PATH);
  await page.waitForLoadState("networkidle");
}

async function openSessionFromRecovery(page: Page) {
  await page
    .getByRole("button", {
      name: "Importações da Maria",
      exact: true,
    })
    .click();
  await page.getByTestId("import-session-row").click();
}

async function waitForRead(
  harness: Harness,
  ordinal: number,
): Promise<Lifecycle> {
  await expect
    .poll(() => harness.evidence.detailReads.length, { timeout: 10_000 })
    .toBe(ordinal);
  const lifecycle = harness.evidence.detailReads[ordinal - 1];
  if (!lifecycle) throw new Error(`Detail request ${ordinal} was not captured`);
  await expect
    .poll(() => harness.server.detailRequestCount(), { timeout: 10_000 })
    .toBe(ordinal);
  return lifecycle;
}

async function waitForFinished(lifecycle: Lifecycle) {
  await expect
    .poll(() => lifecycle.finished?.order, { timeout: 10_000 })
    .toBeDefined();
}

async function abortByNavigation(page: Page, lifecycle: Lifecycle) {
  await visitMariaBase(page);
  await expect
    .poll(() => lifecycle.failure?.error, { timeout: 10_000 })
    .toBe("net::ERR_ABORTED");
}

let harness: Harness | undefined;

test.beforeEach(async ({ context, page }) => {
  harness = await installHarness(context, page);
  await visitMariaBase(page);
});

test.afterEach(async ({ page }) => {
  const active = harness;
  harness = undefined;
  if (!active) return;
  if (!page.isClosed()) {
    try {
      await page.goto("about:blank", { waitUntil: "commit", timeout: 3_000 });
    } catch {
      // A failing test can already have closed or navigated the page.
    }
  }
  await active.server.close();
});

test("a held session read aborts on navigation before its completed same-session replacement", async ({
  page,
}) => {
  if (!harness) throw new Error("Browser evidence harness was not initialized");
  harness.server.setPlan([
    { kind: "hold" },
    { kind: "json", bodySessionId: SESSION },
  ]);

  await openSessionFromRecovery(page);
  const initial = await waitForRead(harness, 1);
  expect(initial.response).toBeUndefined();

  await abortByNavigation(page, initial);
  await expect
    .poll(() => harness?.server.abortedRequestOrdinals())
    .toEqual([1]);

  await openSessionFromRecovery(page);
  const replacement = await waitForRead(harness, 2);
  await waitForFinished(replacement);
  await page.waitForLoadState("networkidle");

  const { reads } = await finishEvidence(page, harness, SESSION);
  expect(reads).toHaveLength(2);
  expect(reads.map((read) => read.requestId)).toEqual([
    initial.requestId,
    replacement.requestId,
  ]);
  expect(initial.startedOrder).toBeLessThan(initial.failure!.order);
  expect(initial.failure!.order).toBeLessThan(replacement.startedOrder);
  expect(replacement.response?.status).toBe(200);
  expect(replacement.finished!.order).toBeGreaterThan(
    replacement.response!.order,
  );
  expect(replacement.bodySessionId).toBe(SESSION);
});

test("two successful reads with no abort are not supersession evidence", async ({
  page,
}) => {
  if (!harness) throw new Error("Browser evidence harness was not initialized");
  harness.server.setPlan([
    { kind: "json", bodySessionId: SESSION },
    { kind: "json", bodySessionId: SESSION },
  ]);

  await openSessionFromRecovery(page);
  const initial = await waitForRead(harness, 1);
  await waitForFinished(initial);
  await visitMariaBase(page);
  await openSessionFromRecovery(page);
  const replacement = await waitForRead(harness, 2);
  await waitForFinished(replacement);

  expect(initial.response?.status).toBe(200);
  expect(replacement.response?.status).toBe(200);
  expect(initial.finished!.order).toBeGreaterThan(initial.response!.order);
  expect(replacement.finished!.order).toBeGreaterThan(
    replacement.response!.order,
  );
  expect(initial.failure).toBeUndefined();
  expect(replacement.failure).toBeUndefined();
  expect(initial.requestId).not.toBe(replacement.requestId);
  await expect(finishEvidence(page, harness, SESSION)).rejects.toThrow(
    /Initial detail GET did not abort/,
  );
});

test("an initial 200 followed by a later same-path abort is rejected", async ({
  page,
}) => {
  if (!harness) throw new Error("Browser evidence harness was not initialized");
  harness.server.setPlan([
    { kind: "json", bodySessionId: SESSION },
    { kind: "hold" },
  ]);

  await openSessionFromRecovery(page);
  const initial = await waitForRead(harness, 1);
  await waitForFinished(initial);
  await visitMariaBase(page);
  await openSessionFromRecovery(page);
  const later = await waitForRead(harness, 2);
  expect(later.response).toBeUndefined();
  await abortByNavigation(page, later);

  expect(initial.response?.status).toBe(200);
  expect(initial.finished!.order).toBeGreaterThan(initial.response!.order);
  expect(later.failure?.error).toBe("net::ERR_ABORTED");
  await expect(finishEvidence(page, harness, SESSION)).rejects.toThrow(
    /Initial detail GET did not abort/,
  );
});

test("a replacement response for a different session body is rejected", async ({
  page,
}) => {
  if (!harness) throw new Error("Browser evidence harness was not initialized");
  harness.server.setPlan([
    { kind: "hold" },
    { kind: "json", bodySessionId: OTHER_SESSION },
  ]);

  await openSessionFromRecovery(page);
  const initial = await waitForRead(harness, 1);
  await abortByNavigation(page, initial);
  await openSessionFromRecovery(page);
  const replacement = await waitForRead(harness, 2);
  await waitForFinished(replacement);

  await harness.evidence.drainBodyReads();
  expect(replacement.response?.status).toBe(200);
  expect(replacement.bodySessionId).toBe(OTHER_SESSION);
  await expect(finishEvidence(page, harness, SESSION)).rejects.toThrow(
    /different session/,
  );
});

test("200 headers followed by a failed response body are not a completed replacement", async ({
  page,
}) => {
  if (!harness) throw new Error("Browser evidence harness was not initialized");
  harness.server.setPlan([{ kind: "hold" }, { kind: "failed-body" }]);

  await openSessionFromRecovery(page);
  const initial = await waitForRead(harness, 1);
  await abortByNavigation(page, initial);
  await openSessionFromRecovery(page);
  const replacement = await waitForRead(harness, 2);
  await expect
    .poll(() => replacement.response?.status, { timeout: 10_000 })
    .toBe(200);
  await expect
    .poll(() => replacement.failure?.error, { timeout: 10_000 })
    .toBeDefined();
  await page.waitForLoadState("networkidle");
  await harness.evidence.drainBodyReads();

  expect(replacement.finished).toBeUndefined();
  expect(replacement.bodyRead).toBe("failed");
  await expect(finishEvidence(page, harness, SESSION)).rejects.toThrow(
    /Replacement detail GET failed/,
  );
});

test("a replacement that starts before the initial abort is rejected", async ({
  page,
  context,
}) => {
  if (!harness) throw new Error("Browser evidence harness was not initialized");
  harness.server.setPlan([
    { kind: "hold" },
    { kind: "json", bodySessionId: SESSION },
  ]);

  await openSessionFromRecovery(page);
  const initial = await waitForRead(harness, 1);
  expect(initial.response).toBeUndefined();
  expect(initial.failure).toBeUndefined();
  const replacementPage = await context.newPage();
  await replacementPage.clock.setFixedTime(new Date(INSTANT));
  await visitMariaBase(replacementPage);
  await openSessionFromRecovery(replacementPage);
  const replacement = await waitForRead(harness, 2);
  await waitForFinished(replacement);
  await replacementPage.waitForLoadState("networkidle");

  await abortByNavigation(page, initial);
  expect(replacement.startedOrder).toBeLessThan(initial.failure!.order);
  await expect(
    finishEvidence(page, harness, SESSION, [replacementPage]),
  ).rejects.toThrow(/started before the initial abort/);
});

test("a duplicate detail GET after the initial two-read drain is rejected", async ({
  page,
}) => {
  if (!harness) throw new Error("Browser evidence harness was not initialized");
  harness.server.setPlan([
    { kind: "hold" },
    { kind: "json", bodySessionId: SESSION },
    { kind: "json", bodySessionId: SESSION },
  ]);

  await openSessionFromRecovery(page);
  const initial = await waitForRead(harness, 1);
  await abortByNavigation(page, initial);
  await openSessionFromRecovery(page);
  const replacement = await waitForRead(harness, 2);
  await waitForFinished(replacement);

  const proof = await finishEvidence(page, harness, SESSION);
  expect(proof.reads).toHaveLength(2);

  await visitMariaBase(page);
  await openSessionFromRecovery(page);
  const duplicate = await waitForRead(harness, 3);
  await waitForFinished(duplicate);
  await expect(finishEvidence(page, harness, SESSION)).rejects.toThrow(
    /exactly two session detail GETs after drain; received 3/,
  );
});
