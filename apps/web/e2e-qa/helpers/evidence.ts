import fs from "node:fs/promises";
import path from "node:path";
import {
  expect,
  type APIResponse,
  type Response,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";

export type AnswerMetadata = {
  attempt: number;
  field: string;
  value: string;
  sessionId: string;
  questionId: string;
  lineIds: string[];
  revisionBefore: number;
};

type HttpFailure = {
  status: number;
  method: string;
  url: string;
  expected: boolean;
  reason?: string;
};

function safeUrl(value: string) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
}
function redact(value: string) {
  return value
    .replace(/eyJ[\w.-]+/g, "[redacted-token]")
    .replace(/[\w.+-]+@[\w.-]+/g, "[redacted-email]");
}

function safeDiagnosticJson(value: unknown) {
  return redact(
    JSON.stringify(
      value,
      (key, member: unknown) =>
        /^(authorization|cookie|set-cookie|token|accessToken|refreshToken|password|apiKey|api_key|secret|credential)$/i.test(
          key,
        )
          ? "[redacted]"
          : member,
      2,
    ),
  );
}

export class JourneyEvidence {
  private readonly directory: string;
  private stepNumber = 0;
  private signedIn = false;
  private readonly consoleErrors: string[] = [];
  private readonly httpFailures: HttpFailure[] = [];
  private readonly answerArtifacts: string[] = [];
  private readonly failures: {
    phase: string;
    message: string;
    stack?: string;
  }[] = [];
  private readonly steps: {
    name: string;
    url: string;
    title: string;
    screenshot: string;
  }[] = [];

