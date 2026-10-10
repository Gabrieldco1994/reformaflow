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
  const close = page.getByRole("button", {
    name: "Fechar jornada",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
  await evidence.capture("real-signup-card");
  if (page.viewportSize()!.width < 768) {
    await page.getByRole("link", { name: "Maria", exact: true }).click();
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
  const cta = page.getByRole("button", {
    name: invoiceImportCTA,
    exact: true,
  });
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
        creditCardId: string | null;
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
