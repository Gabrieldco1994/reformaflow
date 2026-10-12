import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  expect,
  type APIResponse,
  type Page,
  type Response,
  type TestInfo,
} from "@playwright/test";
import type { ImportSessionViewV1 } from "@reformaflow/domain";
import { assertTouchable } from "./evidence";
import { traceSignupNavigation } from "./signup-navigation-trace";
import {
  assertSupportedImportEntry,
  invoiceImportCTA,
} from "./supported-import-entry";
import {
  gotoValidatedMariaHref,
  waitForMariaEntryButton,
} from "./maria-entry-navigation";

const apiURL = process.env.API_URL!;
const safePath = (url: string) => new URL(url).pathname;
const redact = (value: string) =>
  value
    .replace(/eyJ[\w.-]+/g, "[redacted-token]")
    .replace(/[\w.+-]+@[\w.-]+/g, "[redacted-email]");
type SignupProject = {
  id: string;
  name: string;
  type: string;
  rooms: Array<{ id: string; name: string }>;
};

export async function waitForMariaImportEntry(page: Page) {
  return waitForMariaEntryButton(page, invoiceImportCTA);
}

/** PDF-specific evidence: separate directories and one exact expected document failure,
 * unlike the existing CSV evidence collector (which rightly rejects every 422).
 */