  constructor(
    private readonly page: Page,
    private readonly info: TestInfo,
  ) {
    this.directory = path.resolve(
      process.env.QA_ARTIFACTS_DIR ?? "./qa-artifacts",
      info.project.name,
      info.title.includes("explicit subset") ? "confirmation" : "upload",
    );
    page.on("console", (message) => {
      // Chromium also prints its generic network diagnostic for the expected anonymous /auth/me 401.
      if (message.type() !== "error") return;
      const location = message.location().url;
      if (
        !this.signedIn &&
        /\/auth\/me(?:\?|$)/.test(location) &&
        /^Failed to load resource:.*401/.test(message.text())
      )
        return;
      this.consoleErrors.push(redact(message.text()));
    });
    page.on("pageerror", (error) =>
      this.consoleErrors.push(redact(error.message)),
    );
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const expected =
        !this.signedIn &&
        response.status() === 401 &&
        new URL(response.url()).pathname.endsWith("/auth/me");
      this.httpFailures.push({
        status: response.status(),
        method: response.request().method(),
        url: safeUrl(response.url()),
        expected,
        ...(expected
          ? {
              reason:
                "Anonymous AuthProvider session check before real signup.",
            }
          : {}),
      });
    });
  }

  authenticated() {
    this.signedIn = true;
  }

  /** Only synthetic import turns/bodies; never serialize cookies or request headers. */
  async submitAnswer(metadata: AnswerMetadata, submit: () => Promise<void>) {
    const filename = `answer-${metadata.attempt}-${metadata.field}-response.json`;
    const artifact = path.join(this.directory, filename);
    const startedAt = new Date().toISOString();
    const started = Date.now();
    const diagnostic: Record<string, unknown> = {
      metadata,
      startedAt,
      transportBudgetMs: 120_000,
    };
    const save = async () => {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(artifact, safeDiagnosticJson(diagnostic));
    };
    this.answerArtifacts.push(artifact);
    await save();
    // Register BEFORE clicking, and bind the response to this synthetic ANSWER.
    const observed: unknown[] = [];
    const onRequest = (request: import("@playwright/test").Request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/agent/chat"
      )
        observed.push({
          kind: "request",
          importTurn: request.postDataJSON()?.importTurn,
        });
    };
    const onResponse = (response: Response) => {
      if (
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/agent/chat"
      )
        observed.push({
          kind: "response",
          status: response.status(),
          importTurn: response.request().postDataJSON()?.importTurn,
        });
    };
    diagnostic.observed = observed;
    this.page.on("request", onRequest);
    this.page.on("response", onResponse);
    const pending = this.page.waitForResponse(
      (response) => {
        if (
          response.request().method() !== "POST" ||
          new URL(response.url()).pathname !== "/agent/chat"
        )
          return false;
        const turn = response.request().postDataJSON()?.importTurn;
        return (
          turn?.intent === "ANSWER" &&
          turn.sessionId === metadata.sessionId &&
          turn.focus?.id === metadata.questionId &&
          turn.literalAnswer === metadata.value
        );
      },
      { timeout: 120_000 },
    );
    try {
      const [response] = await Promise.all([pending, submit()]);
      diagnostic.elapsedMs = Date.now() - started;
      diagnostic.status = response.status();
      diagnostic.url = safeUrl(response.url());
      const request = response.request().postDataJSON()?.importTurn;
      // Allowlisted body data only; no account identity, auth headers or cookies.
      diagnostic.request = request
        ? {
            version: request.version,
            intent: request.intent,
            sessionId: request.sessionId,
            expectedRevision: request.expectedRevision,
            turnId: request.turnId,
            channel: request.channel,
            focus: request.focus,
            scope: request.scope,
            literalAnswer: request.literalAnswer,
          }
        : null;
      const body = await response.text();
      try {
        diagnostic.bodyText = safeDiagnosticJson(JSON.parse(body));
        diagnostic.bodyJson = JSON.parse(diagnostic.bodyText as string);
      } catch {
        diagnostic.bodyText = redact(body);
        diagnostic.bodyJson = null;
      }
      await save();
      await this.persist();
      expect(
        response.ok(),
        `ANSWER ${metadata.field} HTTP ${response.status()}; evidence: ${artifact}`,
      ).toBe(true);
    } catch (error) {
      diagnostic.elapsedMs = Date.now() - started;
      diagnostic.failure =
        error instanceof Error ? error.message : String(error);
      await save();
      throw error;
    } finally {
      this.page.off("request", onRequest);
      this.page.off("response", onResponse);
    }
  }

  /** Cleanup evidence is secondary: never replace the original journey exception. */
  async finalize(primary: { error: unknown } | null) {
    const record = (phase: string, error: unknown) => {
      this.failures.push({
        phase,
        message: redact(error instanceof Error ? error.message : String(error)),
        ...(error instanceof Error && error.stack
          ? { stack: redact(error.stack) }
          : {}),
      });
    };
    if (primary) record("journey", primary.error);
    const secondary: unknown[] = [];
    try {
      if (!this.page.isClosed()) await this.capture("final-state");
    } catch (error) {
      record("final-capture", error);
      secondary.push(error);
    }
    try {
      this.assertClean();
    } catch (error) {
      record("runtime", error);
      secondary.push(error);
    }
    try {
      await this.persist();
    } catch (error) {
      record("persist", error);
      secondary.push(error);
    }
    if (secondary.length)
      this.info.annotations.push({
        type: "QA secondary failures",
        description: this.failures
          .filter((failure) => failure.phase !== "journey")
          .map((failure) => `${failure.phase}: ${failure.message}`)
          .join("\n"),
      });
    if (!primary && secondary.length)
      throw new AggregateError(
        secondary,
        "Journey evidence/runtime checks failed",
      );
  }

  async checkApi(response: APIResponse | Response) {
    if (!response.ok())
      this.httpFailures.push({
        status: response.status(),
        method: "API helper",
        url: safeUrl(response.url()),
        expected: false,
      });
    await this.persist();
    expect(
      response.ok(),
      `Live API failed: ${response.status()} ${safeUrl(response.url())}`,
    ).toBe(true);
  }

  async capture(name: string) {
    await fs.mkdir(this.directory, { recursive: true });
    const filename = `${String(++this.stepNumber).padStart(2, "0")}-${name}.png`;
    const screenshot = path.join(this.directory, filename);
    await this.page.screenshot({
      path: screenshot,
      fullPage: true,
      caret: "initial",
    });
    this.steps.push({
      name,
      url: this.page.url(),
      title: await this.page.title(),
      screenshot,
    });
    await this.persist();
    const layout = await this.page.evaluate(() => ({
      viewport: innerWidth,
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth,
      ),
    }));
    if (layout.viewport < 768)
      expect(
        layout.width,
        `Horizontal overflow at ${name}`,
      ).toBeLessThanOrEqual(layout.viewport + 1);
    this.assertClean();
  }

  async persist() {
    await fs.mkdir(this.directory, { recursive: true });
    await fs.writeFile(
      path.join(this.directory, "journey.json"),
      JSON.stringify(
        {
          steps: this.steps,
          consoleErrors: this.consoleErrors,
          httpFailures: this.httpFailures,
          answerArtifacts: this.answerArtifacts,
          failures: this.failures,
        },
        null,
        2,
      ),
    );
  }

  assertClean() {
    expect(
      this.consoleErrors,
      "Unexpected browser console/page errors",
    ).toEqual([]);
    expect(
      this.httpFailures.filter((f) => !f.expected),
      "Unexpected 4xx/5xx responses",
    ).toEqual([]);
  }
}

