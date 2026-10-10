import "../../../scripts/test-db-env.cjs";

import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  expect,
  test,
  type Locator,
  type Page,
  type Request,
  type TestInfo,
} from "@playwright/test";

const HOST = "127.0.0.1";
const requiredPort = (name: string) => {
  const literal = process.env[name];
  const port = Number(literal);
  if (
    literal === undefined ||
    !/^\d+$/.test(literal) ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65_535
  )
    throw new Error(`${name} must be an integer from 1024 to 65535`);
  return port;
};
const API_PORT = requiredPort("MARIA_CSV_REAL_API_PORT");
const WEB_PORT = requiredPort("MARIA_CSV_REAL_WEB_PORT");
if (API_PORT === WEB_PORT)
  throw new Error(
    "MARIA_CSV_REAL_API_PORT and MARIA_CSV_REAL_WEB_PORT must be distinct",
  );
const API = `http://${HOST}:${API_PORT}`;
const WEB = `http://${HOST}:${WEB_PORT}`;
const PORT_PREFLIGHT = resolve("e2e/maria-csv-import-real/port-preflight.cjs");
const INSTANT = "2026-10-09T03:00:00.000Z";
const FIXTURE_READY_TIMEOUT_MS = 60_000;
const CSV = Buffer.from(
  [
    "date,title,amount",
    "2026-10-03,LOJA GEMEA,100.01",
    "2026-10-03,LOJA GEMEA,100.01",
    "2026-10-04,MATERIAL REFORMA,250.00",
    "2026-10-05,PAGAMENTO EFETUADO,-450.02",
    "",
  ].join("\n"),
  "utf8",
);
const CSV_SHA256 = createHash("sha256").update(CSV).digest("hex");
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;

type Wire = Record<string, unknown>;

function record(value: unknown): Wire {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected a wire object");
  return value as Wire;
}

function list(value: unknown): Wire[] {
  if (!Array.isArray(value)) throw new Error("Expected a wire array");
  return value.map(record);
}

function expectCanonicalGuidedReview(value: unknown) {
  const guidedReview = record(value);
  expect(Object.keys(guidedReview).sort()).toEqual([
    "actions",
    "focus",
    "progress",
  ]);
  expect(["ANSWERING", "READY", "READY_WITH_PENDING"]).toContain(
    guidedReview.progress,
  );
  expect(Array.isArray(guidedReview.actions)).toBe(true);
  expect(JSON.stringify(guidedReview)).not.toMatch(
    /"version"|"question"|"line"|"projectLabel"|"roomLabel"|"provenance"/,
  );
  if (guidedReview.focus === null)
    return { guidedReview, focus: null as Wire | null };

  const focus = record(guidedReview.focus);
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
  expect(typeof focus.questionId).toBe("string");
  expect(typeof focus.lineId).toBe("string");
  expect(typeof focus.prompt).toBe("string");
  expect(["DECISION", "TARGETS", "EXPENSE_TYPE", "LABOR_CATEGORY"]).toContain(
    focus.control,
  );
  for (const [ordinal, total] of [
    [focus.purchaseOrdinal, focus.purchaseTotal],
    [focus.questionOrdinal, focus.questionTotal],
  ]) {
    expect(Number.isSafeInteger(ordinal)).toBe(true);
    expect(Number.isSafeInteger(total)).toBe(true);
    expect(Number(ordinal)).toBeGreaterThanOrEqual(1);
    expect(Number(ordinal)).toBeLessThanOrEqual(Number(total));
  }
  const context = record(focus.context);
  expect(Object.keys(context).sort()).toEqual(
    ["title", "merchant", "amountCents", "purchaseDate"].sort(),
  );
  const options = list(focus.options);
  expect(options.length).toBeGreaterThan(0);
  for (const option of options) {
    expect(Object.keys(option).sort()).toEqual(["answer", "label"]);
    expect(typeof option.label).toBe("string");
    expect(String(option.label).trim()).toBe(option.label);
    expect(String(option.label).length).toBeGreaterThan(0);
    const answer = record(option.answer);
    expect(Object.keys(answer).sort()).toEqual(["kind", "value"]);
    expect(answer.kind).toBe(focus.control);
    if (focus.control !== "TARGETS") continue;
    expect(Array.isArray(answer.value)).toBe(true);
    if (!Array.isArray(answer.value)) continue;
    expect([0, 1]).toContain(answer.value.length);
    if (answer.value.length === 1) {
      const target = record(answer.value[0]);
      expect(Object.keys(target).sort()).toEqual([
        "amountCents",
        "projectId",
        "roomId",
      ]);
      expect(typeof target.projectId).toBe("string");
      expect(target.roomId === null || typeof target.roomId === "string").toBe(
        true,
      );
      expect(Number.isSafeInteger(target.amountCents)).toBe(true);
      expect(Number(target.amountCents)).toBeGreaterThan(0);
    }
  }
  return { guidedReview, focus };
}

function matchingGuidedOptionLabel(focus: Wire, answer: unknown) {
  const option = list(focus.options).find(
    (candidate) => JSON.stringify(candidate.answer) === JSON.stringify(answer),
  );
  if (!option || typeof option.label !== "string")
    throw new Error("Canonical guided option is missing");
  return option.label;
}

function interpretationInvariant(snapshot: Wire) {
  const sessions = list(snapshot.sessions).map((session) => {
    const draft = record(JSON.parse(String(session.draftJson)) as unknown);
    const { interpretationLedger: _ledger, ...semanticDraft } = draft;
    return {
      id: session.id,
      state: session.state,
      revision: session.revision,
      draft: semanticDraft,
    };
  });
  return {
    sessions,
    expenses: snapshot.expenses,
    receipts: snapshot.receipts,
    cashFlowEntries: snapshot.cashFlowEntries,
    allocations: snapshot.allocations,
    settlements: snapshot.settlements,
    funding: snapshot.funding,
    merchantRules: snapshot.merchantRules,
    claimedObservations: snapshot.claimedObservations,
  };
}

function ipc(
  child: ChildProcess,
  kind: string,
  input: Wire = {},
  timeoutMs = 20_000,
  responseKind = kind,
  sendRequest = true,
): Promise<Wire> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Fixture IPC ${kind} timed out`)),
      timeoutMs,
    );
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Fixture exited before ${kind}: code=${code} signal=${signal}`,
        ),
      );
    };
    const onMessage = (raw: unknown) => {
      const message = record(raw);
      if (message.kind === "ERROR") {
        cleanup();
        reject(new Error(String(message.message)));
      } else if (message.kind === responseKind) {
        cleanup();
        resolvePromise(message);
      }
    };
    child.on("message", onMessage);
    child.on("error", onError);
    child.on("exit", onExit);
    if (sendRequest)
      child.send({ kind, ...input }, (error) => {
        if (error) onError(error);
      });
  });
}

async function closeFixture(child: ChildProcess) {
  await ipc(child, "CLOSE", {}, 20_000, "CLOSED");
  await new Promise<void>((resolvePromise, reject) => {
    if (child.exitCode !== null) return resolvePromise();
    const timer = setTimeout(
      () => reject(new Error("Fixture did not exit after CLOSED")),
      10_000,
    );
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null) resolvePromise();
      else
        reject(
          new Error(`Fixture close failed: code=${code} signal=${signal}`),
        );
    });
  });
}

function portEvidence(port: number) {
  const lsof = spawnSync(
    "lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpctn"],
    { encoding: "utf8" },
  );
  return {
    status: lsof.status,
    stdout: lsof.stdout,
    stderr: lsof.stderr,
  };
}

function startFixture(importSessionInstant?: string) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    TZ: "UTC",
    NODE_ENV: "test",
    NODE_OPTIONS: `--require=${resolve("../../scripts/test-db-env.cjs")}`,
    JWT_SECRET: "maria-csv-real-disposable-test-secret",
    AUTH_ENABLE_REGISTER: "1",
    CORS_ORIGIN: WEB,
    MARIA_CSV_REAL_API_PORT: String(API_PORT),
    MARIA_CSV_REAL_WEB_PORT: String(WEB_PORT),
  };
  delete env.MARIA_CSV_REAL_IMPORT_SESSION_INSTANT;
  if (importSessionInstant !== undefined) {
    env.MARIA_CSV_REAL_IMPORT_SESSION_INSTANT = importSessionInstant;
  }
  return fork(
    resolve("../api/test/maria-csv-import.real-fixture.gatespec.ts"),
    [],
    {
      cwd: resolve("../api"),
      execArgv: ["-r", "ts-node/register"],
      env,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    },
  );
}

async function expectFixtureBootRejected(
  importSessionInstant: string | undefined,
  expectedMessage: string,
) {
  const before = portEvidence(API_PORT);
  expect(before.status).toBe(1);
  expect(before.stdout).toBe("");

  const candidate = startFixture(importSessionInstant);
  const messages: Wire[] = [];
  const boundSamples: string[] = [];
  let cleanup: Promise<void> | undefined;
  const samplePort = () => {
    const evidence = portEvidence(API_PORT);
    if (evidence.status === 0) boundSamples.push(evidence.stdout);
  };
  const sampler = setInterval(samplePort, 25);
  candidate.on("message", (raw: unknown) => {
    const message = record(raw);
    messages.push(message);
    if (message.kind === "READY" && !cleanup) {
      samplePort();
      cleanup = closeFixture(candidate);
    }
  });

  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolvePromise, reject) => {
    candidate.once("error", reject);
    candidate.once("exit", (code, signal) => resolvePromise({ code, signal }));
  }).finally(() => clearInterval(sampler));
  if (cleanup) await cleanup;

  expect(messages).toEqual([{ kind: "ERROR", message: expectedMessage }]);
  expect(exit).toEqual({ code: 1, signal: null });
  expect(boundSamples).toEqual([]);
  const after = portEvidence(API_PORT);
  expect(after.status).toBe(1);
  expect(after.stdout).toBe("");
}