export class PdfEvidence {
  readonly directory: string;
  private signedIn = false;
  private step = 0;
  private readonly errors: string[] = [];
  private readonly failures: {
    path: string;
    status: number;
    method: string;
  }[] = [];
  expectedDocumentFailure: { path: string; code: string } | null = null;
  signupNavigation: unknown[] = [];
  constructor(
    private readonly page: Page,
    info: TestInfo,
    scenario: string,
  ) {
    this.directory = path.resolve(
      process.env.QA_ARTIFACTS_DIR ?? "./qa-artifacts",
      info.project.name,
      `pdf-${scenario}`,
    );
    page.on("pageerror", (error) => this.errors.push(redact(error.message)));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const url = message.location().url;
      if (
        !this.signedIn &&
        /\/auth\/me(?:\?|$)/.test(url) &&
        /^Failed to load resource:.*401/.test(message.text())
      )
        return;
      if (
        this.expectedDocumentFailure &&
        url &&
        safePath(url) === this.expectedDocumentFailure.path &&
        /^Failed to load resource:.*422/.test(message.text())
      )
        return;
      this.errors.push(redact(message.text()));
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const pathname = safePath(response.url());
      if (
        !this.signedIn &&
        pathname === "/auth/me" &&
        response.status() === 401
      )
        return;
      this.failures.push({
        path: pathname,
        status: response.status(),
        method: response.request().method(),
      });
    });
  }
  authenticated() {
    this.signedIn = true;
  }
  async capture(name: string) {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(
      path.join(this.directory, `${this.step + 1}-${name}-page.json`),
      JSON.stringify({ url: this.page.url(), title: await this.page.title() }),
    );
    await this.page.screenshot({
      path: path.join(this.directory, `${++this.step}-${name}.png`),
      fullPage: true,
      caret: "initial",
    });
    const layout = await this.page.evaluate(() => ({
      viewport: innerWidth,
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
    }));
    expect(layout.width, `Overflow at ${name}`).toBeLessThanOrEqual(
      layout.viewport + 1,
    );
  }
  async response(
    name: string,
    matches: (response: Response) => boolean,
    action: () => Promise<void>,
    expectedCode?: string,
  ) {
    const started = Date.now();
    const pending = this.page.waitForResponse(matches, { timeout: 120_000 });
    const observed: {
      kind: string;
      path: string;
      status?: number;
      turn?: unknown;
    }[] = [];
    const onRequest = (request: import("@playwright/test").Request) => {
      if (
        request.method() !== "POST" ||
        safePath(request.url()) !== "/agent/chat"
      )
        return;
      observed.push({
        kind: "request",
        path: safePath(request.url()),
        turn: request.postDataJSON()?.importTurn,
      });
    };
    const onResponse = (response: Response) => {
      if (safePath(response.url()) === "/agent/chat")
        observed.push({
          kind: "response",
          path: safePath(response.url()),
          status: response.status(),
          turn: response.request().postDataJSON()?.importTurn,
        });
    };
    this.page.on("request", onRequest);
    this.page.on("response", onResponse);
    const artifact = path.join(
      this.directory,
      `${++this.step}-${name}-response.json`,
    );
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const [response] = await Promise.all([pending, action()]);
      const body = await response.text();
      const turn =
        response.request().method() === "POST" &&
        safePath(response.url()) === "/agent/chat"
          ? response.request().postDataJSON()?.importTurn
          : null;
      // No request cookies/headers/account payloads are captured.
      await fs.writeFile(
        artifact,
        redact(
          JSON.stringify(
            {
              transportBudgetMs: 120_000,
              elapsedMs: Date.now() - started,
              observed,
              path: safePath(response.url()),
              status: response.status(),
              body,
              importTurn: turn
                ? {
                    intent: turn.intent,
                    sessionId: turn.sessionId,
                    expectedRevision: turn.expectedRevision,
                    focus: turn.focus,
                    scope: turn.scope,
                    literalAnswer: turn.literalAnswer,
                  }
                : null,
              documentaryAnswer:
                response.request().method() === "POST" &&
                safePath(response.url()).endsWith("/documentary-answer")
                  ? response.request().postDataJSON()
                  : null,
              focusedDraftAnswer:
                response.request().method() === "PATCH" &&
                safePath(response.url()).endsWith("/draft")
                  ? response.request().postDataJSON()
                  : null,
            },
            null,
            2,
          ),
        ),
      );
      if (expectedCode) {
        expect(response.status()).toBe(422);
        expect(JSON.parse(body)).toMatchObject({
          code: expectedCode,
          retryable: false,
        });
      } else {
        const throttle =
          response.status() === 429
            ? " Journey QA hit the intentional 10-attempt loopback throttle; start a fresh isolated API process before rerunning this journey."
            : "";
        expect(
          response.ok(),
          `Real API ${name}: ${response.status()}.${throttle} Response: ${redact(body)}`,
        ).toBe(true);
      }
      return response;
    } catch (error) {
      await fs.writeFile(
        `${artifact}.failure.json`,
        redact(
          JSON.stringify({
            transportBudgetMs: 120_000,
            elapsedMs: Date.now() - started,
            failure: error instanceof Error ? error.message : String(error),
          }),
        ),
      );
      throw error;
    } finally {
      this.page.off("request", onRequest);
      this.page.off("response", onResponse);
    }
  }
  async setupResponse<T>(
    name: string,
    response: APIResponse | Response,
    method: "GET" | "POST",
  ): Promise<T> {
    const body = await response.text();
    const artifact = path.join(
      this.directory,
      `${++this.step}-setup-${name}.json`,
    );
    await fs.mkdir(this.directory, { recursive: true });
    // Persist diagnostics before any success assertion. Registration bodies
    // may include JWT/email fields, so use the same evidence redaction policy.
    await fs.writeFile(
      artifact,
      redact(
        JSON.stringify(
          {
            path: safePath(response.url()),
            method,
            status: response.status(),
            body,
          },
          null,
          2,
        ),
      ),
    );
    const throttle =
      response.status() === 429
        ? " Journey QA hit the intentional 10-attempt loopback throttle; start a fresh isolated API process before rerunning this journey."
        : "";
    expect(
      response.ok(),
      `PDF setup ${name} failed: ${response.status()} ${safePath(response.url())}.${throttle} Response: ${redact(body)}`,
    ).toBe(true);
    return JSON.parse(body) as T;
  }
  async finalize(primary: unknown) {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(
      path.join(this.directory, "runtime.json"),
      redact(
        JSON.stringify(
          {
            errors: this.errors,
            httpFailures: this.failures,
            expectedDocumentFailure: this.expectedDocumentFailure,
            signupNavigation: this.signupNavigation,
            primaryFailure:
              primary instanceof Error ? primary.message : (primary ?? null),
          },
          null,
          2,
        ),
      ),
    );
    // Never replace the original error; runtime diagnostics still survive.
    if (primary) return;
    expect(this.errors, "Unexpected console/page errors").toEqual([]);
    expect(this.failures).toEqual(
      this.expectedDocumentFailure
        ? [
            {
              path: this.expectedDocumentFailure.path,
              status: 422,
              method: "POST",
            },
          ]
        : [],
    );
  }
}