export async function assertTouchable(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator).toBeVisible();
  await expect(locator).toBeEnabled();
  const measurement = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rect.x + rect.width / 2,
      rect.y + rect.height / 2,
    );
    return {
      height: rect.height,
      width: rect.width,
      hit: hit === element || (hit !== null && element.contains(hit)),
    };
  });
  expect(
    measurement.height,
    "Primary CTA touch target height",
  ).toBeGreaterThanOrEqual(44);
  expect(measurement.width).toBeGreaterThan(0);
  expect(measurement.hit, "Primary CTA covered by another element").toBe(true);
}

export async function assertUniqueButtonNames(page: Page) {
  // Accessible names distinguish e.g. the two Remove-file buttons; text alone does not.
  const buttons = page.getByRole("button");
  const names: string[] = [];
  for (const button of await buttons.all()) {
    if (!(await button.isVisible())) continue;
    const name = await button.evaluate((element) => {
      const labelledBy = element.getAttribute("aria-labelledby");
      return (
        element.getAttribute("aria-label") ??
        (labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          : (element.textContent ?? ""))
      );
    });
    if (name.trim()) names.push(name.replace(/\s+/g, " ").trim());
  }
  expect(
    names.filter((name, index) => names.indexOf(name) !== index),
    "Duplicate visible CTA labels",
  ).toEqual([]);
}

export async function assertReadableMoney(scope: Locator, soft = false) {
  const check = soft ? expect.soft : expect;
  const money = scope.locator("[data-workflow-money], dd.whitespace-nowrap");
  check(
    await money.count(),
    "Review/receipt must show monetary amounts",
  ).toBeGreaterThan(0);
  for (const amount of await money.all()) {
    if (!(await amount.isVisible())) continue;
    const measurement = await amount.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const range = document.createRange();
      range.selectNodeContents(element);
      const textRect = range.getBoundingClientRect();
      let clipped = false;
      for (
        let parent = element.parentElement;
        parent;
        parent = parent.parentElement
      ) {
        const box = parent.getBoundingClientRect();
        const css = getComputedStyle(parent);
        if (
          /(hidden|clip|auto|scroll)/.test(css.overflowX) &&
          (textRect.left < box.left - 1 || textRect.right > box.right + 1)
        )
          clipped = true;
      }
      return {
        font: parseFloat(style.fontSize),
        nowrap: style.whiteSpace === "nowrap",
        width: rect.width,
        left: textRect.left,
        right: textRect.right,
        viewport: innerWidth,
        clipped,
      };
    });
    check(
      measurement.font,
      "Financial amount font size",
    ).toBeGreaterThanOrEqual(15);
    check(measurement.nowrap).toBe(true);
    check(measurement.width).toBeGreaterThan(0);
    check(measurement.left).toBeGreaterThanOrEqual(-1);
    check(measurement.right).toBeLessThanOrEqual(measurement.viewport + 1);
    check(measurement.clipped, "Money clipped by ancestor").toBe(false);
  }
}