async function targetEvidence(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate((element) => {
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
}

async function expectTarget(locator: Locator, label: string) {
  const evidence = await targetEvidence(locator);
  expect(evidence.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(evidence.height, `${label} height`).toBeGreaterThanOrEqual(44);
  expect(evidence.hit, `${label} center hit-test`).toBe(true);
  return evidence;
}

async function answerDeterministicDocumentQuestion(
  page: Page,
  conversation: Locator,
  sessionId: string,
  purchaseTitle: string,
  savedQuestionIds: Set<string>,
) {
  const form = conversation.locator("form").first();
  const heading = await form.getByRole("heading").innerText();
  if (heading === "Esse valor é o total da compra ou o valor de uma parcela?") {
    await form
      .getByRole("radio", { name: "É o total da compra", exact: true })
      .check();
  } else if (
    heading === "Qual é o valor desta compra?" ||
    heading === "Qual é o total da compra?"
  ) {
    await form
      .getByLabel("Sua resposta", { exact: true })
      .fill(purchaseTitle === "MATERIAL REFORMA" ? "250,00" : "100,01");
  } else if (heading === "Em quantas parcelas esta compra foi feita?") {
    await form.getByLabel("Sua resposta", { exact: true }).fill("1");
  } else if (heading === "Qual é a data do primeiro vencimento?") {
    await form.getByLabel("Sua resposta", { exact: true }).fill("2026-10-28");
  } else if (heading === "Qual é o número desta parcela?") {
    await form.getByLabel("Sua resposta", { exact: true }).fill("1");
  } else {
    throw new Error(`Unexpected deterministic question: ${heading}`);
  }
  await form
    .getByRole("button", { name: "Conferir informação", exact: true })
    .click();
  const preview = page.getByRole("region", {
    name: "Prévia da informação",
  });
  await expect(preview).not.toContainText("2026-10-03,LOJA GEMEA,100.01");
  await expect(preview).not.toContainText("2026-10-04,MATERIAL REFORMA,250.00");
  const saveDocumentary = preview.getByRole("button", {
    name: "Guardar e continuar",
    exact: true,
  });
  const saveInformation = preview.getByRole("button", {
    name: "Guardar informação",
    exact: true,
  });
  await expect
    .poll(
      async () =>
        (await saveDocumentary.count()) + (await saveInformation.count()),
    )
    .toBe(1);
  const documentary = (await saveDocumentary.count()) === 1;
  const save = documentary ? saveDocumentary : saveInformation;
  await expect(
    documentary ? saveInformation : saveDocumentary,
    "deterministic documentary and provider-interpreted CTAs must not collapse",
  ).toHaveCount(0);
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return (
      candidate.request().method() === "POST" &&
      /^\/import-sessions\/[^/]+\/(?:resolutions|declarations)$/.test(
        url.pathname,
      )
    );
  });
  await save.click();
  const saved = await response;
  const savedText = await saved.text();
  expect(saved.status(), `${heading}: ${savedText}`).toBe(200);
  const receipt = record(JSON.parse(savedText) as unknown);
  const body = record(saved.request().postDataJSON());
  expect(typeof body.questionId).toBe("string");
  expect(Number.isSafeInteger(body.expectedRevision)).toBe(true);
  expect(receipt.revision).toBe(Number(body.expectedRevision) + 1);
  expect(
    savedQuestionIds.has(String(body.questionId)),
    `documentary question ${String(body.questionId)} was saved twice`,
  ).toBe(false);
  savedQuestionIds.add(String(body.questionId));

  const advancedResponse = await page.request.get(
    `${API}/import-sessions/${sessionId}`,
  );
  expect(advancedResponse.status()).toBe(200);
  const advanced = record(await advancedResponse.json());
  expect(advanced.revision).toBe(receipt.revision);
  const questions = list(advanced.questions);
  const pendingQuestions = questions.filter(
    (question) =>
      question.answerState === undefined ||
      question.answerState === "UNANSWERED",
  );
  expect(
    pendingQuestions.some((question) => question.id === body.questionId),
    "the saved server question must leave the pending set",
  ).toBe(false);
  expect(new URL(saved.url()).pathname.endsWith("/declarations")).toBe(
    documentary,
  );
  const nextQuestion = documentary
    ? pendingQuestions.find((question) => question.subject !== undefined)
    : pendingQuestions[0];
  if (nextQuestion) {
    expect(nextQuestion.id).toEqual(expect.any(String));
    expect(nextQuestion.id).not.toBe(body.questionId);
  }
  if (documentary) {
    const currentQuestion = questions.find(
      (question) => question.id === body.questionId,
    );
    expect(currentQuestion?.subject).toMatchObject({
      kind: "OBSERVATION",
      observationId: expect.any(String),
    });
    expect(currentQuestion?.answerState).not.toBe("UNANSWERED");
    if (nextQuestion) {
      expect(nextQuestion.subject).toMatchObject({
        kind: "OBSERVATION",
        observationId: expect.any(String),
      });
    }
  }
  await expect(preview).toHaveCount(0);
  await expect
    .poll(async () => {
      const continuation = conversation.getByRole("button", {
        name: /^(Continuar respondendo|Revisar as prontas agora)$/,
      });
      if (await continuation.isVisible()) return true;
      const nextForm = conversation.locator("form").first();
      if (!(await nextForm.isVisible())) return false;
      const answer = nextForm.getByLabel("Sua resposta", { exact: true });
      if ((await answer.count()) === 1 && (await answer.inputValue()) !== "")
        return false;
      if ((await nextForm.locator('input[type="radio"]:checked').count()) !== 0)
        return false;
      return nextForm
        .getByRole("button", {
          name: "Conferir informação",
          exact: true,
        })
        .isDisabled();
    })
    .toBe(true);
  return {
    heading,
    path: new URL(saved.url()).pathname,
    body,
  };
}

function mutationKey(request: Request) {
  const url = new URL(request.url());
  if (
    url.origin !== API ||
    !url.pathname.startsWith("/import-sessions") ||
    request.method() === "GET"
  )
    return null;
  const normalized = url.pathname
    .replace(/\/import-sessions\/[^/]+/, "/import-sessions/:id")
    .replace(/\/attachments\/[^/]+/, "/attachments/:id");
  return `${request.method()} ${normalized}`;
}

test.describe.serial("Maria CSV private fixture clock boot contract", () => {
  test("requires distinct in-range API and web ports before lsof", () => {
    for (const scenario of [
      {
        name: "missing API",
        mutate: (env: NodeJS.ProcessEnv) => delete env.MARIA_CSV_REAL_API_PORT,
        error: "MARIA_CSV_REAL_API_PORT must be an integer from 1024 to 65535",
      },
      {
        name: "privileged web",
        mutate: (env: NodeJS.ProcessEnv) => {
          env.MARIA_CSV_REAL_WEB_PORT = "80";
          return true;
        },
        error: "MARIA_CSV_REAL_WEB_PORT must be an integer from 1024 to 65535",
      },
      {
        name: "missing web",
        mutate: (env: NodeJS.ProcessEnv) => delete env.MARIA_CSV_REAL_WEB_PORT,
        error: "MARIA_CSV_REAL_WEB_PORT must be an integer from 1024 to 65535",
      },
      {
        name: "same ports",
        mutate: (env: NodeJS.ProcessEnv) => {
          env.MARIA_CSV_REAL_WEB_PORT = String(API_PORT);
          return true;
        },
        error:
          "MARIA_CSV_REAL_API_PORT and MARIA_CSV_REAL_WEB_PORT must be distinct",
      },
    ]) {
      const env = { ...process.env };
      scenario.mutate(env);
      const result = spawnSync(process.execPath, [PORT_PREFLIGHT], {
        cwd: resolve("."),
        env,
        encoding: "utf8",
      });
      expect(result.status, scenario.name).toBe(1);
      expect(result.stderr, scenario.name).toContain(scenario.error);
      expect(result.stdout, scenario.name).not.toContain("lsof preflight PASS");
    }
  });

  test("rejects a missing scenario instant before binding the API port", async () => {
    test.setTimeout(60_000);
    await expectFixtureBootRejected(
      undefined,
      "MARIA_CSV_REAL_IMPORT_SESSION_INSTANT is required",
    );
  });

  test("rejects a parseable noncanonical offset before binding the API port", async () => {
    test.setTimeout(60_000);
    await expectFixtureBootRejected(
      "2026-10-09T00:00:00.000-03:00",
      "MARIA_CSV_REAL_IMPORT_SESSION_INSTANT must be canonical YYYY-MM-DDTHH:mm:ss.sssZ",
    );
  });
});

test.describe("Maria CSV real bytes / HTTP / Prisma", () => {
  let child: ChildProcess;
  let fixtureEvidence: Wire;

  test.beforeAll(async () => {
    const apiBefore = portEvidence(API_PORT);
    expect(apiBefore.status).toBe(1);
    expect(apiBefore.stdout).toBe("");

    child = startFixture(INSTANT);
    fixtureEvidence = (
      await ipc(child, "READY", {}, FIXTURE_READY_TIMEOUT_MS, "READY", false)
    ).evidence as Wire;
    const apiAfter = portEvidence(API_PORT);
    expect(apiAfter.status).toBe(0);
    expect(apiAfter.stdout).toContain(`p${child.pid}`);
    expect(apiAfter.stdout).toContain(`n${HOST}:${API_PORT}`);

    const webAfter = portEvidence(WEB_PORT);
    expect(webAfter.status).toBe(0);
    expect(webAfter.stdout).toContain(`n${HOST}:${WEB_PORT}`);
    expect(webAfter.stdout).toMatch(/cnode/);

    expect(String(fixtureEvidence.databaseFile)).not.toMatch(/dev\.db$/);
    expect(String(fixtureEvidence.privateVault)).toContain("private-vault-");
    expect(String(fixtureEvidence.privateUploads)).toContain("private-vault-");
    expect(JSON.stringify(fixtureEvidence)).not.toContain("/prisma/dev.db");
    expect(fixtureEvidence.importSessionClock).toEqual({
      mode: "PRIVATE_FIXTURE_SCENARIO_INSTANT",
      contract: "MARIA_CSV_REAL_IMPORT_SESSION_INSTANT",
      initialInstant: INSTANT,
      currentInstant: INSTANT,
      tokenIdentityPreserved: true,
    });
    expect(fixtureEvidence.scriptedLlm).toEqual({
      deterministicContentOracleOnly: true,
      providerIdentityPreserved: true,
      exposedKeys: ["chat", "id", "isConfigured"],
      authProviderOverridden: false,
      persistenceProviderOverridden: false,
      capabilityProviderOverridden: false,
    });
    expect(fixtureEvidence.interpretationProvider).toEqual({
      sequentialPrivateIpcOnly: true,
      providerIdentityPreserved: true,
      quotaIdentityPreserved: true,
      exposedKeys: ["active", "attempts", "id", "sequence"],
    });
  });

  test.afterAll(async () => {
    if (child?.connected && child.exitCode === null) await closeFixture(child);
  });

  async function runRealJourney(
    page: Page,
    testInfo: TestInfo,
    providerFailuresOnly: boolean,
  ) {
    test.setTimeout(180_000);
    await page.setViewportSize(VIEWPORTS[0]);
    await page.clock.setFixedTime(new Date(INSTANT));

    const consoleErrors: string[] = [];
    const unexpectedHttp: string[] = [];
    const pageMutationRequests: string[] = [];
    const pageMutationStatuses: Array<{ key: string; status: number }> = [];
    const guidedMutationCommands: Array<{ key: string; body: Wire }> = [];
    const financialMutationCommands: Array<{ key: string; body: Wire }> = [];
    const replayExecuteBodies: Wire[] = [];
    const resultReads: string[] = [];
    const chatBodies: string[] = [];
    const directProviderOrChatRequests: string[] = [];
    const egressAttempts: string[] = [];
    const expectedInterpretationHttp: string[] = [];
    const interpretationConsoleDiagnostics: string[] = [];
    const documentaryCommands: Array<{
      method: string;
      path: string;
      body: Wire;
    }> = [];
    const currentLotReads: string[] = [];
    const testAuthorityTransports: Array<{
      path: string;
      headers: string[];
      cookie: string;
    }> = [];
    const authMeUrl = `${API}/auth/me`;
    const chromiumUnauthorizedResourceError =
      "Failed to load resource: the server responded with a status of 401 (Unauthorized)";
    const correlatedBootstrapAuthDiagnostics: Array<{
      type: string;
      text: string;
      location: { url: string; lineNumber: number; columnNumber: number };
    }> = [];
    let bootstrapAuth401ResponseCount = 0;
    let consumedBootstrapAuth401Responses = 0;
    let authenticatedAuthMeObserved = false;
    let executeRequest:
      | { body: string; headers: Record<string, string>; path: string }
      | undefined;
    let challengeNonce: string | undefined;
    let challengeEvidence: { status: number; body: Wire } | undefined;
    const fixtureLogOffset = list((await ipc(child, "LOGS")).logs).length;

    page.on("pageerror", (error) =>
      consoleErrors.push(`pageerror ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      if (
        !authenticatedAuthMeObserved &&
        location.url === authMeUrl &&
        message.text() === chromiumUnauthorizedResourceError &&
        consumedBootstrapAuth401Responses < bootstrapAuth401ResponseCount
      ) {
        consumedBootstrapAuth401Responses += 1;
        correlatedBootstrapAuthDiagnostics.push({
          type: message.type(),
          text: message.text(),
          location,
        });
        return;
      }
      if (
        /^Failed to load resource: the server responded with a status of (502 \(Bad Gateway\)|503 \(Service Unavailable\))$/.test(
          message.text(),
        )
      ) {
        interpretationConsoleDiagnostics.push(message.text());
        return;
      }
      consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      const requestHeaders = request.headers();
      const authorityHeaders = Object.keys(requestHeaders).filter((name) =>
        /(?:test|fixture|authority)/i.test(name),
      );
      const cookie = requestHeaders.cookie ?? "";
      if (
        url.origin === API &&
        (authorityHeaders.length > 0 ||
          /(?:test|fixture|authority)[^=]*=/i.test(cookie))
      )
        testAuthorityTransports.push({
          path: url.pathname,
          headers: authorityHeaders,
          cookie,
        });
      const key = mutationKey(request);
      if (key) pageMutationRequests.push(key);
      if (
        key &&
        request.method() === "POST" &&
        /^\/import-sessions\/[^/]+\/(?:resolutions|interpretations|declarations|current-lot\/(?:prepare|continue))$/.test(
          url.pathname,
        )
      )
        guidedMutationCommands.push({
          key,
          body: record(request.postDataJSON()),
        });
      if (
        key &&
        request.method() === "POST" &&
        /^\/import-sessions\/[^/]+\/(?:confirmation-challenge|confirm|execute)$/.test(
          url.pathname,
        )
      )
        financialMutationCommands.push({
          key,
          body: record(request.postDataJSON()),
        });
      if (
        url.origin === API &&
        request.method() === "GET" &&
        /^\/import-sessions\/[^/]+\/result$/.test(url.pathname)
      )
        resultReads.push(url.pathname);
      if (url.origin === API && url.pathname === "/agent/chat")
        chatBodies.push(request.postData() ?? "");
      if (
        url.origin === API &&
        /\/(?:agent\/chat|providers?)(?:\/|$)/.test(url.pathname)
      )
        directProviderOrChatRequests.push(
          `${request.method()} ${url.pathname}`,
        );
      if (
        url.origin === API &&
        request.method() === "POST" &&
        /^\/import-sessions\/[^/]+\/(?:declarations|resolutions|defer|reactivate|current-lot\/(?:prepare|continue))$/.test(
          url.pathname,
        )
      )
        documentaryCommands.push({
          method: request.method(),
          path: url.pathname,
          body: record(request.postDataJSON()),
        });
      if (
        url.origin === API &&
        request.method() === "GET" &&
        /^\/import-sessions\/[^/]+\/current-lot$/.test(url.pathname)
      )
        currentLotReads.push(url.pathname);
      if (
        url.origin === API &&
        request.method() === "POST" &&
        /^\/import-sessions\/[^/]+\/execute$/.test(url.pathname)
      ) {
        executeRequest = {
          body: request.postData() ?? "",
          headers: request.headers(),
          path: url.pathname,
        };
      }
    });
    page.on("response", async (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (
        request.method() === "GET" &&
        response.url() === authMeUrl &&
        !authenticatedAuthMeObserved
      ) {
        if (response.status() === 401) bootstrapAuth401ResponseCount += 1;
        if (response.status() === 200) authenticatedAuthMeObserved = true;
      }
      const key = mutationKey(request);
      if (key) pageMutationStatuses.push({ key, status: response.status() });
      if (
        url.origin === API &&
        /^\/import-sessions\/[^/]+\/confirmation-challenge$/.test(url.pathname)
      ) {
        const body = record(await response.json());
        challengeEvidence = { status: response.status(), body };
        if (typeof body.nonce === "string") challengeNonce = body.nonce;
      }
      if (
        response.status() >= 400 &&
        request.method() === "POST" &&
        url.origin === API &&
        /^\/import-sessions\/[^/]+\/interpretations$/.test(url.pathname) &&
        [502, 503].includes(response.status())
      ) {
        expectedInterpretationHttp.push(
          `${response.status()} ${request.method()} ${url.pathname}`,
        );
      } else if (
        response.status() >= 400 &&
        !(
          response.status() === 401 &&
          request.method() === "GET" &&
          url.origin === API &&
          url.pathname === "/auth/me"
        )
      )
        unexpectedHttp.push(
          `${response.status()} ${request.method()} ${url.pathname}`,
        );
    });
    await page.route("**/*", (route) => {
      const origin = new URL(route.request().url()).origin;
      if (origin !== API && origin !== WEB) {
        egressAttempts.push(
          `${route.request().method()} ${route.request().url()}`,
        );
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });

    await page.goto("/register");
    await page.getByLabel(/^seu nome$/i).fill("Maria CSV QA");
    await page
      .getByLabel(/email/i)
      .fill(
        providerFailuresOnly
          ? "maria-csv-provider-errors@example.test"
          : "maria-csv-real@example.test",
      );
    await page.getByLabel(/^senha$/i).fill("Local-only-qa-password-2026");
    await page
      .getByRole("checkbox", { name: /organizar minha vida financeira/i })
      .check();
    await page.getByRole("checkbox", { name: /reformar/i }).check();
    await page.getByRole("button", { name: /criar minha conta/i }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/conta$/);

    const onboarding = page.getByRole("dialog", {
      name: "Jornada: Onboarding — PESSOAL",
      exact: true,
    });
    await expect(onboarding).toBeVisible();
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("lifeone:journey-runtime"),
      ),
    ).not.toBeNull();
    await onboarding
      .getByRole("button", { name: "Fechar jornada", exact: true })
      .click();
    await expect(onboarding).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => sessionStorage.getItem("lifeone:journey-runtime")),
      )
      .toBeNull();

    const meResponse = await page.request.get(`${API}/auth/me`);
    expect(meResponse.status()).toBe(200);
    const me = record(await meResponse.json());
    expect(me.role).toBe("USER");
    expect(me.isGuest).toBe(false);

    const projectResponse = await page.request.get(`${API}/projects`);
    expect(projectResponse.status()).toBe(200);
    const projects = list(await projectResponse.json());
    const pessoal = projects.filter((project) => project.type === "PESSOAL");
    const reformas = projects.filter((project) => project.type === "REFORMA");
    expect(pessoal).toHaveLength(1);
    expect(reformas).toHaveLength(1);
    if (
      typeof me.id !== "string" ||
      typeof pessoal[0]?.id !== "string" ||
      typeof reformas[0]?.id !== "string" ||
      typeof reformas[0]?.name !== "string"
    )
      throw new Error("Signup did not return stable typed identities");

    await page.goto(`/projects/${pessoal[0].id}/credit-cards?new=1`);
    await expect(page).toHaveURL(
      new RegExp(`/projects/${pessoal[0].id}/credit-cards\\?new=1$`),
    );
    const cardForm = page
      .getByRole("heading", { name: "Novo cartão", exact: true })
      .locator("..")
      .locator("..");
    await expect(cardForm).toBeVisible();
    await cardForm.locator("select").nth(0).selectOption("ITAU");
    await cardForm.locator("select").nth(1).selectOption("Visa");
    await cardForm.getByPlaceholder("Ex: Itaú Click Visa").fill("Maria CSV QA");
    await cardForm.getByPlaceholder("1234").fill("9911");
    await cardForm.getByPlaceholder("25", { exact: true }).fill("20");
    await cardForm.getByPlaceholder("10", { exact: true }).fill("28");
    const cardCreatedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        url.pathname === `/projects/${pessoal[0].id}/credit-cards`
      );
    });
    await cardForm.getByRole("button", { name: "Salvar" }).click();
    const cardResponse = await cardCreatedResponse;
    expect(cardResponse.status()).toBe(201);
    const card = record(await cardResponse.json());
    expect(card).toMatchObject({
      projectId: pessoal[0].id,
      institution: "ITAU",
      brand: "Visa",
      nickname: "Maria CSV QA",
      last4: "9911",
      closingDay: 20,
      dueDay: 28,
    });
    if (typeof card.id !== "string")
      throw new Error("Normal card UI did not return a typed card identity");
    await expect(cardForm).toHaveCount(0);

    const baseline = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    expect(list(baseline.sessions)).toHaveLength(0);
    expect(list(baseline.artifacts)).toHaveLength(0);
    expect(list(baseline.references)).toHaveLength(0);
    expect(list(baseline.observations)).toHaveLength(0);
    expect(list(baseline.expenses)).toHaveLength(0);
    expect(list(baseline.receipts)).toHaveLength(0);
    expect(list(baseline.cashFlowEntries)).toHaveLength(0);
    expect(list(baseline.allocations)).toHaveLength(0);
    expect(list(baseline.settlements)).toHaveLength(0);
    expect(list(baseline.funding)).toHaveLength(0);
    expect(list(baseline.merchantRules)).toHaveLength(0);
    expect(baseline.claimedObservations).toBe(0);

    const mariaPath = `/projects/${pessoal[0].id}/maria`;
    await page.goto(mariaPath);
    await expect(page.getByRole("heading", { name: "Maria" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${mariaPath}$`));
    expect(pageMutationRequests).toEqual([]);

    const picker = page.getByLabel("Anexar CSV da fatura");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute("accept", ".csv,text/csv");
    const cardPicker = page.getByRole("combobox", {
      name: "Cartão da fatura",
    });
    await cardPicker.selectOption({ value: card.id });
    await expect(cardPicker).toHaveValue(card.id);
    await expect(
      page.getByRole("button", { name: "Nova importação" }),
    ).toHaveCount(0);
    await picker.setInputFiles({
      name: "fatura-outubro.csv",
      mimeType: "text/csv",
      buffer: CSV,
    });
    expect(pageMutationRequests).toEqual([]);
    expect(
      record(
        (
          await ipc(child, "SNAPSHOT", {
            userId: me.id,
          })
        ).snapshot,
      ),
    ).toEqual(baseline);

    const consent = page.getByRole("button", {
      name: "Analisar e guardar rascunho",
    });
    await expectTarget(consent, "documentary consent");
    await consent.click();

    const activePurchase = page.getByRole("region", {
      name: /^Compra \d+ de 4$/,
    });
    await expect(activePurchase).toHaveCount(1);
    await expect(activePurchase).toContainText("LOJA GEMEA");
    await expect(activePurchase).not.toContainText("MATERIAL REFORMA");
    await expect(activePurchase).not.toContainText("PAGAMENTO EFETUADO");

    const analyzed = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    expect(list(analyzed.sessions)).toHaveLength(1);
    expect(list(analyzed.artifacts)).toHaveLength(1);
    expect(list(analyzed.references)).toHaveLength(1);
    expect(list(analyzed.observations)).toHaveLength(4);
    expect(
      new Set(list(analyzed.observations).map((row) => row.reference)).size,
    ).toBe(4);
    expect(list(analyzed.artifacts)[0]?.documentSha256).toBe(CSV_SHA256);
    for (const key of [
      "expenses",
      "receipts",
      "cashFlowEntries",
      "allocations",
      "settlements",
      "funding",
      "merchantRules",
    ])
      expect(analyzed[key], `${key} before confirmation`).toEqual(
        baseline[key],
      );
    expect(analyzed.claimedObservations).toBe(0);

    async function expectPreConfirmIntegrity(label: string) {
      const current = record(
        (
          await ipc(child, "SNAPSHOT", {
            userId: me.id,
          })
        ).snapshot,
      );
      const observations = list(current.observations);
      expect(observations, `${label}: four observations`).toHaveLength(4);
      expect(
        new Set(observations.map((row) => row.reference)).size,
        `${label}: distinct observation references`,
      ).toBe(4);
      for (const key of [
        "expenses",
        "receipts",
        "cashFlowEntries",
        "allocations",
        "settlements",
        "funding",
        "merchantRules",
      ])
        expect(current[key], `${label}: ${key}`).toEqual(baseline[key]);
      expect(current.claimedObservations, `${label}: claims`).toBe(0);
    }

    async function visibleRevision() {
      const snapshot = record(
        (
          await ipc(child, "SNAPSHOT", {
            userId: me.id,
          })
        ).snapshot,
      );
      const sessions = list(snapshot.sessions);
      const revision = sessions[0]?.revision;
      if (sessions.length !== 1 || !Number.isInteger(revision))
        throw new Error("Fixture did not expose one typed session revision");
      return revision as number;
    }

    async function focusedPurchaseTitle() {
      const focusedPurchase = page.getByRole("region", {
        name: /^Compra \d+ de \d+$/,
      });
      await expect(focusedPurchase).toHaveCount(1);
      const text = await focusedPurchase.innerText();
      if (text.includes("LOJA GEMEA")) return "LOJA GEMEA";
      if (text.includes("MATERIAL REFORMA")) return "MATERIAL REFORMA";
      if (text.includes("PAGAMENTO EFETUADO")) return "PAGAMENTO EFETUADO";
      throw new Error(`Unexpected focused purchase: ${text}`);
    }

    const initialAnswers = new Map([
      ["amountMeaning", 0],
      ["amountCents", 0],
      ["installmentCount", 0],
      ["firstDueDate", 0],
    ]);
    for (let index = 0; index < 12; index++) {
      const questionPanel = page
        .getByRole("region", { name: /^Compra \d+ de 4$/ })
        .locator("..");
      const form = questionPanel.locator("form");
      const question = await form.getByRole("heading").innerText();
      const field =
        question === "Esse valor é o total da compra ou o valor de uma parcela?"
          ? "amountMeaning"
          : question === "Qual é o valor desta compra?"
            ? "amountCents"
            : question === "Em quantas parcelas esta compra foi feita?"
              ? "installmentCount"
              : question === "Qual é a data do primeiro vencimento?"
                ? "firstDueDate"
                : null;
      if (!field || !initialAnswers.has(field))
        throw new Error(`Unexpected initial draft question: ${question}`);
      const title = await focusedPurchaseTitle();
      expect(title).not.toBe("PAGAMENTO EFETUADO");
      if (field === "amountMeaning")
        await form.getByRole("radio", { name: "É o total da compra" }).check();
      else
        await form
          .getByLabel("Sua resposta", { exact: true })
          .fill(
            field === "amountCents"
              ? title === "MATERIAL REFORMA"
                ? "250,00"
                : "100,01"
              : field === "installmentCount"
                ? "1"
                : "2026-10-28",
          );
      if (index === 0)
        await expectTarget(
          form.getByRole("button", { name: "Conferir informação" }),
          "first question response",
        );
      await form
        .getByRole("button", { name: "Conferir informação" })
        .press("Enter");
      await expect(
        questionPanel.getByText(
          "Confira antes de guardar. Esta prévia ainda não foi enviada.",
          { exact: true },
        ),
      ).toBeVisible();
      const revision = await visibleRevision();
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.origin === API &&
          /^\/import-sessions\/[^/]+\/resolutions$/.test(url.pathname)
        );
      });
      await questionPanel
        .getByRole("button", { name: "Guardar informação" })
        .press("Enter");
      const response = await responsePromise;
      expect(
        response.status(),
        `initial ${title} ${field}: ${await response.text()}`,
      ).toBe(200);
      await expect.poll(visibleRevision).toBe(revision + 1);
      await expect
        .poll(async () =>
          (await form.getByRole("heading").count())
            ? form.getByRole("heading").innerText()
            : null,
        )
        .not.toBe(question);
      await expectPreConfirmIntegrity(`initial ${title} ${field}`);
      initialAnswers.set(field, initialAnswers.get(field)! + 1);
    }
    expect(Object.fromEntries(initialAnswers)).toEqual({
      amountMeaning: 3,
      amountCents: 3,
      installmentCount: 3,
      firstDueDate: 3,
    });

    const interpretationBaseline = interpretationInvariant(
      record(
        (
          await ipc(child, "SNAPSHOT", {
            userId: me.id,
          })
        ).snapshot,
      ),
    );
    const interpretationRequestIds = new Set<string>();
    const interpretationEvidence: Wire[] = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      const questionPanel = page
        .getByRole("region", { name: /^Compra \d+ de 4$/ })
        .locator("..");
      const freeText = questionPanel.getByLabel("Sua resposta em texto", {
        exact: true,
      });
      if (!(await freeText.isVisible()))
        await questionPanel
          .getByRole("button", { name: "Prefiro digitar", exact: true })
          .click();
      await expect(freeText).toBeVisible();

      for (const scenario of [
        {
          mode: "PROVIDER_UNAVAILABLE" as const,
          status: 503,
          retryable: true,
        },
        {
          mode: "MODEL_OUTPUT_INVALID" as const,
          status: 502,
          retryable: false,
        },
      ]) {
        const literal = `resposta privada ${scenario.status} ${viewport.width}`;
        await freeText.fill(literal);
        const armed = await ipc(child, "ARM_INTERPRETATION", {
          mode: scenario.mode,
          literal,
        });
        expect(armed).toEqual({
          kind: "ARM_INTERPRETATION",
          sequence: expect.any(Number),
          mode: scenario.mode,
        });

        const responsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.origin === API &&
            /^\/import-sessions\/[^/]+\/interpretations$/.test(url.pathname)
          );
        });
        const interpret = questionPanel.getByRole("button", {
          name: "Interpretar resposta",
          exact: true,
        });
        await expectTarget(
          interpret,
          `${scenario.mode} ${viewport.width}px interpretation`,
        );
        await interpret.click();
        const response = await responsePromise;
        expect(response.status()).toBe(scenario.status);
        const wire = record(await response.json());
        expect(Object.keys(wire).sort()).toEqual([
          "code",
          "currentRevision",
          "reason",
          "retryable",
          "sessionId",
        ]);
        expect(wire).toEqual({
          code: scenario.mode,
          currentRevision: null,
          reason: null,
          retryable: scenario.retryable,
          sessionId: null,
        });

        const requestBody = record(response.request().postDataJSON());
        expect(Object.keys(requestBody).sort()).toEqual([
          "consentExternalProcessing",
          "expectedRevision",
          "questionId",
          "requestId",
          "text",
          "version",
        ]);
        expect(requestBody).toMatchObject({
          version: 1,
          expectedRevision: expect.any(Number),
          questionId: expect.any(String),
          text: literal,
          consentExternalProcessing: true,
        });
        const requestId = String(requestBody.requestId);
        expect(requestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(interpretationRequestIds.has(requestId)).toBe(false);
        interpretationRequestIds.add(requestId);

        const alert = questionPanel.getByRole("alert").filter({
          hasText:
            "Não foi possível interpretar agora. Seu texto foi mantido; tente novamente ou use os controles acima.",
        });
        await expect(alert).toBeVisible();
        await expect(freeText).toHaveValue(literal);
        await expect(freeText).toBeFocused();
        await expect(
          questionPanel.getByRole("radio", { name: "Total da compra" }),
        ).toBeEnabled();
        await expect(
          questionPanel.getByRole("region", {
            name: "Prévia da resposta interpretada",
          }),
        ).toHaveCount(0);
        await expect(
          questionPanel.getByRole("button", { name: "Guardar informação" }),
        ).toHaveCount(0);

        const evidence = record(
          (
            await ipc(child, "INTERPRETATION_EVIDENCE", {
              sequence: armed.sequence,
              userId: me.id,
              requestId,
            })
          ).evidence,
        );
        interpretationEvidence.push(evidence);
        expect(JSON.stringify(evidence)).not.toContain(literal);
        expect(evidence.sequence).toBe(armed.sequence);
        expect(evidence.mode).toBe(scenario.mode);
        expect(evidence.ledger).toEqual({
          keys: [
            "expectedRevision",
            "failureCode",
            "payloadHash",
            "recordedAt",
            "requestId",
            "status",
          ],
          requestId,
          expectedRevision: requestBody.expectedRevision,
          status: "FAILED",
          failureCode: scenario.mode,
          payloadHashLength: 64,
        });
        expect(evidence.session).toEqual({
          id: expect.any(String),
          state: expect.any(String),
          revision: requestBody.expectedRevision,
        });
        expect(evidence.privacy).toEqual({
          rawLiteralPersisted: false,
          rawLiteralReturned: false,
        });
        const provider = record(evidence.provider);
        expect(provider.isConfiguredCalls).toBe(1);
        if (scenario.mode === "PROVIDER_UNAVAILABLE") {
          expect(provider).toEqual({
            isConfiguredCalls: 1,
            quotaCalls: 0,
            chatCalls: 0,
            sanitizedPayload: null,
            offeredTools: [],
            options: null,
            result: null,
          });
        } else {
          expect(provider).toEqual({
            isConfiguredCalls: 1,
            quotaCalls: 1,
            chatCalls: 1,
            sanitizedPayload: {
              payloadKeys: [
                "constraints",
                "focusAlias",
                "literal",
                "semantic",
                "version",
              ],
              version: 1,
              semantic: "AMOUNT_MEANING",
              literalUtf16Length: literal.length,
              literalSha256: createHash("sha256").update(literal).digest("hex"),
              focusAliasLocal: true,
              constraintKeys: ["allowedOptions", "valueType"],
              serializedBytes: expect.any(Number),
            },
            offeredTools: ["submit_import_interpretation"],
            options: {
              responseContract: "IMPORT_INTERPRETATION_V1",
              requiredToolName: "submit_import_interpretation",
            },
            result: { contentLength: 0, toolCallCount: 0 },
          });
        }

        const afterFailure = record(
          (
            await ipc(child, "SNAPSHOT", {
              userId: me.id,
            })
          ).snapshot,
        );
        expect(interpretationInvariant(afterFailure)).toEqual(
          interpretationBaseline,
        );
      }
    }
    expect(interpretationRequestIds.size).toBe(VIEWPORTS.length * 2);
    expect(interpretationEvidence).toHaveLength(VIEWPORTS.length * 2);
    if (providerFailuresOnly) {
      const questionPanel = page
        .getByRole("region", { name: /^Compra \d+ de 4$/ })
        .locator("..");
      const fallbackForm = questionPanel.locator("form");
      await fallbackForm
        .getByRole("radio", { name: "É o total da compra" })
        .check();
      await fallbackForm
        .getByRole("button", { name: "Conferir informação" })
        .click();
      await expect(
        questionPanel.getByText(
          "Confira antes de guardar. Esta prévia ainda não foi enviada.",
          { exact: true },
        ),
      ).toBeVisible();

      const fallbackRevision = await visibleRevision();
      const fallbackResponsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.origin === API &&
          /^\/import-sessions\/[^/]+\/declarations$/.test(url.pathname)
        );
      });
      await questionPanel
        .getByRole("button", { name: "Guardar e continuar" })
        .click();
      const fallbackResponse = await fallbackResponsePromise;
      expect(
        fallbackResponse.status(),
        `structured fallback: ${await fallbackResponse.text()}`,
      ).toBe(200);
      await expect.poll(visibleRevision).toBe(fallbackRevision + 1);

      const afterFallback = record(
        (
          await ipc(child, "SNAPSHOT", {
            userId: me.id,
          })
        ).snapshot,
      );
      for (const key of [
        "expenses",
        "receipts",
        "cashFlowEntries",
        "allocations",
        "settlements",
        "funding",
        "merchantRules",
      ])
        expect(afterFallback[key], `fallback ${key}`).toEqual(
          interpretationBaseline[key],
        );
      expect(afterFallback.claimedObservations).toBe(
        interpretationBaseline.claimedObservations,
      );
      expect(list(afterFallback.sessions)[0]).toMatchObject({
        state: list(interpretationBaseline.sessions)[0]?.state,
        revision: fallbackRevision + 1,
      });

      await expect
        .poll(() => interpretationConsoleDiagnostics.length)
        .toBe(VIEWPORTS.length * 2);
      expect(
        expectedInterpretationHttp.map((entry) => entry.split(" ", 1)[0]),
      ).toEqual(["503", "502", "503", "502", "503", "502"]);
      expect(interpretationConsoleDiagnostics).toEqual([
        "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
        "Failed to load resource: the server responded with a status of 502 (Bad Gateway)",
        "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
        "Failed to load resource: the server responded with a status of 502 (Bad Gateway)",
        "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
        "Failed to load resource: the server responded with a status of 502 (Bad Gateway)",
      ]);
      expect(chatBodies).toEqual([]);
      expect(unexpectedHttp).toEqual([]);
      expect(consoleErrors).toEqual([]);
      expect(testAuthorityTransports).toEqual([]);
      expect(egressAttempts).toEqual([]);
      const renderedText = await page.locator("body").innerText();
      expect(renderedText).not.toMatch(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
      );
      for (const requestId of interpretationRequestIds)
        expect(renderedText).not.toContain(requestId);
      await testInfo.attach("maria-csv-real-provider-failures.json", {
        body: Buffer.from(
          JSON.stringify(
            {
              wireStatuses: expectedInterpretationHttp,
              evidence: interpretationEvidence,
              egressAttempts,
              externalChatRequests: chatBodies,
            },
            null,
            2,
          ),
        ),
        contentType: "application/json",
      });
      return;
    }
    await page.setViewportSize(VIEWPORTS[0]);

    const declarationAnswers = new Map([
      ["amountMeaning", 0],
      ["amountCents", 0],
      ["installmentCount", 0],
      ["installmentIndex", 0],
    ]);
    for (let index = 0; index < 12; index++) {
      const focusedPurchase = page.getByRole("region", {
        name: /^Compra \d+ de 4$/,
      });
      if ((await focusedPurchase.count()) === 0) break;
      const questionPanel = focusedPurchase.locator("..");
      const form = questionPanel.locator("form");
      const title = await focusedPurchaseTitle();
      if (title === "PAGAMENTO EFETUADO") break;
      const heading = await form.getByRole("heading").innerText();
      const field =
        heading === "Esse valor é o total da compra ou o valor de uma parcela?"
          ? "amountMeaning"
          : heading === "Qual é o total da compra?"
            ? "amountCents"
            : heading === "Em quantas parcelas esta compra foi feita?"
              ? "installmentCount"
              : heading === "Qual é o número desta parcela?"
                ? "installmentIndex"
                : null;
      if (!field)
        throw new Error(`Unexpected documentary question: ${heading}`);
      if (field === "amountMeaning") {
        await form.getByRole("radio", { name: "É o total da compra" }).check();
        await form
          .getByRole("button", { name: "Conferir informação" })
          .press("Enter");
      } else if (field === "amountCents") {
        await form
          .getByLabel("Sua resposta", { exact: true })
          .fill(title === "MATERIAL REFORMA" ? "250,00" : "100,01");
        await form
          .getByRole("button", { name: "Conferir informação" })
          .press("Enter");
      } else if (field === "installmentCount") {
        await form.getByLabel("Sua resposta", { exact: true }).fill("1");
        await form
          .getByRole("button", { name: "Conferir informação" })
          .press("Enter");
      } else {
        await form.getByLabel("Sua resposta", { exact: true }).fill("1");
        await form
          .getByRole("button", { name: "Conferir informação" })
          .press("Enter");
      }
      await expect(
        questionPanel.getByText(
          "Confira antes de guardar. Esta prévia ainda não foi enviada.",
          { exact: true },
        ),
      ).toBeVisible();
      const revision = await visibleRevision();
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.origin === API &&
          /^\/import-sessions\/[^/]+\/declarations$/.test(url.pathname)
        );
      });
      await questionPanel
        .getByRole("button", { name: "Guardar e continuar" })
        .press("Enter");
      const response = await responsePromise;
      expect(
        response.status(),
        `declaration ${title} ${field}: ${await response.text()}`,
      ).toBe(200);
      await expect.poll(visibleRevision).toBe(revision + 1);
      await expect(
        questionPanel.getByText(
          "Confira antes de guardar. Esta prévia ainda não foi enviada.",
          { exact: true },
        ),
      ).toHaveCount(0);
      await expectPreConfirmIntegrity(`declaration ${title} ${field}`);
      declarationAnswers.set(field, declarationAnswers.get(field)! + 1);
    }
    expect(Object.fromEntries(declarationAnswers)).toEqual({
      amountMeaning: 3,
      amountCents: 0,
      installmentCount: 3,
      installmentIndex: 3,
    });
    await expect(
      page.getByRole("region", { name: /^Compra \d+ de 4$/ }),
    ).toHaveCount(0);

    const continueAnswering = page.getByRole("button", {
      name: "Continuar respondendo",
      exact: true,
    });
    await expect(
      continueAnswering,
      "resolved purchase rows must continue without asking about the ignored payment",
    ).toBeVisible();
    const prepareRevision = await visibleRevision();
    const prepareResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(url.pathname)
      );
    });
    await continueAnswering.click();
    const prepareResponse = await prepareResponsePromise;
    expect(
      prepareResponse.status(),
      `first preparation: ${await prepareResponse.text()}`,
    ).toBe(200);
    await expect.poll(visibleRevision).toBe(prepareRevision + 1);
    await expectPreConfirmIntegrity("first preparation");

    const draftSessionId = String(list(analyzed.sessions)[0]!.id);
    async function readGuidedReview() {
      const response = await page.request.get(
        `${API}/import-sessions/${draftSessionId}`,
      );
      expect(response.status()).toBe(200);
      return expectCanonicalGuidedReview(
        record(await response.json()).guidedReview,
      );
    }
    const preparationSteps = [
      {
        title: "LOJA GEMEA",
        field: "decision",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        title: "LOJA GEMEA",
        field: "targets",
        answer: { kind: "TARGETS", value: [] },
      },
      {
        title: "LOJA GEMEA",
        field: "tipoDespesa",
        answer: { kind: "EXPENSE_TYPE", value: "COMPRAS_VAREJO" },
      },
      {
        title: "LOJA GEMEA",
        field: "decision",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        title: "LOJA GEMEA",
        field: "targets",
        answer: { kind: "TARGETS", value: [] },
      },
      {
        title: "LOJA GEMEA",
        field: "tipoDespesa",
        answer: { kind: "EXPENSE_TYPE", value: "COMPRAS_VAREJO" },
      },
      {
        title: "MATERIAL REFORMA",
        field: "decision",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        title: "MATERIAL REFORMA",
        field: "targets",
        answer: {
          kind: "TARGETS",
          value: [
            {
              projectId: reformas[0].id,
              roomId: null,
              amountCents: 25_000,
            },
          ],
        },
      },
      {
        title: "MATERIAL REFORMA",
        field: "tipoDespesa",
        answer: { kind: "EXPENSE_TYPE", value: "MATERIAL_CONSTRUCAO" },
      },
    ] as const;
    for (const [index, step] of preparationSteps.entries()) {
      if (index === 3 || index === 6) {
        const sealedRevision = index === 3 ? 30 : 35;
        const prepareResponsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.origin === API &&
            /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(
              url.pathname,
            )
          );
        });
        await page
          .getByRole("button", {
            name: "Continuar respondendo",
            exact: true,
          })
          .click();
        const prepareResponse = await prepareResponsePromise;
        expect(prepareResponse.status()).toBe(200);
        expect(record(await prepareResponse.json())).toMatchObject({
          operation: "PREPARE_CURRENT_LOT",
          outcome: "CURRENT_LOT_READY",
          revision: sealedRevision,
        });

        const continueResponsePromise = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.origin === API &&
            /^\/import-sessions\/[^/]+\/current-lot\/continue$/.test(
              url.pathname,
            )
          );
        });
        await page
          .getByRole("button", {
            name: "Continuar respondendo",
            exact: true,
          })
          .click();
        const continueResponse = await continueResponsePromise;
        expect(continueResponse.status()).toBe(200);
        expect(record(await continueResponse.json())).toMatchObject({
          operation: "CONTINUE_ANSWERING",
          outcome: "NEEDS_INPUT",
          revision: sealedRevision + 1,
        });
        await expect.poll(visibleRevision).toBe(sealedRevision + 1);
        await expectPreConfirmIntegrity(
          `continue before guided purchase ${Math.floor(index / 3) + 1}`,
        );
      }
      const canonical = await readGuidedReview();
      if (!canonical.focus)
        throw new Error(`Missing guided focus at step ${index + 1}`);
      expect(canonical.focus).toMatchObject({
        context: { title: step.title },
        purchaseOrdinal: Math.floor(index / 3) + 1,
        purchaseTotal: 3,
        questionOrdinal: (index % 3) + 1,
        questionTotal: 3,
      });
      const option = matchingGuidedOptionLabel(canonical.focus, step.answer);
      expect(await focusedPurchaseTitle()).toBe(step.title);
      const form = page
        .getByRole("region", { name: "Conversa da importação" })
        .locator("form")
        .first();
      const radio = form.getByRole("radio", { name: option, exact: true });
      if ((await radio.count()) === 1) await radio.check();
      else await form.getByRole("combobox").selectOption({ label: option });
      await form
        .getByRole("button", { name: "Conferir informação", exact: true })
        .click();
      const preview = page.getByRole("region", {
        name: "Confira antes de guardar",
      });
      await expect(preview).toContainText(option);
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.origin === API &&
          /^\/import-sessions\/[^/]+\/resolutions$/.test(url.pathname)
        );
      });
      await preview
        .getByRole("button", { name: "Guardar e continuar", exact: true })
        .click();
      const response = await responsePromise;
      expect(
        response.status(),
        `${step.title} ${step.field}: ${await response.text()}`,
      ).toBe(200);
      await expect
        .poll(visibleRevision)
        .toBe(27 + index + 2 * Math.floor(index / 3));
      await expectPreConfirmIntegrity(
        `preparation ${step.title} ${step.field}`,
      );

      if (index === 0) {
        const firstDecisionSnapshot = record(
          (
            await ipc(child, "SNAPSHOT", {
              userId: me.id,
            })
          ).snapshot,
        );
        const sessions = list(firstDecisionSnapshot.sessions);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          state: "DRAFT",
          revision: 27,
        });
        const draft = record(
          JSON.parse(String(sessions[0]!.draftJson)) as unknown,
        );
        const lines = list(draft.lines);
        const observations = list(firstDecisionSnapshot.observations);
        expect(lines).toHaveLength(4);
        expect(observations).toHaveLength(4);
        expect(draft.selectedLineIds).toHaveLength(3);
        expect(new Set(draft.selectedLineIds as unknown[]).size).toBe(3);
        expect(list(draft.questions)).toHaveLength(8);
        expect(
          lines.filter((line) => record(line.decision).kind === "CREATE"),
        ).toEqual([
          expect.objectContaining({
            titulo: "LOJA GEMEA",
            decision: { kind: "CREATE", acceptNaturalDuplicate: false },
          }),
        ]);
        const payment = lines.filter(
          (line) => line.titulo === "PAGAMENTO EFETUADO",
        );
        expect(payment).toEqual([
          expect.objectContaining({
            decision: {
              kind: "IGNORED_POLICY",
              reason: "INVOICE_PAYMENT",
              policyVersion: 1,
            },
          }),
        ]);
        expect(draft.selectedLineIds).not.toContain(payment[0]!.id);
        const paymentObservationIds = payment[0]!.observationIds as unknown[];
        expect(paymentObservationIds).toHaveLength(1);
        expect(
          observations.filter((observation) =>
            paymentObservationIds.includes(observation.id),
          ),
        ).toEqual([
          expect.objectContaining({
            claimSessionId: null,
            claimReceiptJson: null,
            claimedAt: null,
          }),
        ]);
        for (const key of [
          "expenses",
          "receipts",
          "cashFlowEntries",
          "allocations",
          "settlements",
          "funding",
          "merchantRules",
        ])
          expect(
            firstDecisionSnapshot[key],
            `first decision: zero ${key}`,
          ).toEqual([]);
        expect(firstDecisionSnapshot.claimedObservations).toBe(0);
      }
    }
    const finalPreparation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await page
      .getByRole("button", { name: "Continuar respondendo", exact: true })
      .click();
    expect((await finalPreparation).status()).toBe(200);
    await expect.poll(visibleRevision).toBe(40);

    const session = list(analyzed.sessions)[0]!;
    const sessionId = String(session.id);
    const lotResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.origin === API &&
        url.pathname === `/import-sessions/${sessionId}/current-lot`
      );
    });
    await page
      .getByRole("button", { name: "Revisar as prontas agora", exact: true })
      .click();
    const lotResponse = await lotResponsePromise;
    expect(lotResponse.status()).toBe(200);
    const lot = record(await lotResponse.json());

    const confirmation = page.getByRole("button", {
      name: "Confirmar compras deste lote",
      exact: true,
    });
    await expect(confirmation).toHaveCount(1);

    const purchaseRows = page
      .getByRole("list", { name: "Compras prontas deste lote" })
      .getByRole("listitem");
    const twins = purchaseRows.filter({ hasText: "LOJA GEMEA" });
    await expect(twins).toHaveCount(2);
    await expect(twins.nth(0)).not.toHaveText(/MATERIAL REFORMA/);
    await expect(twins.nth(1)).not.toHaveText(/MATERIAL REFORMA/);
    const materialRow = purchaseRows.filter({ hasText: "MATERIAL REFORMA" });
    await expect(materialRow).toHaveCount(1);
    await expect(materialRow).toContainText(reformas[0].name);
    await expect(
      page.getByRole("list", { name: "Compras prontas deste lote" }),
    ).not.toContainText("PAGAMENTO EFETUADO");

    expect(lot.createdEconomicTotalCents).toBe(45_002);
    expect(lot.bankCashDeltaCents).toBe(0);
    expect(list(lot.purchases)).toHaveLength(3);

    await expectTarget(confirmation, "single financial confirmation");
    await confirmation.click();
    const applied = await ipc(child, "WAIT_APPLIED", { userId: me.id }, 20_000);
    expect(applied.sessionId).toBe(sessionId);
    expect(executeRequest).toBeDefined();
    expect(challengeEvidence?.status).toBe(200);
    expect(challengeEvidence?.body.expiresAt).toBe("2026-10-09T03:05:00.000Z");
    expect(
      Date.parse(String(challengeEvidence?.body.expiresAt)) -
        Date.parse(INSTANT),
    ).toBe(300_000);

    const recoveredByGet = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.origin === API &&
        url.pathname === `/import-sessions/${sessionId}/result`
      );
    });
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${mariaPath}$`));
    const resultResponse = await recoveredByGet;
    expect(resultResponse.status()).toBe(200);
    const result = record(await resultResponse.json());
    expect(result.state).toBe("APPLIED");
    const receipt = record(result.receipt);
    expect(list(receipt.items).map((item) => item.outcome)).toEqual([
      "CREATED",
      "CREATED",
      "CREATED",
    ]);
    expect(list(receipt.auditItems)).toEqual([
      expect.objectContaining({
        outcome: "IGNORED",
        reason: "INVOICE_PAYMENT",
        amountCents: -45_002,
      }),
    ]);

    const after = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    const expenses = list(after.expenses);
    const cash = list(after.cashFlowEntries);
    const allocations = list(after.allocations);
    expect(expenses).toHaveLength(4);
    expect(cash).toHaveLength(4);
    expect(allocations).toHaveLength(1);
    expect(
      expenses.filter((row) => row.projectId === pessoal[0].id),
    ).toHaveLength(3);
    expect(
      expenses.filter((row) => row.projectId === reformas[0].id),
    ).toHaveLength(1);
    expect(
      expenses
        .filter((row) => row.projectId === pessoal[0].id)
        .map((row) => row.valorTotal)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([10_001, 10_001, 25_000]);
    expect(
      expenses.filter(
        (row) =>
          row.projectId === pessoal[0].id && row.linkedExpenseId !== null,
      ),
    ).toEqual([
      expect.objectContaining({
        titulo: "MATERIAL REFORMA",
        valorTotal: 25_000,
      }),
    ]);
    expect(allocations).toEqual([
      expect.objectContaining({ allocation: 25_000 }),
    ]);
    expect(after.settlements).toEqual([]);
    expect(after.funding).toEqual([]);
    expect(after.merchantRules).toEqual([]);
    expect(after.claimedObservations).toBe(3);

    const invoiceResponse = await page.request.get(
      `${API}/projects/${pessoal[0].id}/monthly-overview/card-invoices-yearly?year=2026`,
    );
    expect(invoiceResponse.status()).toBe(200);
    expect(record(await invoiceResponse.json()).totalAno).toBe(45_002);
    const overviewResponse = await page.request.get(
      `${API}/projects/${pessoal[0].id}/monthly-overview?month=2026-10`,
    );
    expect(overviewResponse.status()).toBe(200);
    const overview = record(await overviewResponse.json());
    const october = list(overview.meses).find(
      (month) => month.mes === "2026-10",
    );
    expect(october?.totalDespesas).toBe(45_002);
    expect(
      expenses
        .filter((row) => row.projectId === reformas[0].id)
        .reduce((sum, row) => sum + Number(row.valorTotal), 0),
    ).toBe(25_000);

    if (!executeRequest) throw new Error("Execute request was not captured");
    expect(executeRequest.headers["x-rf-import-ui"]).toBe("1");
    const replayExecuteBody = record(
      JSON.parse(executeRequest.body) as unknown,
    );
    replayExecuteBodies.push(replayExecuteBody);
    const replayResponse = await page.request.post(
      `${API}${executeRequest.path}`,
      {
        data: replayExecuteBody,
        headers: {
          origin: WEB,
          "x-rf-import-ui": executeRequest.headers["x-rf-import-ui"],
        },
      },
    );
    expect(replayResponse.status()).toBe(200);
    expect(await replayResponse.json()).toEqual(receipt);
    const replayed = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    expect(replayed).toEqual(after);

    const geometryEvidence: Wire[] = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      const resultControl = page.getByRole("button", {
        name: "Importações da Maria",
        exact: true,
      });
      await expect(resultControl).toBeVisible();
      await resultControl.scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Cartão da fatura")).toBeVisible();
      const geometry = await page.evaluate(() => {
        const result = Array.from(document.querySelectorAll("button")).find(
          (element) => element.textContent?.trim() === "Importações da Maria",
        );
        const card = Array.from(document.querySelectorAll("label")).find(
          (element) => element.textContent?.includes("Cartão da fatura"),
        );
        const conversation = document.querySelector(
          '[role="region"][aria-label="Conversa com Maria"]',
        );
        const dock = document.querySelector(".pessoal-minimal-maria-dock");
        if (!(result instanceof HTMLElement))
          throw new Error("Recovery button is missing");
        if (!(card instanceof HTMLElement))
          throw new Error("Authoritative card-invoice intake is missing");
        if (!(dock instanceof HTMLElement))
          throw new Error("Maria dock is missing");
        const rect = (element: Element) => {
          const value = element.getBoundingClientRect();
          return {
            left: value.left,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
            width: value.width,
            height: value.height,
          };
        };
        const resultRect = result.getBoundingClientRect();
        const center = {
          x: resultRect.left + resultRect.width / 2,
          y: resultRect.top + resultRect.height / 2,
        };
        const hit = document.elementFromPoint(center.x, center.y);
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          result: {
            rect: rect(result),
            center,
            centerClickable:
              hit === result || (hit instanceof Node && result.contains(hit)),
            hit: hit
              ? {
                  tag: hit.tagName,
                  classes:
                    hit instanceof HTMLElement ? hit.className : undefined,
                  text: hit.textContent?.trim() ?? "",
                }
              : null,
          },
          card: {
            rect: rect(card),
            insideConversation: conversation?.contains(card) ?? false,
            insideDock: dock.contains(card),
          },
          conversationPresent: conversation !== null,
          dock: rect(dock),
          overflow: {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          },
        };
      });
      geometryEvidence.push(geometry);
      await testInfo.attach(
        `maria-csv-real-geometry-${viewport.width}x${viewport.height}.json`,
        {
          body: Buffer.from(JSON.stringify(geometry, null, 2)),
          contentType: "application/json",
        },
      );
      expect
        .soft(
          geometry.card.insideConversation,
          `Cartão da fatura dentro de Conversa com Maria ${viewport.width}x${viewport.height}`,
        )
        .toBe(true);
      expect
        .soft(
          geometry.card.insideDock,
          `Cartão da fatura fora do dock ${viewport.width}x${viewport.height}`,
        )
        .toBe(false);
      expect
        .soft(
          geometry.result.centerClickable,
          `result recovery ${viewport.width}x${viewport.height} center hit-test`,
        )
        .toBe(true);
      expect
        .soft(
          geometry.result.rect.width,
          `result recovery ${viewport.width}x${viewport.height} width`,
        )
        .toBeGreaterThanOrEqual(44);
      expect
        .soft(
          geometry.result.rect.height,
          `result recovery ${viewport.width}x${viewport.height} height`,
        )
        .toBeGreaterThanOrEqual(44);
      expect
        .soft(
          geometry.dock.top,
          `dock depois do resultado ${viewport.width}x${viewport.height}`,
        )
        .toBeGreaterThanOrEqual(geometry.result.rect.bottom);
      expect
        .soft(
          geometry.dock.height,
          `dock <=220px ${viewport.width}x${viewport.height}`,
        )
        .toBeLessThanOrEqual(220);
      expect
        .soft(
          geometry.overflow.scrollWidth,
          `sem overflow ${viewport.width}x${viewport.height}`,
        )
        .toBeLessThanOrEqual(geometry.overflow.innerWidth);
      await page.screenshot({
        path: testInfo.outputPath(
          `maria-csv-real-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
    }
    await testInfo.attach("maria-csv-real-geometry.json", {
      body: Buffer.from(JSON.stringify(geometryEvidence, null, 2)),
      contentType: "application/json",
    });

    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      url: location.href,
    }));
    expect(storage.url).not.toContain("nonce");
    if (challengeNonce) {
      expect(JSON.stringify(storage)).not.toContain(challengeNonce);
      expect(chatBodies.join("\n")).not.toContain(challengeNonce);
      expect(consoleErrors.join("\n")).not.toContain(challengeNonce);
    }

    // Page events exclude the APIRequestContext replay, which is asserted
    // separately against both its body and the fixture's HTTP request log.
    const expectedPageMutations = [
      "POST /import-sessions",
      "POST /import-sessions/:id/attachments",
      "PUT /import-sessions/:id/attachments/:id/content",
      "POST /import-sessions/:id/attachments/:id/analyze",
      ...Array.from(
        { length: 12 },
        () => "POST /import-sessions/:id/resolutions",
      ),
      ...Array.from(
        { length: 6 },
        () => "POST /import-sessions/:id/interpretations",
      ),
      ...Array.from(
        { length: 9 },
        () => "POST /import-sessions/:id/declarations",
      ),
      "POST /import-sessions/:id/current-lot/prepare",
      ...Array.from(
        { length: 3 },
        () => "POST /import-sessions/:id/resolutions",
      ),
      "POST /import-sessions/:id/current-lot/prepare",
      "POST /import-sessions/:id/current-lot/continue",
      ...Array.from(
        { length: 3 },
        () => "POST /import-sessions/:id/resolutions",
      ),
      "POST /import-sessions/:id/current-lot/prepare",
      "POST /import-sessions/:id/current-lot/continue",
      ...Array.from(
        { length: 3 },
        () => "POST /import-sessions/:id/resolutions",
      ),
      "POST /import-sessions/:id/current-lot/prepare",
      "POST /import-sessions/:id/confirmation-challenge",
      "POST /import-sessions/:id/confirm",
      "POST /import-sessions/:id/execute",
    ];
    expect(pageMutationRequests).toEqual(expectedPageMutations);
    const expectedGuidedMutations = expectedPageMutations.slice(4, -3);
    expect(expectedGuidedMutations).toHaveLength(42);
    expect(guidedMutationCommands.map(({ key }) => key)).toEqual(
      expectedGuidedMutations,
    );
    expect(
      guidedMutationCommands.reduce<Record<string, number>>(
        (counts, { key }) => ({
          ...counts,
          [key]: (counts[key] ?? 0) + 1,
        }),
        {},
      ),
    ).toEqual({
      "POST /import-sessions/:id/resolutions": 21,
      "POST /import-sessions/:id/interpretations": 6,
      "POST /import-sessions/:id/declarations": 9,
      "POST /import-sessions/:id/current-lot/prepare": 4,
      "POST /import-sessions/:id/current-lot/continue": 2,
    });

    const guidedRequestIds = guidedMutationCommands.map(({ body }) =>
      String(body.requestId),
    );
    expect(guidedRequestIds).toEqual(
      Array.from({ length: 42 }, () =>
        expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      ),
    );
    expect(new Set(guidedRequestIds).size).toBe(42);

    const expectedGuidedRevisions = [
      ...Array.from({ length: 12 }, (_, index) => 4 + index),
      ...Array.from({ length: 6 }, () => 16),
      ...Array.from({ length: 9 }, (_, index) => 16 + index),
      25,
      26,
      27,
      28,
      29,
      30,
      31,
      32,
      33,
      34,
      35,
      36,
      37,
      38,
      39,
    ];
    expect(expectedGuidedRevisions).toHaveLength(42);
    expect(
      guidedMutationCommands.map(({ body }) => body.expectedRevision),
      "guided expected revisions must be exact and monotonic; only failed interpretation retries may repeat",
    ).toEqual(expectedGuidedRevisions);

    const answeredQuestionIds = guidedMutationCommands
      .filter(({ key }) => /\/(?:resolutions|declarations)$/.test(key))
      .map(({ body }) => String(body.questionId));
    expect(answeredQuestionIds).toHaveLength(30);
    expect(answeredQuestionIds).toEqual(
      Array.from({ length: 30 }, () => expect.stringMatching(/\S/)),
    );
    expect(new Set(answeredQuestionIds).size).toBe(30);
    const interpretationQuestionIds = guidedMutationCommands
      .filter(({ key }) => key.endsWith("/interpretations"))
      .map(({ body }) => String(body.questionId));
    expect(interpretationQuestionIds).toEqual(
      Array.from({ length: 6 }, () => answeredQuestionIds[12]),
    );

    for (const { key, body } of guidedMutationCommands) {
      const expectedKeys = key.endsWith("/interpretations")
        ? [
            "consentExternalProcessing",
            "expectedRevision",
            "questionId",
            "requestId",
            "text",
            "version",
          ]
        : /\/(?:resolutions|declarations)$/.test(key)
          ? ["answer", "expectedRevision", "questionId", "requestId", "version"]
          : ["expectedRevision", "requestId", "version"];
      expect(Object.keys(body).sort(), key).toEqual(expectedKeys.sort());
    }

    expect(financialMutationCommands.map(({ key }) => key)).toEqual([
      "POST /import-sessions/:id/confirmation-challenge",
      "POST /import-sessions/:id/confirm",
      "POST /import-sessions/:id/execute",
    ]);
    const [challengeCommand, confirmCommand, executeCommand] =
      financialMutationCommands;
    expect(challengeCommand?.body).toEqual({
      expectedRevision: 40,
      confirmationHash: expect.any(String),
    });
    expect(confirmCommand?.body).toEqual({
      expectedRevision: 40,
      confirmationHash: challengeCommand?.body.confirmationHash,
      financialRequestId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      nonce: challengeNonce,
    });
    expect(executeCommand?.body).toEqual({
      financialRequestId: confirmCommand?.body.financialRequestId,
    });
    expect(replayExecuteBodies).toEqual([executeCommand?.body]);

    // The fixture drops the initial execute response after applying the write.
    let interpretationStatusIndex = 0;
    expect(pageMutationStatuses).toEqual(
      expectedPageMutations.slice(0, -1).map((key, index) => {
        const status = key.endsWith("/interpretations")
          ? [503, 502][interpretationStatusIndex++ % 2]
          : index === 0
            ? 201
            : 200;
        return { key, status };
      }),
    );
    expect(resultReads).toEqual([`/import-sessions/${sessionId}/result`]);
    expect(
      chatBodies,
      "structured answers and current-lot preparation never use /agent/chat",
    ).toEqual([]);
    expect(directProviderOrChatRequests).toEqual([]);
    expect(
      documentaryCommands.map(({ path }) =>
        path.replace(/\/import-sessions\/[^/]+/, "/import-sessions/:id"),
      ),
    ).toEqual(
      expectedGuidedMutations
        .filter((key) => !key.endsWith("/interpretations"))
        .map((key) => key.slice("POST ".length)),
    );
    expect
      .soft(currentLotReads)
      .toEqual([
        `/import-sessions/${sessionId}/current-lot`,
        `/import-sessions/${sessionId}/current-lot`,
      ]);

    const logs = await ipc(child, "LOGS");
    const journeyLogs = list(logs.logs).slice(fixtureLogOffset);
    const journeyImportMutations = journeyLogs
      .filter(
        (entry) =>
          entry.method !== "GET" &&
          String(entry.path).startsWith("/import-sessions"),
      )
      .map(
        (entry) =>
          `${String(entry.method)} ${String(entry.path)
            .replace(/\/import-sessions\/[^/]+/, "/import-sessions/:id")
            .replace(/\/attachments\/[^/]+/, "/attachments/:id")}`,
      );
    expect(journeyImportMutations).toEqual([
      ...expectedPageMutations,
      "POST /import-sessions/:id/execute",
    ]);
    expect(
      journeyImportMutations.filter((key) =>
        /\/(?:confirmation-challenge|confirm|execute)$/.test(key),
      ),
    ).toEqual([
      "POST /import-sessions/:id/confirmation-challenge",
      "POST /import-sessions/:id/confirm",
      "POST /import-sessions/:id/execute",
      "POST /import-sessions/:id/execute",
    ]);
    expect(
      journeyLogs
        .filter(
          (entry) =>
            entry.method === "POST" &&
            /\/(?:expenses|cash-flow|allocations|settlements|funding)(?:\/|$)/.test(
              String(entry.path),
            ),
        )
        .map((entry) => entry.path),
      "financial application must not fan out into duplicate browser/API POSTs",
    ).toEqual([]);
    if (challengeNonce)
      expect(JSON.stringify(logs)).not.toContain(challengeNonce);
    const admission = record(
      (
        await ipc(child, "ADMISSION_EVIDENCE", {
          userId: me.id,
        })
      ).evidence,
    );
    expect(admission.requestCount).toBe(0);
    expect(admission.advanceCount).toBe(0);
    expect(admission.clockReadCount).toBe(0);
    expect(admission.mode).toBe("PRIVATE_FIXTURE_VIRTUAL_PACING");
    expect(admission.initialInstant).toBe("2026-10-09T23:30:00.000Z");
    expect(admission.stepMs).toBe(60_000);
    expect(admission.tokenIdentityPreserved).toBe(true);
    expect(admission.finalInstant).toBe("2026-10-09T23:30:00.000Z");
    expect(admission.importSessionInstant).toBe(INSTANT);
    expect(list(admission.dailyQuotaRows)).toEqual([]);
    expect(
      list(logs.logs)
        .filter(
          (entry) => entry.method === "POST" && entry.path === "/agent/chat",
        )
        .map((entry) => entry.status),
    ).toEqual([]);
    expect(authenticatedAuthMeObserved).toBe(true);
    expect(consumedBootstrapAuth401Responses).toBe(
      bootstrapAuth401ResponseCount,
    );
    expect(
      correlatedBootstrapAuthDiagnostics.map(({ type, text, location }) => ({
        type,
        text,
        url: location.url,
      })),
    ).toEqual(
      Array.from({ length: bootstrapAuth401ResponseCount }, () => ({
        type: "error",
        text: chromiumUnauthorizedResourceError,
        url: authMeUrl,
      })),
    );
    expect(
      expectedInterpretationHttp.map((entry) => entry.split(" ", 1)[0]),
    ).toEqual(["503", "502", "503", "502", "503", "502"]);
    expect(interpretationConsoleDiagnostics).toEqual([
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
      "Failed to load resource: the server responded with a status of 502 (Bad Gateway)",
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
      "Failed to load resource: the server responded with a status of 502 (Bad Gateway)",
      "Failed to load resource: the server responded with a status of 503 (Service Unavailable)",
      "Failed to load resource: the server responded with a status of 502 (Bad Gateway)",
    ]);
    expect(unexpectedHttp).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(testAuthorityTransports).toEqual([]);
    expect(egressAttempts).toEqual([]);
  }

  test("real guided review continues after the first ready purchase, seals two, then confirms and replays exactly", async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    await page.setViewportSize(VIEWPORTS[0]);
    await page.clock.setFixedTime(new Date(INSTANT));

    const consoleErrors: string[] = [];
    const unexpectedHttp: string[] = [];
    const pageMutationRequests: string[] = [];
    const pageMutationStatuses: Array<{ key: string; status: number }> = [];
    const resultReads: string[] = [];
    const chatBodies: string[] = [];
    const documentaryCommands: Array<{
      method: string;
      path: string;
      body: Wire;
    }> = [];
    const currentLotReads: string[] = [];
    const testAuthorityTransports: Array<{
      path: string;
      headers: string[];
      cookie: string;
    }> = [];
    const authMeUrl = `${API}/auth/me`;
    const chromiumUnauthorizedResourceError =
      "Failed to load resource: the server responded with a status of 401 (Unauthorized)";
    const correlatedBootstrapAuthDiagnostics: Array<{
      type: string;
      text: string;
      location: { url: string; lineNumber: number; columnNumber: number };
    }> = [];
    let bootstrapAuth401ResponseCount = 0;
    let consumedBootstrapAuth401Responses = 0;
    let authenticatedAuthMeObserved = false;
    let executeRequest:
      | { body: string; headers: Record<string, string>; path: string }
      | undefined;
    let challengeNonce: string | undefined;
    let challengeEvidence: { status: number; body: Wire } | undefined;

    page.on("pageerror", (error) =>
      consoleErrors.push(`pageerror ${error.message}`),
    );
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      if (
        !authenticatedAuthMeObserved &&
        location.url === authMeUrl &&
        message.text() === chromiumUnauthorizedResourceError &&
        consumedBootstrapAuth401Responses < bootstrapAuth401ResponseCount
      ) {
        consumedBootstrapAuth401Responses += 1;
        correlatedBootstrapAuthDiagnostics.push({
          type: message.type(),
          text: message.text(),
          location,
        });
        return;
      }
      consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      const requestHeaders = request.headers();
      const authorityHeaders = Object.keys(requestHeaders).filter((name) =>
        /(?:test|fixture|authority)/i.test(name),
      );
      const cookie = requestHeaders.cookie ?? "";
      if (
        url.origin === API &&
        (authorityHeaders.length > 0 ||
          /(?:test|fixture|authority)[^=]*=/i.test(cookie))
      )
        testAuthorityTransports.push({
          path: url.pathname,
          headers: authorityHeaders,
          cookie,
        });
      const key = mutationKey(request);
      if (key) pageMutationRequests.push(key);
      if (
        url.origin === API &&
        request.method() === "GET" &&
        /^\/import-sessions\/[^/]+\/result$/.test(url.pathname)
      )
        resultReads.push(url.pathname);
      if (url.origin === API && url.pathname === "/agent/chat")
        chatBodies.push(request.postData() ?? "");
      if (
        url.origin === API &&
        request.method() === "POST" &&
        /^\/import-sessions\/[^/]+\/(?:declarations|resolutions|defer|reactivate|current-lot\/(?:prepare|continue))$/.test(
          url.pathname,
        )
      )
        documentaryCommands.push({
          method: request.method(),
          path: url.pathname,
          body: record(request.postDataJSON()),
        });
      if (
        url.origin === API &&
        request.method() === "GET" &&
        /^\/import-sessions\/[^/]+\/current-lot$/.test(url.pathname)
      )
        currentLotReads.push(url.pathname);
      if (
        url.origin === API &&
        request.method() === "POST" &&
        /^\/import-sessions\/[^/]+\/execute$/.test(url.pathname)
      ) {
        executeRequest = {
          body: request.postData() ?? "",
          headers: request.headers(),
          path: url.pathname,
        };
      }
    });
    page.on("response", async (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (
        request.method() === "GET" &&
        response.url() === authMeUrl &&
        !authenticatedAuthMeObserved
      ) {
        if (response.status() === 401) bootstrapAuth401ResponseCount += 1;
        if (response.status() === 200) authenticatedAuthMeObserved = true;
      }
      const key = mutationKey(request);
      if (key) pageMutationStatuses.push({ key, status: response.status() });
      if (
        url.origin === API &&
        /^\/import-sessions\/[^/]+\/confirmation-challenge$/.test(url.pathname)
      ) {
        const body = record(await response.json());
        challengeEvidence = { status: response.status(), body };
        if (typeof body.nonce === "string") challengeNonce = body.nonce;
      }
      if (
        response.status() >= 400 &&
        !(
          response.status() === 401 &&
          request.method() === "GET" &&
          url.origin === API &&
          url.pathname === "/auth/me"
        )
      )
        unexpectedHttp.push(
          `${response.status()} ${request.method()} ${url.pathname}`,
        );
    });
    await page.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host !== "127.0.0.1") return route.abort("blockedbyclient");
      return route.continue();
    });

    await page.goto("/register");
    await page.getByLabel(/^seu nome$/i).fill("Maria CSV QA");
    await page.getByLabel(/email/i).fill("maria-csv-guided@example.test");
    await page.getByLabel(/^senha$/i).fill("Local-only-qa-password-2026");
    await page
      .getByRole("checkbox", { name: /organizar minha vida financeira/i })
      .check();
    await page.getByRole("checkbox", { name: /reformar/i }).check();
    await page.getByRole("button", { name: /criar minha conta/i }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/conta$/);

    const onboarding = page.getByRole("dialog", {
      name: "Jornada: Onboarding — PESSOAL",
      exact: true,
    });
    await expect(onboarding).toBeVisible();
    expect(
      await page.evaluate(() =>
        sessionStorage.getItem("lifeone:journey-runtime"),
      ),
    ).not.toBeNull();
    await onboarding
      .getByRole("button", { name: "Fechar jornada", exact: true })
      .click();
    await expect(onboarding).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => sessionStorage.getItem("lifeone:journey-runtime")),
      )
      .toBeNull();

    const meResponse = await page.request.get(`${API}/auth/me`);
    expect(meResponse.status()).toBe(200);
    const me = record(await meResponse.json());
    expect(me.role).toBe("USER");
    expect(me.isGuest).toBe(false);

    const projectResponse = await page.request.get(`${API}/projects`);
    expect(projectResponse.status()).toBe(200);
    const projects = list(await projectResponse.json());
    const pessoal = projects.filter((project) => project.type === "PESSOAL");
    const reformas = projects.filter((project) => project.type === "REFORMA");
    expect(pessoal).toHaveLength(1);
    expect(reformas).toHaveLength(1);
    if (
      typeof me.id !== "string" ||
      typeof pessoal[0]?.id !== "string" ||
      typeof reformas[0]?.id !== "string" ||
      typeof reformas[0]?.name !== "string"
    )
      throw new Error("Signup did not return stable typed identities");

    await page.goto(`/projects/${pessoal[0].id}/credit-cards?new=1`);
    await expect(page).toHaveURL(
      new RegExp(`/projects/${pessoal[0].id}/credit-cards\\?new=1$`),
    );
    const cardForm = page
      .getByRole("heading", { name: "Novo cartão", exact: true })
      .locator("..")
      .locator("..");
    await expect(cardForm).toBeVisible();
    await cardForm.locator("select").nth(0).selectOption("ITAU");
    await cardForm.locator("select").nth(1).selectOption("Visa");
    await cardForm.getByPlaceholder("Ex: Itaú Click Visa").fill("Maria CSV QA");
    await cardForm.getByPlaceholder("1234").fill("9911");
    await cardForm.getByPlaceholder("25", { exact: true }).fill("20");
    await cardForm.getByPlaceholder("10", { exact: true }).fill("28");
    const cardCreatedResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        url.pathname === `/projects/${pessoal[0].id}/credit-cards`
      );
    });
    await cardForm.getByRole("button", { name: "Salvar" }).click();
    const cardResponse = await cardCreatedResponse;
    expect(cardResponse.status()).toBe(201);
    const card = record(await cardResponse.json());
    expect(card).toMatchObject({
      projectId: pessoal[0].id,
      institution: "ITAU",
      brand: "Visa",
      nickname: "Maria CSV QA",
      last4: "9911",
      closingDay: 20,
      dueDay: 28,
    });
    if (typeof card.id !== "string")
      throw new Error("Normal card UI did not return a typed card identity");
    await expect(cardForm).toHaveCount(0);

    const baseline = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    expect(list(baseline.sessions)).toHaveLength(0);
    expect(list(baseline.artifacts)).toHaveLength(0);
    expect(list(baseline.references)).toHaveLength(0);
    expect(list(baseline.observations)).toHaveLength(0);
    expect(list(baseline.expenses)).toHaveLength(0);
    expect(list(baseline.receipts)).toHaveLength(0);
    expect(list(baseline.cashFlowEntries)).toHaveLength(0);
    expect(list(baseline.allocations)).toHaveLength(0);
    expect(list(baseline.settlements)).toHaveLength(0);
    expect(list(baseline.funding)).toHaveLength(0);
    expect(list(baseline.merchantRules)).toHaveLength(0);
    expect(baseline.claimedObservations).toBe(0);

    const mariaPath = `/projects/${pessoal[0].id}/maria`;
    await page.goto(mariaPath);
    await expect(page.getByRole("heading", { name: "Maria" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`${mariaPath}$`));
    expect(pageMutationRequests).toEqual([]);

    const picker = page.getByLabel("Anexar CSV da fatura");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveAttribute("accept", ".csv,text/csv");
    const cardPicker = page.getByRole("combobox", {
      name: "Cartão da fatura",
    });
    await cardPicker.selectOption({ value: card.id });
    await expect(cardPicker).toHaveValue(card.id);
    await expect(
      page.getByRole("button", { name: "Nova importação" }),
    ).toHaveCount(0);
    await picker.setInputFiles({
      name: "fatura-outubro.csv",
      mimeType: "text/csv",
      buffer: CSV,
    });
    expect(pageMutationRequests).toEqual([]);
    expect(
      record(
        (
          await ipc(child, "SNAPSHOT", {
            userId: me.id,
          })
        ).snapshot,
      ),
    ).toEqual(baseline);

    const consent = page.getByRole("button", {
      name: "Analisar e guardar rascunho",
    });
    await expectTarget(consent, "documentary consent");
    const createdSession = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        url.pathname === "/import-sessions"
      );
    });
    await consent.click();
    const createdSessionResponse = await createdSession;
    expect(createdSessionResponse.status()).toBe(201);
    const createdSessionBody = record(await createdSessionResponse.json());
    if (typeof createdSessionBody.id !== "string")
      throw new Error("Import session id is missing");
    const guidedSessionId = createdSessionBody.id;
    async function readCanonicalGuidedReview() {
      const response = await page.request.get(
        `${API}/import-sessions/${guidedSessionId}`,
      );
      expect(response.status()).toBe(200);
      const view = record(await response.json());
      expect(view.id).toBe(guidedSessionId);
      return { view, ...expectCanonicalGuidedReview(view.guidedReview) };
    }
    const initialGuided = await readCanonicalGuidedReview();
    expect(initialGuided.guidedReview).toEqual({
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: null,
    });

    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    await expect(
      conversation.getByRole("region", { name: "Compra 1 de 4", exact: true }),
    ).toContainText("LOJA GEMEA");
    await expect(
      conversation.getByRole("region", { name: /^Compra \d+ de 4$/ }),
    ).toHaveCount(1);

    const analyzed = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    expect(list(analyzed.sessions)).toHaveLength(1);
    expect(list(analyzed.artifacts)).toHaveLength(1);
    expect(list(analyzed.references)).toHaveLength(1);
    expect(list(analyzed.observations)).toHaveLength(4);
    expect(
      new Set(list(analyzed.observations).map((row) => row.reference)).size,
    ).toBe(4);
    expect(list(analyzed.artifacts)[0]?.documentSha256).toBe(CSV_SHA256);
    for (const key of [
      "expenses",
      "receipts",
      "cashFlowEntries",
      "allocations",
      "settlements",
      "funding",
      "merchantRules",
    ])
      expect(analyzed[key], `${key} before confirmation`).toEqual(
        baseline[key],
      );
    expect(analyzed.claimedObservations).toBe(0);

    await expect(
      conversation.getByText("PAGAMENTO EFETUADO", { exact: false }),
      "the ignored payment is not a competing answer surface",
    ).toHaveCount(0);

    async function expectPreConfirmIntegrity(label: string) {
      const current = record(
        (
          await ipc(child, "SNAPSHOT", {
            userId: me.id,
          })
        ).snapshot,
      );
      const observations = list(current.observations);
      expect(observations, `${label}: four observations`).toHaveLength(4);
      expect(
        new Set(observations.map((row) => row.reference)).size,
        `${label}: distinct observation references`,
      ).toBe(4);
      for (const key of [
        "expenses",
        "receipts",
        "cashFlowEntries",
        "allocations",
        "settlements",
        "funding",
        "merchantRules",
      ])
        expect(current[key], `${label}: ${key}`).toEqual(baseline[key]);
      expect(current.claimedObservations, `${label}: claims`).toBe(0);
    }

    async function visibleRevision() {
      const banner = await page
        .getByText(/Importação .+ · Revisão \d+/)
        .first()
        .innerText();
      const match = /Revisão (\d+)/.exec(banner);
      if (!match) throw new Error(`Missing visible revision in: ${banner}`);
      return Number(match[1]);
    }

    async function focusedPurchaseTitle() {
      const text = await page
        .getByRole("region", { name: /^Compra \d+ de \d+$/ })
        .first()
        .innerText();
      if (text.includes("LOJA GEMEA")) return "LOJA GEMEA";
      if (text.includes("MATERIAL REFORMA")) return "MATERIAL REFORMA";
      if (text.includes("PAGAMENTO EFETUADO")) return "PAGAMENTO EFETUADO";
      throw new Error(`Unexpected focused purchase: ${text}`);
    }

    const savedDocumentQuestionIds = new Set<string>();
    const declarationBodies: Wire[] = [];
    const initialResolutionBodies: Wire[] = [];
    const initialDocumentPaths: string[] = [];
    for (let index = 0; index < 21; index++) {
      const title = await focusedPurchaseTitle();
      expect(title).not.toBe("PAGAMENTO EFETUADO");
      const saved = await answerDeterministicDocumentQuestion(
        page,
        conversation,
        guidedSessionId,
        title,
        savedDocumentQuestionIds,
      );
      const operation = saved.path.endsWith("/declarations")
        ? "declaration"
        : "initial";
      expect(saved.path).toMatch(/\/(?:declarations|resolutions)$/);
      initialDocumentPaths.push(saved.path);
      if (operation === "declaration") declarationBodies.push(saved.body);
      else initialResolutionBodies.push(saved.body);
      await expectPreConfirmIntegrity(`${operation} ${title} ${saved.heading}`);
    }
    expect(declarationBodies).toHaveLength(9);
    expect(initialResolutionBodies).toHaveLength(12);
    expect(
      initialDocumentPaths.map((path) =>
        path.replace(/\/import-sessions\/[^/]+/, ""),
      ),
    ).toEqual([
      ...Array.from({ length: 12 }, () => "/resolutions"),
      ...Array.from({ length: 9 }, () => "/declarations"),
    ]);
    expect(savedDocumentQuestionIds.size).toBe(21);
    await expect(
      conversation.getByText("PAGAMENTO EFETUADO", { exact: false }),
    ).toHaveCount(0);

    const continueGuidedReview = page.getByRole("button", {
      name: "Continuar respondendo",
      exact: true,
    });
    await expect(
      continueGuidedReview,
      "resolved purchase rows must permit review without answering the ignored payment",
    ).toBeVisible();
    const firstPreparation = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await continueGuidedReview.click();
    const firstPreparationResponse = await firstPreparation;
    expect(firstPreparationResponse.status()).toBe(200);
    const firstPrepared = record(await firstPreparationResponse.json());
    const firstPrepareRequest = record(
      firstPreparationResponse.request().postDataJSON(),
    );
    expect(firstPrepared).toEqual({
      version: 1,
      requestId: firstPrepareRequest.requestId,
      operation: "PREPARE_CURRENT_LOT",
      outcome: "NEEDS_INPUT",
      revision: 26,
    });
    const preparationRevisions = [firstPrepared.revision];

    await expect(
      conversation.getByRole("region", {
        name: "Compra 1 de 3",
        exact: true,
      }),
    ).toContainText("LOJA GEMEA");
    await expect(
      conversation.getByRole("region", { name: /^Compra \d+ de 4$/ }),
      "the invoice payment remains an observation but leaves the guided denominator",
    ).toHaveCount(0);

    const preparationSteps = [
      {
        title: "LOJA GEMEA",
        field: "decision",
        purchaseOrdinal: 1,
        questionOrdinal: 1,
        questionTotal: 3,
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        title: "LOJA GEMEA",
        field: "targets",
        purchaseOrdinal: 1,
        questionOrdinal: 2,
        questionTotal: 3,
        answer: { kind: "TARGETS", value: [] },
      },
      {
        title: "LOJA GEMEA",
        field: "tipoDespesa",
        purchaseOrdinal: 1,
        questionOrdinal: 3,
        questionTotal: 3,
        answer: { kind: "EXPENSE_TYPE", value: "COMPRAS_VAREJO" },
      },
      {
        title: "LOJA GEMEA",
        field: "decision",
        purchaseOrdinal: 2,
        questionOrdinal: 1,
        questionTotal: 3,
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        title: "LOJA GEMEA",
        field: "targets",
        purchaseOrdinal: 2,
        questionOrdinal: 2,
        questionTotal: 3,
        answer: { kind: "TARGETS", value: [] },
      },
      {
        title: "LOJA GEMEA",
        field: "tipoDespesa",
        purchaseOrdinal: 2,
        questionOrdinal: 3,
        questionTotal: 3,
        answer: { kind: "EXPENSE_TYPE", value: "COMPRAS_VAREJO" },
      },
    ] as const;
    const guidedControlByField = {
      decision: "DECISION",
      targets: "TARGETS",
      tipoDespesa: "EXPENSE_TYPE",
    } as const;
    const guidedChatOffset = chatBodies.length;
    const guidedCommandOffset = documentaryCommands.length;
    const guidedMutationOffset = pageMutationRequests.length;
    const targetCardinalities: number[] = [];
    for (const [index, step] of preparationSteps.entries()) {
      if (index === 3) {
        const awaitingSearch = await readCanonicalGuidedReview();
        expect(awaitingSearch.view).toMatchObject({
          state: "DRAFT",
          revision: 29,
          searchComplete: false,
          proposal: null,
          confirmation: null,
        });
        expect(awaitingSearch.guidedReview).toEqual({
          progress: "ANSWERING",
          actions: ["CONTINUE_ANSWERING"],
          focus: null,
        });
        expect(
          list(awaitingSearch.view.lines)
            .filter((line) => line.titulo === "LOJA GEMEA")
            .map((line) => line.decision),
        ).toEqual([
          { kind: "CREATE", acceptNaturalDuplicate: false },
          { kind: "UNRESOLVED" },
        ]);

        const sealFirstPurchase = page.waitForResponse((response) => {
          const url = new URL(response.url());
          return (
            response.request().method() === "POST" &&
            url.origin === API &&
            /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(
              url.pathname,
            )
          );
        });
        await conversation
          .getByRole("button", {
            name: "Continuar respondendo",
            exact: true,
          })
          .click();
        const sealedResponse = await sealFirstPurchase;
        expect(sealedResponse.status()).toBe(200);
        const sealedBody = record(await sealedResponse.json());
        const sealedRequest = record(sealedResponse.request().postDataJSON());
        expect(sealedBody).toEqual({
          version: 1,
          requestId: sealedRequest.requestId,
          operation: "PREPARE_CURRENT_LOT",
          outcome: "CURRENT_LOT_READY",
          revision: 30,
        });
        preparationRevisions.push(sealedBody.revision);

        const firstReady = await readCanonicalGuidedReview();
        expect(firstReady.view).toMatchObject({
          state: "READY",
          revision: 30,
          searchComplete: true,
          confirmation: null,
        });
        expect(firstReady.guidedReview).toEqual({
          progress: "READY_WITH_PENDING",
          actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
          focus: null,
        });
        const firstLotResponse = await page.request.get(
          `${API}/import-sessions/${guidedSessionId}/current-lot`,
        );
        expect(firstLotResponse.status()).toBe(200);
        const firstLot = record(await firstLotResponse.json());
        expect(firstLot).toMatchObject({
          state: "READY_WITH_PENDING",
          revision: 30,
          createdEconomicTotalCents: 10_001,
          bankCashDeltaCents: 0,
          hasRemainingWork: true,
        });
        expect(list(firstLot.purchases)).toHaveLength(1);
        expect(JSON.stringify(firstLot)).not.toMatch(
          /MATERIAL REFORMA|25000|PAGAMENTO EFETUADO/,
        );

        const continueResponsePromise = page.waitForResponse(
          (response) => {
            const url = new URL(response.url());
            return (
              response.request().method() === "POST" &&
              url.origin === API &&
              /^\/import-sessions\/[^/]+\/current-lot\/continue$/.test(
                url.pathname,
              )
            );
          },
          { timeout: 15_000 },
        );
        await conversation
          .getByRole("button", {
            name: "Continuar respondendo",
            exact: true,
          })
          .click();
        const continuedResponse = await continueResponsePromise;
        expect(continuedResponse.status()).toBe(200);
        const continuedRequest = record(
          continuedResponse.request().postDataJSON(),
        );
        expect(continuedRequest).toEqual({
          version: 1,
          requestId: expect.any(String),
          expectedRevision: 30,
        });
        expect(continuedRequest).not.toHaveProperty("lineId");
        expect(record(await continuedResponse.json())).toEqual({
          version: 1,
          requestId: continuedRequest.requestId,
          operation: "CONTINUE_ANSWERING",
          outcome: "NEEDS_INPUT",
          revision: 31,
        });
        await expectPreConfirmIntegrity("continue after first ready purchase");
      }
      const canonical = await readCanonicalGuidedReview();
      if (!canonical.focus)
        throw new Error(`Missing guided focus at step ${index + 1}`);
      expect(canonical.guidedReview.progress).toBe("ANSWERING");
      expect(canonical.guidedReview.actions).toEqual(["CONTINUE_ANSWERING"]);
      expect(canonical.focus).toMatchObject({
        control: guidedControlByField[step.field],
        context: { title: step.title },
        purchaseOrdinal: step.purchaseOrdinal,
        purchaseTotal: 3,
        questionOrdinal: step.questionOrdinal,
        questionTotal: step.questionTotal,
      });
      const option = matchingGuidedOptionLabel(canonical.focus, step.answer);
      if (step.answer.kind === "TARGETS")
        targetCardinalities.push(step.answer.value.length);
      const form = conversation.locator("form").first();
      expect(await focusedPurchaseTitle()).toBe(step.title);
      const heading = await form.getByRole("heading").innerText();
      expect(heading).toBe(canonical.focus.prompt);
      const radio = form.getByRole("radio", {
        name: option,
        exact: true,
      });
      const select = form.getByRole("combobox");
      let control: Locator;
      if ((await radio.count()) === 1) {
        control = radio;
      } else {
        await expect(
          select,
          `${step.field} must be a closed server-authorized control`,
        ).toHaveCount(1);
        control = select;
      }
      if (index === 0 || index === 3) {
        await expect(
          control,
          "the continuation path focuses its newly server-selected control",
        ).toBeFocused();
      }
      if ((await radio.count()) === 1) {
        await radio.check();
      } else {
        await select.selectOption({ label: option });
      }
      const hitTarget =
        (await control.getAttribute("type")) === "radio"
          ? control.locator("xpath=..")
          : control;
      const hitBox = await hitTarget.boundingBox();
      expect(
        hitBox?.height,
        `${step.field} structured hit area`,
      ).toBeGreaterThanOrEqual(44);

      await form
        .getByRole("button", { name: "Conferir informação", exact: true })
        .click();
      const preview = page.getByRole("region", {
        name: "Confira antes de guardar",
      });
      await expect(preview).toContainText(option);
      await expect(preview).not.toContainText("2026-10-03,LOJA GEMEA,100.01");
      await expect(preview).not.toContainText(
        "2026-10-04,MATERIAL REFORMA,250.00",
      );
      const save = preview.getByRole("button", {
        name: "Guardar e continuar",
        exact: true,
      });
      await expectTarget(save, `${step.title} ${step.field}`);
      const responsePromise = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.origin === API &&
          /^\/import-sessions\/[^/]+\/resolutions$/.test(url.pathname)
        );
      });
      await save.click();
      const response = await responsePromise;
      const responseText = await response.text();
      expect(
        response.status(),
        `${step.title} ${step.field}: ${responseText}`,
      ).toBe(200);
      const resolution = record(JSON.parse(responseText) as unknown);
      const request = record(response.request().postDataJSON());
      expect(request).toEqual({
        version: 1,
        requestId: expect.any(String),
        expectedRevision: 26 + index + 2 * Math.floor(index / 3),
        questionId: expect.any(String),
        answer: step.answer,
      });
      expect(resolution.revision).toBe(27 + index + 2 * Math.floor(index / 3));
      await expect(preview).toHaveCount(0);
      await expectPreConfirmIntegrity(`guided ${step.title} ${step.field}`);

      if (index === 0) {
        const firstDecisionSnapshot = record(
          (
            await ipc(child, "SNAPSHOT", {
              userId: me.id,
            })
          ).snapshot,
        );
        const sessions = list(firstDecisionSnapshot.sessions);
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({ state: "DRAFT", revision: 27 });
        const draft = record(
          JSON.parse(String(sessions[0]!.draftJson)) as unknown,
        );
        expect(list(draft.questions)).toHaveLength(8);
        expect(
          list(draft.lines).filter(
            (line) => record(line.decision).kind === "CREATE",
          ),
        ).toEqual([
          expect.objectContaining({
            titulo: "LOJA GEMEA",
            decision: { kind: "CREATE", acceptNaturalDuplicate: false },
          }),
        ]);
      }
    }
    expect(targetCardinalities).toEqual([0, 0]);
    expect(chatBodies.slice(guidedChatOffset)).toEqual([]);
    expect(
      documentaryCommands
        .slice(guidedCommandOffset)
        .map(({ path }) => path.replace(/\/import-sessions\/[^/]+/, "")),
    ).toEqual([
      ...Array.from({ length: 3 }, () => "/resolutions"),
      "/current-lot/prepare",
      "/current-lot/continue",
      ...Array.from({ length: 3 }, () => "/resolutions"),
    ]);
    expect(
      documentaryCommands
        .slice(guidedCommandOffset)
        .filter(({ path }) => path.endsWith("/resolutions")),
    ).toHaveLength(6);
    expect(
      pageMutationRequests
        .slice(guidedMutationOffset)
        .filter((key) => /(?:agent\/chat|interpretations|defer)/.test(key)),
    ).toEqual([]);
    expect(
      documentaryCommands
        .slice(guidedCommandOffset)
        .filter(
          ({ path, body }) =>
            path.endsWith("/resolutions") &&
            record(body.answer).kind === "DECISION",
        )
        .map(({ body }) => ({
          expectedRevision: body.expectedRevision,
          value: record(body.answer).value,
        })),
      "each decision must use the revision selected by the server",
    ).toEqual([
      {
        expectedRevision: 26,
        value: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
      {
        expectedRevision: 31,
        value: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    ]);
    const pendingPaymentGuided = await readCanonicalGuidedReview();
    expect(pendingPaymentGuided.view).toMatchObject({
      state: "DRAFT",
      revision: 34,
      searchComplete: false,
      proposal: null,
      confirmation: null,
    });
    expect(pendingPaymentGuided.guidedReview).toEqual({
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: null,
    });
    const prepareResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(url.pathname)
      );
    });
    await page
      .getByRole("button", { name: "Continuar respondendo", exact: true })
      .click();
    const readyResponse = await prepareResponse;
    expect(readyResponse.status()).toBe(200);
    const ready = record(await readyResponse.json());
    const readyRequest = record(readyResponse.request().postDataJSON());
    expect(ready).toEqual({
      version: 1,
      requestId: readyRequest.requestId,
      operation: "PREPARE_CURRENT_LOT",
      outcome: "CURRENT_LOT_READY",
      revision: 35,
    });
    preparationRevisions.push(ready.revision);
    expect(preparationRevisions).toEqual([26, 30, 35]);

    const sealedTwo = await readCanonicalGuidedReview();
    expect(sealedTwo.view).toMatchObject({
      state: "READY",
      revision: 35,
      searchComplete: true,
      confirmation: null,
    });
    expect(sealedTwo.guidedReview).toEqual({
      progress: "READY_WITH_PENDING",
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
      focus: null,
    });
    await expectPreConfirmIntegrity("two-purchase seal");

    const mutationsBeforeReview = pageMutationRequests.length;
    const readsBeforeReview = currentLotReads.length;
    const reviewResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.origin === API &&
        url.pathname === `/import-sessions/${guidedSessionId}/current-lot`
      );
    });
    const reviewReady = conversation.getByRole("button", {
      name: "Revisar as prontas agora",
      exact: true,
    });
    await expectTarget(reviewReady, "review two ready purchases");
    await reviewReady.click();
    const reviewResponse = await reviewResponsePromise;
    expect(reviewResponse.status()).toBe(200);
    const lot = record(await reviewResponse.json());
    expect(lot).toMatchObject({
      state: "READY_WITH_PENDING",
      revision: 35,
      createdEconomicTotalCents: 20_002,
      bankCashDeltaCents: 0,
      hasRemainingWork: true,
    });
    expect(list(lot.purchases)).toHaveLength(2);
    expect(JSON.stringify(lot)).not.toMatch(
      /MATERIAL REFORMA|25000|PAGAMENTO EFETUADO/,
    );
    expect(pageMutationRequests).toHaveLength(mutationsBeforeReview);
    expect(currentLotReads).toHaveLength(readsBeforeReview + 1);
    const stableAfterReview = await readCanonicalGuidedReview();
    expect(stableAfterReview.view).toMatchObject({
      state: "READY",
      revision: 35,
    });
    await expectPreConfirmIntegrity("GET-only review");

    const purchaseRows = page
      .getByRole("list", { name: "Compras prontas deste lote" })
      .getByRole("listitem");
    const twins = purchaseRows.filter({ hasText: "LOJA GEMEA" });
    await expect(twins).toHaveCount(2);
    await expect(twins.nth(0)).not.toHaveText(/MATERIAL REFORMA/);
    await expect(twins.nth(1)).not.toHaveText(/MATERIAL REFORMA/);
    await expect(
      page.getByRole("list", { name: "Compras prontas deste lote" }),
    ).not.toContainText(/MATERIAL REFORMA|PAGAMENTO EFETUADO/);

    const session = list(analyzed.sessions)[0]!;
    const sessionId = String(session.id);
    const confirmation = page.getByRole("button", {
      name: "Confirmar compras deste lote",
      exact: true,
    });
    await expect(confirmation).toHaveCount(1);

    const confirmedResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        /^\/import-sessions\/[^/]+\/confirm$/.test(url.pathname)
      );
    });
    let releaseExecute!: () => void;
    const executeMayContinue = new Promise<void>((resolvePromise) => {
      releaseExecute = resolvePromise;
    });
    await page.route(
      `${API}/import-sessions/${sessionId}/execute`,
      async (route) => {
        await executeMayContinue;
        await route.continue();
      },
    );
    await expectTarget(confirmation, "single financial confirmation");
    await confirmation.click();
    const confirmedResponse = await confirmedResponsePromise;
    expect(confirmedResponse.status()).toBe(200);
    const confirmed = record(await confirmedResponse.json());
    expect(confirmed).toMatchObject({
      sessionId,
      state: "CONFIRMED",
      financialRequestId: expect.any(String),
    });
    const confirmedRowResponse = await page.request.get(
      `${API}/import-sessions/${sessionId}`,
    );
    expect(confirmedRowResponse.status()).toBe(200);
    expect(record(await confirmedRowResponse.json())).toMatchObject({
      state: "CONFIRMED",
      revision: 36,
      confirmation: {
        financialRequestId: confirmed.financialRequestId,
        confirmedRevision: 35,
      },
    });
    releaseExecute();
    const applied = await ipc(child, "WAIT_APPLIED", { userId: me.id }, 20_000);
    expect(applied.sessionId).toBe(sessionId);
    expect(executeRequest).toBeDefined();
    expect(challengeEvidence?.status).toBe(200);
    expect(challengeEvidence?.body.expiresAt).toBe("2026-10-09T03:05:00.000Z");
    expect(
      Date.parse(String(challengeEvidence?.body.expiresAt)) -
        Date.parse(INSTANT),
    ).toBe(300_000);

    const recoveredByGet = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "GET" &&
        url.origin === API &&
        url.pathname === `/import-sessions/${sessionId}/result`
      );
    });
    await page.reload();
    await expect(page).toHaveURL(new RegExp(`${mariaPath}$`));
    const resultResponse = await recoveredByGet;
    expect(resultResponse.status()).toBe(200);
    const result = record(await resultResponse.json());
    expect(result.state).toBe("APPLIED");
    const receipt = record(result.receipt);
    expect(receipt.confirmedRevision).toBe(35);
    expect(receipt.continuationSessionId).toEqual(expect.any(String));
    const appliedRowResponse = await page.request.get(
      `${API}/import-sessions/${sessionId}`,
    );
    expect(appliedRowResponse.status()).toBe(200);
    expect(record(await appliedRowResponse.json())).toMatchObject({
      state: "APPLIED",
      revision: 37,
      confirmation: {
        financialRequestId: confirmed.financialRequestId,
        confirmedRevision: 35,
      },
    });
    expect(list(receipt.items).map((item) => item.outcome)).toEqual([
      "CREATED",
      "CREATED",
    ]);
    expect(list(receipt.items)).toHaveLength(2);
    expect(list(receipt.auditItems)).toEqual([
      expect.objectContaining({
        outcome: "IGNORED",
        reason: "INVOICE_PAYMENT",
        amountCents: -45_002,
      }),
    ]);
    const continuationId = String(receipt.continuationSessionId);
    const continuationResponse = await page.request.get(
      `${API}/import-sessions/${continuationId}`,
    );
    expect(continuationResponse.status()).toBe(200);
    const continuation = record(await continuationResponse.json());
    expect(continuation).toMatchObject({
      id: continuationId,
      state: "DRAFT",
      revision: 1,
      confirmation: null,
      receipt: null,
    });
    expect(list(continuation.lines)).toEqual([
      expect.objectContaining({
        titulo: "MATERIAL REFORMA",
        decision: { kind: "UNRESOLVED" },
      }),
    ]);
    expect(JSON.stringify(continuation)).not.toContain("PAGAMENTO EFETUADO");

    const after = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    const expenses = list(after.expenses);
    const cash = list(after.cashFlowEntries);
    const allocations = list(after.allocations);
    expect(expenses).toHaveLength(2);
    expect(cash).toHaveLength(2);
    expect(allocations).toHaveLength(0);
    expect(
      expenses.filter((row) => row.projectId === pessoal[0].id),
    ).toHaveLength(2);
    expect(
      expenses.filter((row) => row.projectId === reformas[0].id),
    ).toHaveLength(0);
    expect(
      expenses
        .filter((row) => row.projectId === pessoal[0].id)
        .map((row) => row.valorTotal)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([10_001, 10_001]);
    expect(
      expenses.filter(
        (row) =>
          row.projectId === pessoal[0].id && row.linkedExpenseId !== null,
      ),
    ).toEqual([]);
    expect(allocations).toEqual([]);
    expect(after.settlements).toEqual([]);
    expect(after.funding).toEqual([]);
    expect(after.merchantRules).toEqual([]);
    expect(after.claimedObservations).toBe(2);

    const invoiceResponse = await page.request.get(
      `${API}/projects/${pessoal[0].id}/monthly-overview/card-invoices-yearly?year=2026`,
    );
    expect(invoiceResponse.status()).toBe(200);
    expect(record(await invoiceResponse.json()).totalAno).toBe(20_002);
    const overviewResponse = await page.request.get(
      `${API}/projects/${pessoal[0].id}/monthly-overview?month=2026-10`,
    );
    expect(overviewResponse.status()).toBe(200);
    const overview = record(await overviewResponse.json());
    const october = list(overview.meses).find(
      (month) => month.mes === "2026-10",
    );
    expect(october?.totalDespesas).toBe(20_002);
    expect(
      expenses
        .filter((row) => row.projectId === reformas[0].id)
        .reduce((sum, row) => sum + Number(row.valorTotal), 0),
    ).toBe(0);

    if (!executeRequest) throw new Error("Execute request was not captured");
    expect(executeRequest.headers["x-rf-import-ui"]).toBe("1");
    const replayResponse = await page.request.post(
      `${API}${executeRequest.path}`,
      {
        data: JSON.parse(executeRequest.body),
        headers: {
          origin: WEB,
          "x-rf-import-ui": executeRequest.headers["x-rf-import-ui"],
        },
      },
    );
    expect(replayResponse.status()).toBe(200);
    expect(await replayResponse.json()).toEqual(receipt);
    const replayed = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    expect(replayed).toEqual(after);

    const geometryEvidence: Wire[] = [];
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      const resultControl = page.getByRole("button", {
        name: "Importações da Maria",
        exact: true,
      });
      await expect(resultControl).toBeVisible();
      await resultControl.scrollIntoViewIfNeeded();
      await expect(page.getByLabel("Cartão da fatura")).toBeVisible();
      const geometry = await page.evaluate(() => {
        const result = Array.from(document.querySelectorAll("button")).find(
          (element) => element.textContent?.trim() === "Importações da Maria",
        );
        const card = Array.from(document.querySelectorAll("label")).find(
          (element) => element.textContent?.includes("Cartão da fatura"),
        );
        const conversation = document.querySelector(
          '[role="region"][aria-label="Conversa com Maria"]',
        );
        const dock = document.querySelector(".pessoal-minimal-maria-dock");
        if (!(result instanceof HTMLElement))
          throw new Error("Recovery button is missing");
        if (!(card instanceof HTMLElement))
          throw new Error("Authoritative card-invoice intake is missing");
        if (!(dock instanceof HTMLElement))
          throw new Error("Maria dock is missing");
        const rect = (element: Element) => {
          const value = element.getBoundingClientRect();
          return {
            left: value.left,
            top: value.top,
            right: value.right,
            bottom: value.bottom,
            width: value.width,
            height: value.height,
          };
        };
        const resultRect = result.getBoundingClientRect();
        const center = {
          x: resultRect.left + resultRect.width / 2,
          y: resultRect.top + resultRect.height / 2,
        };
        const hit = document.elementFromPoint(center.x, center.y);
        return {
          viewport: { width: window.innerWidth, height: window.innerHeight },
          result: {
            rect: rect(result),
            center,
            centerClickable:
              hit === result || (hit instanceof Node && result.contains(hit)),
            hit: hit
              ? {
                  tag: hit.tagName,
                  classes:
                    hit instanceof HTMLElement ? hit.className : undefined,
                  text: hit.textContent?.trim() ?? "",
                }
              : null,
          },
          card: {
            rect: rect(card),
            insideConversation: conversation?.contains(card) ?? false,
            insideDock: dock.contains(card),
          },
          conversationPresent: conversation !== null,
          dock: rect(dock),
          overflow: {
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          },
        };
      });
      geometryEvidence.push(geometry);
      await testInfo.attach(
        `maria-csv-real-geometry-${viewport.width}x${viewport.height}.json`,
        {
          body: Buffer.from(JSON.stringify(geometry, null, 2)),
          contentType: "application/json",
        },
      );
      expect
        .soft(
          geometry.card.insideConversation,
          `Cartão da fatura dentro de Conversa com Maria ${viewport.width}x${viewport.height}`,
        )
        .toBe(true);
      expect
        .soft(
          geometry.card.insideDock,
          `Cartão da fatura fora do dock ${viewport.width}x${viewport.height}`,
        )
        .toBe(false);
      expect
        .soft(
          geometry.result.centerClickable,
          `result recovery ${viewport.width}x${viewport.height} center hit-test`,
        )
        .toBe(true);
      expect
        .soft(
          geometry.result.rect.width,
          `result recovery ${viewport.width}x${viewport.height} width`,
        )
        .toBeGreaterThanOrEqual(44);
      expect
        .soft(
          geometry.result.rect.height,
          `result recovery ${viewport.width}x${viewport.height} height`,
        )
        .toBeGreaterThanOrEqual(44);
      expect
        .soft(
          geometry.dock.top,
          `dock depois do resultado ${viewport.width}x${viewport.height}`,
        )
        .toBeGreaterThanOrEqual(geometry.result.rect.bottom);
      expect
        .soft(
          geometry.dock.height,
          `dock <=220px ${viewport.width}x${viewport.height}`,
        )
        .toBeLessThanOrEqual(220);
      expect
        .soft(
          geometry.overflow.scrollWidth,
          `sem overflow ${viewport.width}x${viewport.height}`,
        )
        .toBeLessThanOrEqual(geometry.overflow.innerWidth);
      await page.screenshot({
        path: testInfo.outputPath(
          `maria-csv-real-${viewport.width}x${viewport.height}.png`,
        ),
        fullPage: true,
      });
    }
    await testInfo.attach("maria-csv-real-geometry.json", {
      body: Buffer.from(JSON.stringify(geometryEvidence, null, 2)),
      contentType: "application/json",
    });

    const storage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
      url: location.href,
    }));
    expect(storage.url).not.toContain("nonce");
    if (challengeNonce) {
      expect(JSON.stringify(storage)).not.toContain(challengeNonce);
      expect(chatBodies.join("\n")).not.toContain(challengeNonce);
      expect(consoleErrors.join("\n")).not.toContain(challengeNonce);
    }

    // Page events exclude only the APIRequestContext replay. All documentary
    // commands are direct authenticated browser requests, never chat writes.
    const expectedPageMutations = [
      "POST /import-sessions",
      "POST /import-sessions/:id/attachments",
      "PUT /import-sessions/:id/attachments/:id/content",
      "POST /import-sessions/:id/attachments/:id/analyze",
      ...Array(12).fill("POST /import-sessions/:id/resolutions"),
      ...Array(9).fill("POST /import-sessions/:id/declarations"),
      "POST /import-sessions/:id/current-lot/prepare",
      ...Array(3).fill("POST /import-sessions/:id/resolutions"),
      "POST /import-sessions/:id/current-lot/prepare",
      "POST /import-sessions/:id/current-lot/continue",
      ...Array(3).fill("POST /import-sessions/:id/resolutions"),
      "POST /import-sessions/:id/current-lot/prepare",
      "POST /import-sessions/:id/confirmation-challenge",
      "POST /import-sessions/:id/confirm",
      "POST /import-sessions/:id/execute",
    ];
    expect(pageMutationRequests).toEqual(expectedPageMutations);
    expect(
      documentaryCommands.filter(({ path }) =>
        path.endsWith("/current-lot/prepare"),
      ),
    ).toHaveLength(3);
    expect(
      pageMutationRequests.filter((key) => key.endsWith("/interpretations")),
    ).toEqual([]);
    // The fixture drops the initial execute response after applying the write.
    expect(pageMutationStatuses).toEqual(
      expectedPageMutations.slice(0, -1).map((key, index) => ({
        key,
        status: index === 0 ? 201 : 200,
      })),
    );
    expect(resultReads).toEqual([`/import-sessions/${sessionId}/result`]);
    expect
      .soft(
        chatBodies,
        "structured answers and current-lot preparation never use /agent/chat",
      )
      .toEqual([]);
    expect
      .soft(
        documentaryCommands.map(({ path }) =>
          path.replace(/\/import-sessions\/[^/]+/, "/import-sessions/:id"),
        ),
      )
      .toEqual(
        expect.arrayContaining([
          "/import-sessions/:id/declarations",
          "/import-sessions/:id/resolutions",
          "/import-sessions/:id/current-lot/prepare",
          "/import-sessions/:id/current-lot/continue",
        ]),
      );
    for (const command of documentaryCommands) {
      expect.soft(command.body).toMatchObject({
        version: 1,
        requestId: expect.any(String),
        expectedRevision: expect.any(Number),
      });
      expect
        .soft(Object.keys(command.body))
        .not.toEqual(
          expect.arrayContaining([
            "lines",
            "selectedLineIds",
            "literalAnswer",
            "field",
            "observationId",
          ]),
        );
    }
    expect
      .soft(currentLotReads)
      .toEqual([
        `/import-sessions/${sessionId}/current-lot`,
        `/import-sessions/${sessionId}/current-lot`,
      ]);

    const logs = await ipc(child, "LOGS");
    if (challengeNonce)
      expect(JSON.stringify(logs)).not.toContain(challengeNonce);
    /*
     * Integration-dependent on the backend admission-clock fixture commit:
     * this base still reaches the legitimate 429 before this IPC is available.
     * Keep the exact release contract here so the integrated real-byte run
     * cannot turn green without proving the midnight quota split.
     */
    const admission = record(
      (
        await ipc(child, "ADMISSION_EVIDENCE", {
          userId: me.id,
        })
      ).evidence,
    );
    expect(admission.requestCount).toBe(0);
    expect(admission.advanceCount).toBe(0);
    expect(admission.clockReadCount).toBe(0);
    expect(admission.mode).toBe("PRIVATE_FIXTURE_VIRTUAL_PACING");
    expect(admission.initialInstant).toBe("2026-10-09T23:30:00.000Z");
    expect(admission.stepMs).toBe(60_000);
    expect(admission.tokenIdentityPreserved).toBe(true);
    expect(admission.finalInstant).toBe("2026-10-09T23:30:00.000Z");
    expect(admission.importSessionInstant).toBe(INSTANT);
    expect(list(admission.dailyQuotaRows)).toEqual([]);
    expect(
      list(logs.logs)
        .filter(
          (entry) => entry.method === "POST" && entry.path === "/agent/chat",
        )
        .map((entry) => entry.status),
    ).toEqual([]);
    expect(authenticatedAuthMeObserved).toBe(true);
    expect(consumedBootstrapAuth401Responses).toBe(
      bootstrapAuth401ResponseCount,
    );
    expect(
      correlatedBootstrapAuthDiagnostics.map(({ type, text, location }) => ({
        type,
        text,
        url: location.url,
      })),
    ).toEqual(
      Array.from({ length: bootstrapAuth401ResponseCount }, () => ({
        type: "error",
        text: chromiumUnauthorizedResourceError,
        url: authMeUrl,
      })),
    );
    expect(unexpectedHttp).toEqual([]);
    expect(consoleErrors).toEqual([]);
    expect(testAuthorityTransports).toEqual([]);
  });

  test("real review at the first ready purchase is GET-only and continues with purchases two and three", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(VIEWPORTS[1]);
    await page.clock.setFixedTime(new Date(INSTANT));
    const consoleErrors: string[] = [];
    const unexpectedHttp: string[] = [];
    const mutations: string[] = [];
    const providerRequests: string[] = [];
    const authMeUrl = `${API}/auth/me`;
    const chromiumUnauthorizedResourceError =
      "Failed to load resource: the server responded with a status of 401 (Unauthorized)";
    let bootstrapAuth401ResponseCount = 0;
    let consumedBootstrapAuth401Responses = 0;
    let authenticatedAuthMeObserved = false;
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      if (
        !authenticatedAuthMeObserved &&
        message.location().url === authMeUrl &&
        message.text() === chromiumUnauthorizedResourceError &&
        consumedBootstrapAuth401Responses < bootstrapAuth401ResponseCount
      ) {
        consumedBootstrapAuth401Responses += 1;
        return;
      }
      consoleErrors.push(message.text());
    });
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        url.origin === API &&
        (url.pathname === "/agent/chat" ||
          url.pathname.endsWith("/interpretations"))
      )
        providerRequests.push(`${request.method()} ${url.pathname}`);
      const key = mutationKey(request);
      if (key) mutations.push(key);
    });
    page.on("response", (response) => {
      const request = response.request();
      const url = new URL(response.url());
      if (response.url() === authMeUrl && !authenticatedAuthMeObserved) {
        if (response.status() === 401) bootstrapAuth401ResponseCount += 1;
        if (response.status() === 200) authenticatedAuthMeObserved = true;
      }
      if (
        response.status() >= 400 &&
        !(
          response.status() === 401 &&
          request.method() === "GET" &&
          url.origin === API &&
          url.pathname === "/auth/me"
        )
      )
        unexpectedHttp.push(
          `${response.status()} ${request.method()} ${url.pathname}`,
        );
    });
    await page.route("**/*", (route) => {
      const host = new URL(route.request().url()).hostname;
      if (host !== "127.0.0.1") return route.abort("blockedbyclient");
      return route.continue();
    });

    await page.goto("/register");
    await page.getByLabel(/^seu nome$/i).fill("Maria CSV Mixed QA");
    await page.getByLabel(/email/i).fill("maria-csv-mixed@example.test");
    await page.getByLabel(/^senha$/i).fill("Local-only-qa-password-2026");
    await page
      .getByRole("checkbox", { name: /organizar minha vida financeira/i })
      .check();
    await page.getByRole("checkbox", { name: /reformar/i }).check();
    await page.getByRole("button", { name: /criar minha conta/i }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/conta$/);
    const onboarding = page.getByRole("dialog", {
      name: "Jornada: Onboarding — PESSOAL",
      exact: true,
    });
    await expect(onboarding).toBeVisible();
    await onboarding
      .getByRole("button", { name: "Fechar jornada", exact: true })
      .click();

    const me = record(await (await page.request.get(`${API}/auth/me`)).json());
    const projects = list(
      await (await page.request.get(`${API}/projects`)).json(),
    );
    const pessoal = projects.filter((project) => project.type === "PESSOAL");
    const reformas = projects.filter((project) => project.type === "REFORMA");
    expect(pessoal).toHaveLength(1);
    expect(reformas).toHaveLength(1);
    if (
      typeof me.id !== "string" ||
      typeof pessoal[0]?.id !== "string" ||
      typeof reformas[0]?.id !== "string" ||
      typeof reformas[0]?.name !== "string"
    )
      throw new Error("Mixed Journey identities are incomplete");

    await page.goto(`/projects/${pessoal[0].id}/credit-cards?new=1`);
    const cardForm = page
      .getByRole("heading", { name: "Novo cartão", exact: true })
      .locator("..")
      .locator("..");
    await cardForm.locator("select").nth(0).selectOption("ITAU");
    await cardForm.locator("select").nth(1).selectOption("Visa");
    await cardForm
      .getByPlaceholder("Ex: Itaú Click Visa")
      .fill("Maria CSV Mixed");
    await cardForm.getByPlaceholder("1234").fill("9922");
    await cardForm.getByPlaceholder("25", { exact: true }).fill("20");
    await cardForm.getByPlaceholder("10", { exact: true }).fill("28");
    const cardCreated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          `/projects/${pessoal[0]!.id}/credit-cards`,
    );
    await cardForm.getByRole("button", { name: "Salvar" }).click();
    const cardResponse = await cardCreated;
    expect(cardResponse.status()).toBe(201);
    const card = record(await cardResponse.json());
    if (typeof card.id !== "string") throw new Error("Card id is missing");

    const baseline = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    const mariaPath = `/projects/${pessoal[0].id}/maria`;
    await page.goto(mariaPath);
    await page
      .getByRole("combobox", { name: "Cartão da fatura" })
      .selectOption(card.id);
    await page.getByLabel("Anexar CSV da fatura").setInputFiles({
      name: "fatura-outubro-mista.csv",
      mimeType: "text/csv",
      buffer: CSV,
    });
    const mixedCreatedSession = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        url.pathname === "/import-sessions"
      );
    });
    await page
      .getByRole("button", { name: "Analisar e guardar rascunho" })
      .click();
    const mixedCreatedResponse = await mixedCreatedSession;
    expect(mixedCreatedResponse.status()).toBe(201);
    const mixedCreatedBody = record(await mixedCreatedResponse.json());
    if (typeof mixedCreatedBody.id !== "string")
      throw new Error("Mixed import session id is missing");
    const mixedSessionId = mixedCreatedBody.id;
    async function readMixedGuidedReview() {
      const response = await page.request.get(
        `${API}/import-sessions/${mixedSessionId}`,
      );
      expect(response.status()).toBe(200);
      const view = record(await response.json());
      expect(view.id).toBe(mixedSessionId);
      return { view, ...expectCanonicalGuidedReview(view.guidedReview) };
    }
    expect((await readMixedGuidedReview()).guidedReview).toEqual({
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: null,
    });

    const conversation = page.getByRole("region", {
      name: "Conversa da importação",
    });
    async function focusedTitle() {
      const text = await page
        .getByRole("region", { name: /^Compra \d+ de \d+$/ })
        .first()
        .innerText();
      if (text.includes("LOJA GEMEA")) return "LOJA GEMEA";
      if (text.includes("MATERIAL REFORMA")) return "MATERIAL REFORMA";
      if (text.includes("PAGAMENTO EFETUADO")) return "PAGAMENTO EFETUADO";
      throw new Error(`Unexpected mixed focused purchase: ${text}`);
    }
    const savedMixedDocumentQuestionIds = new Set<string>();
    const mixedInitialDocumentPaths: string[] = [];
    for (let index = 0; index < 21; index++) {
      const title = await focusedTitle();
      const saved = await answerDeterministicDocumentQuestion(
        page,
        conversation,
        mixedSessionId,
        title,
        savedMixedDocumentQuestionIds,
      );
      expect(saved.path).toMatch(/\/(?:declarations|resolutions)$/);
      mixedInitialDocumentPaths.push(
        saved.path.replace(/\/import-sessions\/[^/]+/, ""),
      );
    }
    expect(savedMixedDocumentQuestionIds.size).toBe(21);
    expect(mixedInitialDocumentPaths).toEqual([
      ...Array.from({ length: 12 }, () => "/resolutions"),
      ...Array.from({ length: 9 }, () => "/declarations"),
    ]);
    const prepareQuestions = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await page
      .getByRole("button", { name: "Continuar respondendo", exact: true })
      .click();
    const firstMixedPreparationResponse = await prepareQuestions;
    expect(firstMixedPreparationResponse.status()).toBe(200);
    const firstMixedPreparation = record(
      await firstMixedPreparationResponse.json(),
    );
    const firstMixedPrepareRequest = record(
      firstMixedPreparationResponse.request().postDataJSON(),
    );
    expect(firstMixedPreparation).toEqual({
      version: 1,
      requestId: firstMixedPrepareRequest.requestId,
      operation: "PREPARE_CURRENT_LOT",
      outcome: "NEEDS_INPUT",
      revision: 26,
    });
    const mixedPreparationRevisions = [firstMixedPreparation.revision];

    const mixedSteps = [
      {
        title: "LOJA GEMEA",
        field: "decision",
        answer: {
          kind: "DECISION",
          value: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      },
      {
        title: "LOJA GEMEA",
        field: "targets",
        answer: { kind: "TARGETS", value: [] },
      },
      {
        title: "LOJA GEMEA",
        field: "tipoDespesa",
        answer: { kind: "EXPENSE_TYPE", value: "COMPRAS_VAREJO" },
      },
    ] as const;
    const guidedStart = mutations.length;
    const mixedTargetCardinalities: number[] = [];
    const mixedControlByField = {
      decision: "DECISION",
      targets: "TARGETS",
      tipoDespesa: "EXPENSE_TYPE",
    } as const;
    const mixedGuidedBodies: Wire[] = [];
    for (const [index, step] of mixedSteps.entries()) {
      const viewport = VIEWPORTS[index]!;
      await page.setViewportSize(viewport);
      const canonical = await readMixedGuidedReview();
      if (!canonical.focus)
        throw new Error(`Missing mixed guided focus at step ${index + 1}`);
      expect(canonical.focus).toMatchObject({
        control: mixedControlByField[step.field],
        context: { title: step.title },
        purchaseOrdinal: Math.floor(index / 3) + 1,
        purchaseTotal: 3,
        questionOrdinal: (index % 3) + 1,
        questionTotal: 3,
      });
      const option = matchingGuidedOptionLabel(canonical.focus, step.answer);
      if (step.answer.kind === "TARGETS")
        mixedTargetCardinalities.push(step.answer.value.length);
      await expect.poll(focusedTitle).toBe(step.title);
      const form = conversation.locator("form").first();
      const radio = form.getByRole("radio", {
        name: option,
        exact: true,
      });
      const select = form.getByRole("combobox");
      const control = (await radio.count()) === 1 ? radio : select;
      if (index === 0)
        await expect(
          control,
          `${step.field} initial server focus at ${viewport.width}px`,
        ).toBeFocused();
      await control.focus();
      await expect(
        control,
        `${step.field} focusability at ${viewport.width}px`,
      ).toBeFocused();
      await expectTarget(
        (await radio.count()) === 1 ? radio.locator("xpath=..") : select,
        `${step.field} structured control ${viewport.width}px`,
      );
      if ((await radio.count()) === 1) await radio.check();
      else await select.selectOption({ label: option });
      await form
        .getByRole("button", { name: "Conferir informação", exact: true })
        .click();
      const preview = page.getByRole("region", {
        name: "Confira antes de guardar",
      });
      await expect(preview).toContainText(option);
      await expect(preview).not.toContainText("2026-10-03,LOJA GEMEA,100.01");
      await expect(preview).not.toContainText(
        "2026-10-04,MATERIAL REFORMA,250.00",
      );
      const response = page.waitForResponse(
        (candidate) =>
          candidate.request().method() === "POST" &&
          /^\/import-sessions\/[^/]+\/resolutions$/.test(
            new URL(candidate.url()).pathname,
          ),
      );
      await preview
        .getByRole("button", { name: "Guardar e continuar", exact: true })
        .click();
      const savedResponse = await response;
      expect(savedResponse.status()).toBe(200);
      const saved = record(await savedResponse.json());
      const body = record(savedResponse.request().postDataJSON());
      mixedGuidedBodies.push(body);
      expect(body).toEqual({
        version: 1,
        requestId: expect.any(String),
        expectedRevision: 26 + index + Math.floor(index / 3),
        questionId: expect.any(String),
        answer: step.answer,
      });
      expect(saved.revision).toBe(27 + index + Math.floor(index / 3));
    }
    expect(mixedTargetCardinalities).toEqual([0]);
    expect(
      mutations
        .slice(guidedStart)
        .filter((key) => key.endsWith("/resolutions")),
    ).toHaveLength(3);
    expect(
      mixedGuidedBodies
        .filter((body) => record(body.answer).kind === "DECISION")
        .map((body) => ({
          expectedRevision: body.expectedRevision,
          value: record(body.answer).value,
        })),
    ).toEqual([
      {
        expectedRevision: 26,
        value: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    ]);

    const firstReadyCandidate = await readMixedGuidedReview();
    expect(firstReadyCandidate.view).toMatchObject({
      state: "DRAFT",
      revision: 29,
      searchComplete: false,
      proposal: null,
      confirmation: null,
    });
    expect(firstReadyCandidate.guidedReview).toEqual({
      progress: "ANSWERING",
      actions: ["CONTINUE_ANSWERING"],
      focus: null,
    });

    const beforeConfirm = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    for (const key of [
      "expenses",
      "receipts",
      "cashFlowEntries",
      "allocations",
      "settlements",
      "funding",
      "merchantRules",
    ])
      expect(
        beforeConfirm[key],
        `first-ready ${key} before confirmation`,
      ).toEqual(baseline[key]);

    const prepareReady = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        /^\/import-sessions\/[^/]+\/current-lot\/prepare$/.test(
          new URL(response.url()).pathname,
        ),
    );
    await conversation
      .getByRole("button", {
        name: "Continuar respondendo",
        exact: true,
      })
      .click();
    const mixedReadyResponse = await prepareReady;
    expect(mixedReadyResponse.status()).toBe(200);
    const mixedReadyRequest = record(
      mixedReadyResponse.request().postDataJSON(),
    );
    expect(record(await mixedReadyResponse.json())).toEqual({
      version: 1,
      requestId: mixedReadyRequest.requestId,
      operation: "PREPARE_CURRENT_LOT",
      outcome: "CURRENT_LOT_READY",
      revision: 30,
    });
    mixedPreparationRevisions.push(30);
    expect(mixedPreparationRevisions).toEqual([26, 30]);

    const readyWithPending = await readMixedGuidedReview();
    expect(readyWithPending.view).toMatchObject({
      state: "READY",
      revision: 30,
      searchComplete: true,
      confirmation: null,
    });
    expect(readyWithPending.guidedReview).toEqual({
      progress: "READY_WITH_PENDING",
      actions: ["CONTINUE_ANSWERING", "REVIEW_READY"],
      focus: null,
    });
    const reviewReady = conversation.getByRole("button", {
      name: "Revisar as prontas agora",
      exact: true,
    });
    for (const viewport of VIEWPORTS) {
      await page.setViewportSize(viewport);
      await expectTarget(reviewReady, `first-ready review ${viewport.width}px`);
      await expectTarget(
        conversation.getByRole("button", {
          name: "Continuar respondendo",
          exact: true,
        }),
        `first-ready continue ${viewport.width}px`,
      );
    }

    const mutationsBeforeReview = mutations.length;
    const reviewResponsePromise = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.origin === API &&
          url.pathname === `/import-sessions/${mixedSessionId}/current-lot`
        );
      },
      { timeout: 15_000 },
    );
    await reviewReady.click();
    const reviewResponse = await reviewResponsePromise;
    expect(reviewResponse.status()).toBe(200);
    const reviewLot = record(await reviewResponse.json());
    expect(reviewLot).toMatchObject({
      state: "READY_WITH_PENDING",
      revision: 30,
      createdEconomicTotalCents: 10_001,
      bankCashDeltaCents: 0,
      hasRemainingWork: true,
    });
    expect(list(reviewLot.purchases)).toHaveLength(1);
    expect(JSON.stringify(reviewLot)).not.toMatch(
      /MATERIAL REFORMA|25000|PAGAMENTO EFETUADO/,
    );
    expect(mutations).toHaveLength(mutationsBeforeReview);
    const stableReview = await readMixedGuidedReview();
    expect(stableReview.view).toMatchObject({ state: "READY", revision: 30 });
    const afterReviewBeforeConfirm = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    for (const key of [
      "expenses",
      "receipts",
      "cashFlowEntries",
      "allocations",
      "settlements",
      "funding",
      "merchantRules",
    ])
      expect(
        afterReviewBeforeConfirm[key],
        `first-ready ${key} after GET review`,
      ).toEqual(baseline[key]);

    const review = conversation.getByRole("list", {
      name: "Compras prontas deste lote",
    });
    await expect(review.getByRole("listitem")).toHaveCount(1);
    await expect(review).toContainText("LOJA GEMEA");
    await expect(review).not.toContainText(
      /MATERIAL REFORMA|PAGAMENTO EFETUADO/,
    );
    const confirm = conversation.getByRole("button", {
      name: "Confirmar compras deste lote",
      exact: true,
    });
    await expectTarget(confirm, "confirm first ready purchase");
    const mixedConfirmedResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "POST" &&
        url.origin === API &&
        /^\/import-sessions\/[^/]+\/confirm$/.test(url.pathname)
      );
    });
    let releaseMixedExecute!: () => void;
    const mixedExecuteMayContinue = new Promise<void>((resolvePromise) => {
      releaseMixedExecute = resolvePromise;
    });
    await page.route(
      `${API}/import-sessions/${mixedSessionId}/execute`,
      async (route) => {
        await mixedExecuteMayContinue;
        await route.continue();
      },
    );
    await confirm.click();
    const mixedConfirmedResponse = await mixedConfirmedResponsePromise;
    expect(mixedConfirmedResponse.status()).toBe(200);
    const mixedConfirmed = record(await mixedConfirmedResponse.json());
    expect(mixedConfirmed).toMatchObject({
      sessionId: mixedSessionId,
      financialRequestId: expect.any(String),
      state: "CONFIRMED",
    });
    const mixedConfirmedRowResponse = await page.request.get(
      `${API}/import-sessions/${mixedSessionId}`,
    );
    expect(mixedConfirmedRowResponse.status()).toBe(200);
    expect(record(await mixedConfirmedRowResponse.json())).toMatchObject({
      state: "CONFIRMED",
      revision: 31,
      confirmation: {
        financialRequestId: mixedConfirmed.financialRequestId,
        confirmedRevision: 30,
      },
    });
    releaseMixedExecute();
    const applied = await ipc(child, "WAIT_APPLIED", { userId: me.id }, 20_000);
    const sessionId = String(applied.sessionId);
    expect(sessionId).toBe(mixedSessionId);
    expect(
      mutations.filter((key) => key.endsWith("/confirmation-challenge")),
    ).toHaveLength(1);
    expect(mutations.filter((key) => key.endsWith("/confirm"))).toHaveLength(1);
    expect(mutations.filter((key) => key.endsWith("/execute"))).toHaveLength(1);

    const resultResponse = await page.request.get(
      `${API}/import-sessions/${sessionId}/result`,
    );
    expect(resultResponse.status()).toBe(200);
    const result = record(await resultResponse.json());
    const receipt = record(result.receipt);
    expect(result.state).toBe("APPLIED");
    expect(receipt.confirmedRevision).toBe(30);
    expect(list(receipt.items)).toHaveLength(1);
    expect(list(receipt.items).map((item) => item.outcome)).toEqual([
      "CREATED",
    ]);
    expect(receipt.continuationSessionId).toEqual(expect.any(String));
    const mixedAppliedRowResponse = await page.request.get(
      `${API}/import-sessions/${sessionId}`,
    );
    expect(mixedAppliedRowResponse.status()).toBe(200);
    expect(record(await mixedAppliedRowResponse.json())).toMatchObject({
      state: "APPLIED",
      revision: 32,
      confirmation: {
        financialRequestId: mixedConfirmed.financialRequestId,
        confirmedRevision: 30,
      },
    });
    const after = record(
      (
        await ipc(child, "SNAPSHOT", {
          userId: me.id,
        })
      ).snapshot,
    );
    expect(list(after.expenses)).toHaveLength(1);
    expect(list(after.cashFlowEntries)).toHaveLength(1);
    expect(after.allocations).toEqual([]);
    expect(list(after.expenses).map((expense) => expense.valorTotal)).toEqual([
      10_001,
    ]);

    const continuationId = String(receipt.continuationSessionId);
    const continuationResponse = await page.request.get(
      `${API}/import-sessions/${continuationId}`,
    );
    expect(continuationResponse.status()).toBe(200);
    const continuation = record(await continuationResponse.json());
    expect(continuation).toMatchObject({
      id: continuationId,
      state: "DRAFT",
      revision: 1,
      confirmation: null,
      receipt: null,
    });
    const continuationLines = list(continuation.lines);
    expect(continuationLines).toHaveLength(2);
    expect(continuationLines.map((line) => line.titulo).sort()).toEqual([
      "LOJA GEMEA",
      "MATERIAL REFORMA",
    ]);
    expect(continuationLines.map((line) => record(line.decision).kind)).toEqual(
      ["UNRESOLVED", "UNRESOLVED"],
    );
    expect(JSON.stringify(continuation)).not.toContain("PAGAMENTO EFETUADO");
    expect(
      mutations
        .slice(guidedStart)
        .filter((key) => key.endsWith("/resolutions")),
    ).toHaveLength(3);
    expect(providerRequests).toEqual([]);
    expect(unexpectedHttp).toEqual([]);
    expect(authenticatedAuthMeObserved).toBe(true);
    expect(consumedBootstrapAuth401Responses).toBe(
      bootstrapAuth401ResponseCount,
    );
    expect(consoleErrors).toEqual([]);
  });

  test("real provider 503/502 matrix preserves structured fallback", async ({
    page,
  }, testInfo) => {
    await runRealJourney(page, testInfo, true);
  });

  test("real_signup_upload_review_confirm_response_loss_and_exact_replay", async ({
    page,
  }, testInfo) => {
    await runRealJourney(page, testInfo, false);
  });

  test("typed unavailable reasons preserve recovery and retry only runtime unavailability", async ({
    page,
  }) => {
    await page.setViewportSize(VIEWPORTS[1]);
    await page.clock.setFixedTime(new Date(INSTANT));
    await page.goto("/register");
    await page.getByLabel(/^seu nome$/i).fill("Maria CSV Unavailable QA");
    await page.getByLabel(/email/i).fill("maria-csv-unavailable@example.test");
    await page.getByLabel(/^senha$/i).fill("Local-only-qa-password-2026");
    await page
      .getByRole("checkbox", { name: /organizar minha vida financeira/i })
      .check();
    await page.getByRole("button", { name: /criar minha conta/i }).click();
    await expect(page).toHaveURL(/\/projects\/[^/]+\/conta$/);
    const onboarding = page.getByRole("dialog", {
      name: "Jornada: Onboarding — PESSOAL",
      exact: true,
    });
    await expect(onboarding).toBeVisible();
    await onboarding
      .getByRole("button", { name: "Fechar jornada", exact: true })
      .click();

    const projectsResponse = await page.request.get(`${API}/projects`);
    expect(projectsResponse.status()).toBe(200);
    const pessoal = list(await projectsResponse.json()).filter(
      (project) => project.type === "PESSOAL",
    );
    expect(pessoal).toHaveLength(1);
    if (typeof pessoal[0]?.id !== "string")
      throw new Error("Authenticated user has no typed PESSOAL project");
    const mariaPath = `/projects/${pessoal[0].id}/maria`;

    let reason: "NOT_ENABLED" | "RUNTIME_UNAVAILABLE" | "NO_QUALIFIED_FORMAT" =
      "NOT_ENABLED";
    let listReads = 0;
    const emittedEntries: Wire[] = [];
    await page.route(`${API}/import-sessions**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.method() !== "GET" || url.pathname !== "/import-sessions")
        return route.continue();
      listReads += 1;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      const payload = record(await response.json());
      const entry = { version: 1, kind: "UNAVAILABLE", reason };
      emittedEntries.push(entry);
      return route.fulfill({
        response,
        json: { ...payload, entry },
      });
    });

    for (const scenario of [
      { reason: "NOT_ENABLED", retry: false },
      { reason: "RUNTIME_UNAVAILABLE", retry: true },
      { reason: "NO_QUALIFIED_FORMAT", retry: false },
    ] as const) {
      reason = scenario.reason;
      const readsBeforeNavigation = listReads;
      await page.goto(mariaPath);
      await expect(page).toHaveURL(new RegExp(`${mariaPath}$`));
      await expect.poll(() => listReads).toBeGreaterThan(readsBeforeNavigation);

      const recovery = page.getByRole("button", {
        name: "Importações da Maria",
        exact: true,
      });
      await expect(recovery).toBeVisible();
      await expect(page.getByLabel("Anexar CSV da fatura")).toHaveCount(0);
      await recovery.click();
      const dialog = page.getByRole("dialog", {
        name: "Importações da Maria",
      });
      await expect(dialog).toBeVisible();
      const activeFilter = dialog.getByRole("button", {
        name: "Em andamento",
        exact: true,
      });
      const completedFilter = dialog.getByRole("button", {
        name: "Concluídas",
        exact: true,
      });
      await expect(activeFilter).toBeVisible();
      await expect(activeFilter).toHaveAccessibleName("Em andamento");
      await expect(activeFilter).toHaveAttribute("aria-pressed", "true");
      await expect(completedFilter).toBeVisible();
      await expect(completedFilter).toHaveAccessibleName("Concluídas");
      await expect(completedFilter).toHaveAttribute("aria-pressed", "false");
      await dialog.getByRole("button", { name: "Fechar" }).click();

      const retry = page.getByRole("button", {
        name: "Verificar novamente",
      });
      if (scenario.retry) {
        await expect(retry).toBeVisible();
        const beforeRetry = listReads;
        await retry.click();
        await expect.poll(() => listReads).toBeGreaterThan(beforeRetry);
      } else {
        await expect(retry).toHaveCount(0);
      }

      const visible = (await page.locator("body").innerText()).toLowerCase();
      for (const privateDetail of [
        "vault_dir",
        "import_vault_lock_fd",
        "/data/",
        "private-vault-",
        "stack trace",
        "sqlite",
      ])
        expect(visible).not.toContain(privateDetail);
    }

    expect(emittedEntries).toEqual(
      expect.arrayContaining([
        {
          version: 1,
          kind: "UNAVAILABLE",
          reason: "NOT_ENABLED",
        },
        {
          version: 1,
          kind: "UNAVAILABLE",
          reason: "RUNTIME_UNAVAILABLE",
        },
        {
          version: 1,
          kind: "UNAVAILABLE",
          reason: "NO_QUALIFIED_FORMAT",
        },
      ]),
    );
  });
});
