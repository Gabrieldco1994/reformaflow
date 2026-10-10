import { test, expect, type Page, type Locator } from "@playwright/test";
import type { ImportChatTurnV1 } from "@reformaflow/domain";
import {
  workflowFixture,
  workflowCatalog,
} from "../../src/app/projects/[projectId]/maria/_lib/import-workflow-fixtures";

async function reachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const bounds = await control.evaluate((element) => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(
      r.x + r.width / 2,
      r.y + r.height / 2,
    );
    return {
      width: r.width,
      height: r.height,
      hit: hit === element || (hit !== null && element.contains(hit)),
    };
  });
  expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  expect(bounds.hit).toBe(true);
}

async function setup(page: Page, baseURL: string | undefined) {
  if (!baseURL) throw new Error("Missing loopback Playwright baseURL");
  const harnessUrl = new URL(baseURL);
  expect({
    protocol: harnessUrl.protocol,
    hostname: harnessUrl.hostname,
    username: harnessUrl.username,
    password: harnessUrl.password,
  }).toEqual({
    protocol: "http:",
    hostname: "127.0.0.1",
    username: "",
    password: "",
  });
  expect(Number(harnessUrl.port)).toBeGreaterThan(0);
  await page.clock.setFixedTime(new Date("2026-10-08T01:00:00.000Z"));
  await page.addInitScript(() => {
    Object.defineProperty(window, "SpeechRecognition", {
      value: class {
        active = false;
        onstart: (() => void) | null = null;
        onend: (() => void) | null = null;
        onresult:
          | ((event: { results: { transcript: string }[][] }) => void)
          | null = null;
        constructor() {
          window.addEventListener("p08-transcript", (event) => {
            if (this.active && event instanceof CustomEvent) {
              this.active = false;
              this.onresult?.({
                results: [[{ transcript: String(event.detail) }]],
              });
              this.onend?.();
            }
          });
        }
        start() {
          this.active = true;
          this.onstart?.();
        }
        stop() {
          this.active = false;
          this.onend?.();
        }
        abort() {
          this.stop();
        }
      },
    });
    window.addEventListener("p08-tts", (event) => {
      if (event instanceof CustomEvent) {
        const output = document.createElement("output");
        output.dataset.speechEvidence = "true";
        output.hidden = true;
        output.textContent = String(event.detail);
        document.body.append(output);
      }
    });
  });
  let current = workflowFixture();
  current.proposal = null;
  current.state = "NEEDS_INPUT";
  current.actions = ["RESOLVE", "PREPARE", "CANCEL"];
  current.questions = [
    {
      id: "q",
      field: "amountCents",
      lineIds: ["first"],
      text: "Qual é o valor desta compra?",
    },
  ];
  current.attachments.push({
    id: "attachment-b",
    fileName: "outro.png",
    declaredBytes: 10,
    state: "ATTACHED",
    materializedInSession: true,
    canAnalyze: false,
  });
  current.lines.push({
    ...structuredClone(current.lines[0]),
    id: "other",
    observationIds: ["observation-other"],
  });
  const turns: ImportChatTurnV1[] = [];
  const requests: { method: string; path: string }[] = [];
  const errors: string[] = [];
  const unexpected: string[] = [];
  let malformed = false;
  let hold: Promise<void> | null = null;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.context().route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === harnessUrl.origin && request.method() === "GET") {
      await route.continue();
      return;
    }
    unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
    await route.abort("blockedbyclient");
  });
  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    requests.push({ method: request.method(), path });
    let body: unknown;
    if (path === "/projects") body = workflowCatalog.projects;
    else if (path === "/tenant/credit-cards") body = workflowCatalog.cards;
    else if (path === "/import-sessions/session-a") body = current;
    else if (path === "/agent/chat") {
      const payload = request.postDataJSON();
      expect(Object.keys(payload).sort()).toEqual(["importTurn", "messages"]);
      expect(request.headers()["x-rf-import-ui"]).toBe("1");
      const turn: ImportChatTurnV1 = payload.importTurn;
      expect(payload.messages).toEqual([
        { role: "user", content: turn.literalAnswer },
      ]);
      turns.push(turn);
      if (hold) await hold;
      const base = {
        version: 1,
        turnId: turn.turnId,
        ref: { sessionId: current.id, revision: current.revision },
        acknowledgment: "NONE",
      };
      if (malformed) body = { reply: "Já lancei tudo! Confirma?" };
      else if (turn.intent === "OPEN_REVIEW") {
        const revision = current.revision + 1;
        current = workflowFixture();
        current.revision = revision;
        if (!current.proposal) throw new Error("Missing synthetic proposal");
        current.proposal.revision = revision;
        body = {
          importOutcome: {
            ...base,
            ref: { sessionId: current.id, revision },
            acknowledgment: "PREPARED",
            kind: "OPEN_REVIEW",
          },
        };
      } else if (turn.intent === "APPROVE_ATTACHMENT_SCOPE") {
        expect(turn.scope.approvedLineIds).toEqual(["first", "twin"]);
        current.revision++;
        current.questions = [];
        body = {
          importOutcome: {
            ...base,
            ref: { sessionId: current.id, revision: current.revision },
            acknowledgment: "EDITED",
            kind: "REVISED_SESSION",
          },
        };
      } else if (turn.intent === "ANSWER" && turn.scope.kind === "ATTACHMENT") {
        body = {
          importOutcome: {
            ...base,
            kind: "CLARIFY",
            reason: "SCOPE_REVIEW",
            scopeReview: {
              focus: turn.focus,
              attachmentId: "attachment-a",
              lineIds: ["first", "twin"],
            },
          },
        };
      } else {
        body = {
          reply: "Já lancei tudo!",
          importOutcome: {
            ...base,
            kind: "CLARIFY",
            reason: "AMBIGUOUS",
            scopeReview: null,
          },
        };
      }
    } else {
      unexpected.push(`${request.method()} ${path}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.fulfill({ json: body });
  });
  return {
    turns,
    requests,
    errors,
    unexpected,
    malformed: (value: boolean) => {
      malformed = value;
    },
    hold: (value: Promise<void>) => {
      hold = value;
    },
  };
}

for (const viewport of [
  { width: 375, narrow: false },
  { width: 390, narrow: false },
  { width: 1280, narrow: false },
  { width: 1280, narrow: true },
]) {
  test(`conversation acknowledgment/scope/card ${viewport.width} narrow=${viewport.narrow}`, async ({
    page,
    baseURL,
  }, info) => {
    await page.setViewportSize({ width: viewport.width, height: 900 });
    const fixture = await setup(page, baseURL);
    await page.goto(`/?conversation=1${viewport.narrow ? "&narrow=1" : ""}`);
    const input = page.getByRole("textbox", {
      name: "Sua resposta sobre esta compra",
    });
    await expect(input).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(1);
    await reachable(input);
    await page.screenshot({
      path: info.outputPath("same-actor-before.png"),
      fullPage: true,
    });
    await input.fill("  sim  ");
    await input.press("Enter");
    await expect(
      page.getByText(
        "Preciso de uma resposta mais específica para esta pergunta.",
      ),
    ).toBeVisible();
    await expect(input).toHaveValue("  sim  ");
    await expect(input).toBeFocused();
    expect(fixture.turns[0]).toMatchObject({
      intent: "ANSWER",
      channel: "TEXT",
      literalAnswer: "  sim  ",
    });
    const mic = page.getByRole("button", {
      name: "Responder por voz",
      exact: true,
    });
    await reachable(mic);
    await mic.click();
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("p08-transcript", { detail: "sim" }),
      ),
    );
    await expect.poll(() => fixture.turns.length).toBe(2);
    expect(fixture.turns[1]).toMatchObject({
      intent: "ANSWER",
      channel: "VOICE",
      focus: { id: "q" },
      scope: { kind: "LINES", lineIds: ["first"] },
    });
    await expect(input).toHaveValue("sim");
    await expect(input).toBeEnabled();
    await page
      .getByRole("combobox", { name: "Alcance da resposta" })
      .selectOption("attachment-a");
    await input.fill("206,96");
    await input.press("Enter");
    const review = page.getByRole("region", {
      name: "Revisar alcance da resposta",
    });
    await expect(review).toBeVisible();
    await expect(review.getByText(/Compra first/)).toBeVisible();
    await expect(review.getByText(/Compra twin/)).toBeVisible();
    await expect(review.getByText(/Compra other/)).toHaveCount(0);
    const approve = review.getByRole("button", {
      name: "Aplicar resposta a estas compras",
    });
    await reachable(approve);
    await approve.click();
    await expect(input).toHaveCount(0);
    const open = page.getByRole("button", { name: "Abrir revisão do lote" });
    await reachable(open);
    await open.click();
    const confirm = page.getByRole("button", {
      name: "Confirmar lote",
      exact: true,
    });
    await expect(confirm).toBeEnabled();
    await reachable(confirm);
    const amount = page.getByText("R$ 1.999.999,98", { exact: true });
    await expect(amount).toBeVisible();
    expect(
      await amount.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set([...range.getClientRects()].map((r) => r.top)).size;
      }),
    ).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      fixture.requests.filter((r) => r.method === "POST").map((r) => r.path),
    ).toEqual(Array(5).fill("/agent/chat"));
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
    await page.screenshot({
      path: info.outputPath("same-actor-after.png"),
      fullPage: true,
    });
    await info.attach("offline-http", {
      body: JSON.stringify(fixture.requests),
      contentType: "application/json",
    });
  });
}

test("malformed success preserves keyboard/literal and recovery is GET-only", async ({
  page,
  baseURL,
}) => {
  await page.setViewportSize({ width: 375, height: 844 });
  const fixture = await setup(page, baseURL);
  fixture.malformed(true);
  await page.goto("/?conversation=1");
  const input = page.getByRole("textbox", {
    name: "Sua resposta sobre esta compra",
  });
  await input.fill("206,96");
  await input.press("Enter");
  await expect(page.getByRole("alert")).toContainText(
    "Resultado não confirmado",
  );
  await expect(input).toHaveValue("206,96");
  await expect(input).toBeFocused();
  const recover = page.getByRole("button", {
    name: "Consultar estado guardado",
  });
  await reachable(recover);
  await recover.click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fixture.turns).toHaveLength(1);
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("voice focused sim uses the same envelope and only safe speech", async ({
  page,
  baseURL,
}) => {
  const fixture = await setup(page, baseURL);
  await page.goto("/?conversation=1");
  await expect(page.getByRole("textbox")).toBeVisible();
  await page
    .getByRole("button", { name: "Iniciar conversa por voz", exact: true })
    .click();
  await expect(page.getByText("Ouvindo…", { exact: true })).toBeVisible();
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("p08-transcript", { detail: "sim" })),
  );
  await expect(page.locator("output[data-speech-evidence]")).toHaveCount(1);
  expect(fixture.turns[0]).toMatchObject({
    intent: "ANSWER",
    channel: "VOICE",
    literalAnswer: "sim",
    focus: { id: "q" },
  });
  await expect(page.locator("output[data-speech-evidence]")).toContainText(
    "Preciso de uma resposta",
  );
  await page.getByRole("button", { name: "Fechar conversa por voz" }).click();
  await expect(page.getByRole("textbox")).toHaveValue("sim");
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test("actor switch discards a delayed reply and private literal", async ({
  page,
  baseURL,
}) => {
  const fixture = await setup(page, baseURL);
  let release!: () => void;
  fixture.hold(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await page.goto("/?conversation=1");
  const input = page.getByRole("textbox");
  await input.fill("literal privado");
  await input.press("Enter");
  await expect.poll(() => fixture.turns.length).toBe(1);
  await page.evaluate(() => {
    document.documentElement.dataset.offlineActor = "offline-actor-b";
    window.dispatchEvent(new Event("p08-actor"));
  });
  release();
  await expect(page.getByRole("textbox")).toHaveValue("");
  await expect(page.getByText("literal privado", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator("output[data-speech-evidence]")).toHaveCount(0);
  expect(fixture.unexpected).toEqual([]);
});
