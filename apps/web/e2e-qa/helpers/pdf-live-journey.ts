import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  expect,
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

const apiURL = process.env.API_URL!;
const safePath = (url: string) => new URL(url).pathname;
const redact = (value: string) =>
  value
    .replace(/eyJ[\w.-]+/g, "[redacted-token]")
    .replace(/[\w.+-]+@[\w.-]+/g, "[redacted-email]");

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
      } else
        expect(response.ok(), `Real API ${name}: ${response.status()}`).toBe(
          true,
        );
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
  await page.getByRole("button", { name: /criar minha conta/i }).click();
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
  const projects =
    await get<{ id: string; name: string; type: string }[]>("/projects");
  const personal = projects.filter((project) => project.type === "PESSOAL");
  expect(personal).toHaveLength(1);
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
  expect(response.ok()).toBe(true);
  const card: { id: string } = await response.json();
  await navigation.mark("after-api-card-create");
  const close = page.getByRole("button", {
    name: "Fechar jornada",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  await navigation.mark("after-close-journey-check");
  await evidence.capture("real-signup-card");
  if (page.viewportSize()!.width < 768) {
    const maria = page.getByRole("link", { name: "Maria", exact: true });
    await expect(
      maria,
      "Maria navigation must be rendered after real signup",
    ).toBeVisible();
    await navigation.mark("before-visible-maria-click");
    await maria.click();
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
  // Last failed OCR scenarios stopped here, before any upload/analysis. Preserve
  // the actual entry layout and bound missing-CTA failure before auto-scroll.
  await evidence.capture("maria-before-entry-cta");
  const cta = page.getByRole("button", {
    name: invoiceImportCTA,
    exact: true,
  });
  await expect(cta).toHaveCount(1);
  await expect(cta).toBeVisible();
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
    get,
    expenses,
    noFinance,
    filePicker,
    view: (sessionId: string) =>
      get<ImportSessionViewV1>(`/import-sessions/${sessionId}`),
  };
}