export async function startPdfJourney(page: Page, evidence: PdfEvidence) {
  const navigation = await traceSignupNavigation(page);
  evidence.signupNavigation = navigation.events;
  await page.goto("/register");
  const name = page.getByLabel(/^seu nome$/i);
  await expect
    .poll(() =>
      name.evaluate((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactProps$")),
      ),
    )
    .toBe(true);
  await name.fill("QA Maria PDF");
  await page.getByLabel(/email/i).fill(`qa-pdf-${randomUUID()}@example.com`);
  await page.getByLabel(/^senha$/i).fill(`Qa-${randomUUID()}!`);
  await page
    .getByRole("checkbox", { name: /organizar minha vida financeira/i })
    .check();
  await page.getByRole("checkbox", { name: /^reformar/i }).check();
  await expect(
    page.getByRole("checkbox", { name: /organizar minha vida financeira/i }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /^reformar/i }),
  ).toBeChecked();
  const signupSetupResponses: Response[] = [];
  const collectSignupSetup = (response: Response) => {
    const pathname = safePath(response.url());
    if (
      response.request().method() === "POST" &&
      (pathname === "/auth/register" || pathname === "/projects")
    )
      signupSetupResponses.push(response);
  };
  page.on("response", collectSignupSetup);
  await page.getByRole("button", { name: /criar minha conta/i }).click();
  await expect
    .poll(
      () =>
        signupSetupResponses.filter(
          (response) => safePath(response.url()) === "/auth/register",
        ).length,
      { message: "Exactly one account registration belongs to this journey" },
    )
    .toBe(1);
  await evidence.setupResponse(
    "account",
    signupSetupResponses.find(
      (response) => safePath(response.url()) === "/auth/register",
    )!,
    "POST",
  );
  const createdProjects: SignupProject[] = [];
  for (let index = 0; index < 2; index++) {
    await expect
      .poll(
        () =>
          signupSetupResponses.filter(
            (response) => safePath(response.url()) === "/projects",
          ).length,
        {
          message: `Signup must issue project setup request ${index + 1} of 2`,
        },
      )
      .toBeGreaterThanOrEqual(index + 1);
    const response = signupSetupResponses.filter(
      (candidate) => safePath(candidate.url()) === "/projects",
    )[index];
    createdProjects.push(
      await evidence.setupResponse<SignupProject>(
        `signup-project-${index + 1}`,
        response,
        "POST",
      ),
    );
  }
  page.off("response", collectSignupSetup);
  expect(
    signupSetupResponses.filter(
      (response) => safePath(response.url()) === "/auth/register",
    ),
  ).toHaveLength(1);
  expect(
    signupSetupResponses.filter(
      (response) => safePath(response.url()) === "/projects",
    ),
  ).toHaveLength(2);
  expect(createdProjects.map((project) => project.type).sort()).toEqual([
    "PESSOAL",
    "REFORMA",
  ]);
  await expect(page).toHaveURL(/\/projects\/[^/]+\/conta(?:\?|$)/);
  await navigation.mark("signup-first-conta-url");
  const token = (await page.context().cookies()).find(
    (cookie) => cookie.name === "rf_token",
  )?.value;
  expect(token).toBeTruthy();
  evidence.authenticated();
  const headers = { Authorization: `Bearer ${token}`, "x-rf-import-ui": "1" };
  const get = async <T>(resource: string): Promise<T> => {
    const response = await page.request.get(`${apiURL}${resource}`, {
      headers,
    });
    expect(response.ok(), `Real GET ${resource}: ${response.status()}`).toBe(
      true,
    );
    return response.json();
  };
  const meResponse = await page.request.get(`${apiURL}/auth/me`, { headers });
  const me = await evidence.setupResponse<{
    allowedProjectTypes: string[];
  }>("auth-grants", meResponse, "GET");
  expect([...me.allowedProjectTypes].sort()).toEqual(["PESSOAL", "REFORMA"]);
  const projectsResponse = await page.request.get(`${apiURL}/projects`, {
    headers,
  });
  const projects = await evidence.setupResponse<
    { id: string; name: string; type: string }[]
  >("projects", projectsResponse, "GET");
  expect(projects.map((project) => project.type).sort()).toEqual([
    "PESSOAL",
    "REFORMA",
  ]);
  expect(projects.map((project) => project.id).sort()).toEqual(
    createdProjects.map((project) => project.id).sort(),
  );
  const personal = projects.filter((project) => project.type === "PESSOAL");
  expect(personal).toHaveLength(1);
  const reformas = createdProjects.filter(
    (project) => project.type === "REFORMA",
  );
  expect(reformas).toHaveLength(1);
  const reforma = reformas[0];
  expect(reforma.rooms.length).toBeGreaterThan(0);
  const projectId = personal[0].id;
  await navigation.mark("before-api-card-create");
  const response = await page.request.post(
    `${apiURL}/projects/${projectId}/credit-cards`,
    {
      headers,
      data: {
        institution: "NUBANK",
        brand: "Mastercard",
        nickname: "QA PDF",
        last4: "4242",
        closingDay: 5,
        dueDay: 10,
        limitTotalCents: 3000000,
      },
    },
  );
  const card = await evidence.setupResponse<{ id: string }>(
    "credit-card",
    response,
    "POST",
  );
  await navigation.mark("after-api-card-create");
  const close = page.getByRole("button", {
    name: "Fechar jornada",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  await navigation.mark("after-close-journey-check");
  await evidence.capture("real-signup-card");
  const expectedMariaHref = `/projects/${projectId}/maria`;
  if (page.viewportSize()!.width < 768) {
    const maria = page.getByRole("link", { name: "Maria", exact: true });
    await expect(
      maria,
      "Maria navigation must be rendered after real signup",
    ).toBeVisible();
    await navigation.mark("before-visible-maria-click");
    await gotoValidatedMariaHref(page, maria, expectedMariaHref);
  } else {
    await page
      .getByRole("button", { name: "Abrir Copiloto Financeiro", exact: true })
      .click();
    // Actual widget label remains CSV; entry/local picker now advertise both formats.
    await page
      .getByRole("link", { name: "Importar fatura CSV com Maria", exact: true })
      .click();
  }
  await expect(page).toHaveURL(/\/maria(?:\?|$)/);
  const cta = await waitForMariaImportEntry(page);
  // Last failed OCR scenarios stopped here, before any upload/analysis. Preserve
  // the actual entry layout and bound missing-CTA failure before auto-scroll.
  await evidence.capture("maria-before-entry-cta");
  await assertTouchable(cta);
  const qualifiedEntry = await evidence.response(
    "entry",
    (r) =>
      safePath(r.url()) === "/agent/chat" && r.request().method() === "POST",
    () => cta.click(),
  );
  await assertSupportedImportEntry(page, qualifiedEntry, "PDF");
  const picker = page.getByRole("combobox", {
    name: "Cartão da fatura",
    exact: true,
  });
  await expect(picker).toHaveValue("");
  await expect(picker.locator(`option[value="${card.id}"]`)).toContainText(
    personal[0].name,
  );
  await picker.selectOption(card.id);
  const filePicker = page.getByLabel("Selecionar arquivos", { exact: true });
  const expenses = () =>
    get<{
      total: number;
      items: {
        id: string;
        titulo: string;
        valor: number;
        cardLast4: string | null;
      }[];
    }>(`/projects/${projectId}/expenses?pageSize=2000`);
  const noFinance = async () => {
    expect(await expenses()).toMatchObject({ total: 0, items: [] });
    expect(await get(`/projects/${projectId}/cash-flow`)).toEqual([]);
    expect(await get(`/projects/${projectId}/receipts`)).toEqual([]);
  };
  return {
    projectId,
    card,
    target: {
      projectId: reforma.id,
      projectName: reforma.name,
      roomId: reforma.rooms[0].id,
      roomName: reforma.rooms[0].name,
    },
    get,
    expenses,
    noFinance,
    filePicker,
    view: (sessionId: string) =>
      get<ImportSessionViewV1>(`/import-sessions/${sessionId}`),
  };
}
