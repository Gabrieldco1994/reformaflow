import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test, type Page } from "@playwright/test";
import {
  isPendingImportQuestion,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import { QA_VAULT_PURGE_WAIT_MS } from "../../../scripts/qa/maria-csv-vault-timing.mjs";
import {
  JourneyEvidence,
  assertReadableMoney,
  assertTouchable,
  assertUniqueButtonNames,
} from "./helpers/evidence";

import { csvFixtureAnswers, type CsvExpected } from "./helpers/fixture-answers";
import {
  fillFocusedDraftPreview,
  focusedDraftContract,
  isAgentChatPost,
  isFocusedDraftQuestion,
  nativeFocusedOnly,
  visibleCurrentQuestionForm,
} from "./helpers/focused-draft-answer";
import {
  captureNativeDocumentaryAnswer,
  nativeDocumentaryContract,
} from "./helpers/native-documentary-answer";
import {
  assertSupportedImportEntry,
  identicalImportNotice,
  invoiceImportCTA,
} from "./helpers/supported-import-entry";

const apiURL = process.env.API_URL!;
const fixtures = path.resolve(__dirname, "fixtures");
const execFileAsync = promisify(execFile);

async function installDeterministicWebSpeech(page: Page) {
  await page.addInitScript(() => {
    const transcripts: string[] = [];
    class DeterministicSpeechRecognition {
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
          const transcript = transcripts.shift();
          if (!transcript) {
            this.onerror?.({ error: "no-speech" });
            this.onend?.();
            return;
          }
          this.onresult?.({
            results: {
              0: { 0: { transcript }, length: 1 },
              length: 1,
            },
          });
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
      value: DeterministicSpeechRecognition,
    });
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      value: DeterministicSpeechRecognition,
    });
    Object.defineProperty(window, "__qaSpeechTranscript", {
      configurable: false,
      value: (transcript: string) => transcripts.push(transcript),
    });
  });
}

async function enqueueSpeech(page: Page, transcript: string) {
  await page.evaluate((value) => {
    (
      window as unknown as Window & {
        __qaSpeechTranscript: (transcript: string) => void;
      }
    ).__qaSpeechTranscript(value);
  }, transcript);
}

async function assertPrimaryVoiceCtaBeforeScroll(
  page: Page,
  evidence: JourneyEvidence,
) {
  const cta = page.getByRole("button", {
    name: "Iniciar conversa por voz",
    exact: true,
  });
  await expect(cta).toBeVisible();
  await expect(cta).toBeEnabled();
  const measurement = await cta.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const hit = document.elementFromPoint(center.x, center.y);
    return {
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      testPoint: center,
      elementFromPoint: {
        tagName: hit?.tagName ?? null,
        id: hit?.id || null,
        role: hit?.getAttribute("role") ?? null,
        ariaLabel: hit?.getAttribute("aria-label") ?? null,
        testId: hit?.getAttribute("data-testid") ?? null,
        hitsTarget: Boolean(hit && (hit === element || element.contains(hit))),
      },
      viewport: { width: innerWidth, height: innerHeight },
      documentScroll: { x: scrollX, y: scrollY },
    };
  });
  expect(measurement.documentScroll).toEqual({ x: 0, y: 0 });
  expect(measurement.rect.width).toBeGreaterThanOrEqual(44);
  expect(measurement.rect.height).toBeGreaterThanOrEqual(44);
  expect(measurement.rect.x).toBeGreaterThanOrEqual(0);
  expect(measurement.rect.y).toBeGreaterThanOrEqual(0);
  expect(measurement.rect.x + measurement.rect.width).toBeLessThanOrEqual(
    measurement.viewport.width,
  );
  expect(measurement.rect.y + measurement.rect.height).toBeLessThanOrEqual(
    measurement.viewport.height,
  );
  expect(measurement.elementFromPoint.hitsTarget).toBe(true);
  await evidence.recordTouchTarget(measurement);
  return cta;
}

async function assertDisposableInventory(
  sessionId: string,
  selectedLineIds: string[],
) {
  const db = process.env.QA_DB_PATH;
  expect(
    db,
    "Real Maria QA must run against disposable QA_DB_PATH",
  ).toBeTruthy();
  const script = path.resolve(
    __dirname,
    "../../../scripts/qa/maria-csv-assert.mjs",
  );
  await execFileAsync(process.execPath, [
    script,
    "post-confirm",
    "--db",
    db!,
    "--session",
    sessionId,
    "--selected-ids",
    selectedLineIds.join(","),
    "--purge-wait-ms",
    String(QA_VAULT_PURGE_WAIT_MS),
  ]);
}

async function dismissJourney(page: Page) {
  const close = page.getByRole("button", {
    name: "Fechar jornada",
    exact: true,
  });
  if (await close.isVisible()) await close.click();
}

async function openMaria(page: Page) {
  await dismissJourney(page);
  if (page.viewportSize()!.width < 768) {
    await page.getByRole("link", { name: "Maria", exact: true }).click();
  } else {
    await page
      .getByRole("button", { name: "Abrir Copiloto Financeiro", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Importar fatura CSV com Maria", exact: true })
      .click();
  }
  await expect(page).toHaveURL(/\/maria(?:\?|$)/);
}

for (const phase of ["upload", "confirmation"] as const) {
  test(
    phase === "upload"
      ? "real signup → visible Maria → CSV consent/dedupe/analysis → reload with no expenses"
      : "real VOICE-origin CSV → NO_TARGETS → lost answer/execute recovery → exact APPLIED inventory",
    async ({ page }, info) => {
      const evidence = new JourneyEvidence(page, info);
      const expectedViewportWidth = {
        "mobile-375": 375,
        "mobile-390": 390,
        "desktop-1280": 1280,
      }[info.project.name];
      expect(
        expectedViewportWidth,
        `Unexpected QA viewport project ${info.project.name}`,
      ).toBeTruthy();
      let primaryFailure: { error: unknown } | null = null;
      let token = "";
      let projectId = "";
      let sessionId = "";
      const headers = () => ({
        Authorization: `Bearer ${token}`,
        "x-rf-import-ui": "1",
      });
      const get = async (resource: string) => {
        const response = await page.request.get(
          `${apiURL.replace(/\/$/, "")}${resource}`,
          { headers: headers() },
        );
        await evidence.checkApi(response);
        return response.json();
      };
      const view = async (): Promise<ImportSessionViewV1> =>
        get(`/import-sessions/${sessionId}`);
      const expenses = async (): Promise<{
        total: number;
        items: {
          id: string;
          titulo: string;
          valor: number;
          cardLast4: string | null;
        }[];
      }> => get(`/projects/${projectId}/expenses?pageSize=2000`);
      const noExpenses = async () => {
        const result = await expenses();
        expect(
          result.total,
          "No financial writes before explicit confirmation",
        ).toBe(0);
        expect(result.items.map((item) => item.id)).toEqual([]);
      };

      try {
        await installDeterministicWebSpeech(page);
        const expected: CsvExpected = JSON.parse(
          await fs.readFile(path.join(fixtures, "expected.json"), "utf8"),
        );
        const answerFromFixture = csvFixtureAnswers(expected);
        const selectedPurchases = expected.purchases.slice(0, 2);
        expect(selectedPurchases).toHaveLength(2);
        const chosen = selectedPurchases.map((purchase) => purchase.title);
        const selectedTotal = selectedPurchases.reduce(
          (sum, purchase) => sum + purchase.amountCents,
          0,
        );
        expect(selectedTotal).toBe(19_134);
        const assertPurchaseProjection = (snapshot: ImportSessionViewV1) => {
          const titles = snapshot.lines.map((line) => line.titulo);
          for (const purchase of expected.purchases) {
            expect(
              titles.filter((title) => title === purchase.title),
              "Each purchase projected exactly once",
            ).toHaveLength(1);
          }
          expect(titles).not.toContain(expected.ignoredPaymentRow);
        };
        const first = await fs.readFile(
          path.join(fixtures, "card-invoice.csv"),
        );
        const copy = await fs.readFile(
          path.join(fixtures, "card-invoice-copy.csv"),
        );
        expect(
          first.equals(copy),
          "Renamed CSV must have identical bytes",
        ).toBe(true);
        expect(first.length).toBeGreaterThan(0);

        await page.goto("/register");
        await expect(page.getByLabel(/^seu nome$/i)).toBeVisible();
        // Screenshots temporarily style inputs (caret hiding); wait for React hydration first.
        await expect
          .poll(
            () =>
              page
                .getByLabel(/^seu nome$/i)
                .evaluate((element) =>
                  Object.keys(element).some((key) =>
                    key.startsWith("__reactProps$"),
                  ),
                ),
            {
              message:
                "Register inputs must be hydrated before screenshot instrumentation",
            },
          )
          .toBe(true);
        await evidence.capture("register");
        await page.getByLabel(/^seu nome$/i).fill("QA Maria CSV");
        await page
          .getByLabel(/email/i)
          .fill(`qa-maria-${randomUUID()}@example.com`);
        await page.getByLabel(/^senha$/i).fill(`Qa-${randomUUID()}!`);
        await page
          .getByRole("checkbox", { name: /organizar minha vida financeira/i })
          .check();
        const signupResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/auth/register" &&
            response.request().method() === "POST",
        );
        await page.getByRole("button", { name: /criar minha conta/i }).click();
        await evidence.checkApi(await signupResponse);
        await expect(page).toHaveURL(/\/projects\/[^/]+\/conta(?:\?|$)/);
        token =
          (await page.context().cookies()).find(
            (cookie) => cookie.name === "rf_token",
          )?.value ?? "";
        expect(
          token,
          "Real signup must issue an authenticated session cookie",
        ).not.toBe("");
        evidence.authenticated();
        const projects: { id: string; name: string; type: string }[] =
          await get("/projects");
        const personal = projects.filter(
          (project) => project.type === "PESSOAL",
        );
        expect(
          personal,
          "Signup must create exactly one PESSOAL project",
        ).toHaveLength(1);
        projectId = personal[0].id;
        expect(new URL(page.url()).pathname).toBe(
          `/projects/${projectId}/conta`,
        );
        await dismissJourney(page);
        await evidence.capture("signup-project-created");
        const cardResponse = await page.request.post(
          `${apiURL.replace(/\/$/, "")}/projects/${projectId}/credit-cards`,
          {
            headers: headers(),
            data: {
              institution: "NUBANK",
              brand: "Mastercard",
              nickname: "QA CSV Nebulosa",
              last4: "4242",
              closingDay: 5,
              dueDay: 10,
              limitTotalCents: 100000,
            },
          },
        );
        await evidence.checkApi(cardResponse);
        const card: { id: string } = await cardResponse.json();
        // Signup already entered this project; there is no project-hub tile to click.
        expect(new URL(page.url()).pathname).toBe(
          `/projects/${projectId}/conta`,
        );
        await dismissJourney(page);
        await evidence.capture("personal-project-card-created");

        await openMaria(page);
        const voiceCta = await assertPrimaryVoiceCtaBeforeScroll(
          page,
          evidence,
        );
        const cta = page.getByRole("button", {
          name: invoiceImportCTA,
          exact: true,
        });
        await expect(cta).toHaveCount(1);
        await assertUniqueButtonNames(page);
        await evidence.capture("maria-visible-primary-voice-cta");
        const entryResponse = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === "/agent/chat" &&
            response.request().method() === "POST",
          { timeout: 120_000 },
        );
        evidence.expectHttpFailureConsoleError({
          phase: `${phase}-voice-entry`,
          status: 503,
          method: "POST",
          url: `${apiURL.replace(/\/$/, "")}/tts/stream`,
          reason:
            "Private-vault QA intentionally runs without VibeVoice; the textual response remains available.",
        });
        await enqueueSpeech(page, "Quero importar a fatura do cartão");
        await voiceCta.click();
        const qualifiedEntry = await entryResponse;
        await evidence.checkApi(qualifiedEntry);
        expect(qualifiedEntry.request().postDataJSON()).toEqual({
          projectId,
          metadata: { channel: "VOICE" },
          messages: [
            { role: "user", content: "Quero importar a fatura do cartão" },
          ],
        });
        await assertSupportedImportEntry(page, qualifiedEntry, "CSV");
        await evidence.capture("voice-csv-entry-response");
        const cardPicker = page.getByRole("combobox", {
          name: "Cartão da fatura",
          exact: true,
        });
        await expect(cardPicker).toBeEnabled();
        await expect(cardPicker).toHaveValue("");
        await expect(
          cardPicker.locator(`option[value="${card.id}"]`),
        ).toContainText(personal[0].name);
        await cardPicker.selectOption(card.id);
        await expect(cardPicker).toHaveValue(card.id);
        await evidence.capture("explicit-card-and-project");

        const picker = page.getByLabel("Selecionar arquivos", { exact: true });
        await picker.setInputFiles([
          path.join(fixtures, "card-invoice.csv"),
          path.join(fixtures, "card-invoice-copy.csv"),
        ]);
        const files = page.getByRole("list", {
          name: "Arquivos selecionados",
          exact: true,
        });
        await expect(files.getByRole("listitem")).toHaveCount(2);
        await expect(files).toContainText("card-invoice.csv");
        await expect(files).toContainText("card-invoice-copy.csv");
        expect(
          new URL(page.url()).searchParams.has("importSessionId"),
          "File selection stays local",
        ).toBe(false);
        await noExpenses();
        await evidence.capture("local-file-review-before-consent");
        const consent = page.getByRole("button", {
          name: "Analisar e guardar rascunho",
          exact: true,
        });
        await assertTouchable(consent, evidence);
        await consent.click();
        await expect(
          page.getByText(identicalImportNotice, { exact: true }),
        ).toBeVisible();
        sessionId =
          new URL(page.url()).searchParams.get("importSessionId") ?? "";
        expect(sessionId).not.toBe("");
        const activeAgentChatRequests: string[] = [];
        page.on("request", (request) => {
          if (isAgentChatPost(request))
            activeAgentChatRequests.push(new URL(request.url()).pathname);
        });
        await expect
          .poll(async () => {
            const titles = (await view()).lines.map((line) => line.titulo);
            return expected.purchases.every((purchase) =>
              titles.includes(purchase.title),
            );
          })
          .toBe(true);
        const uploaded = await view();
        assertPurchaseProjection(uploaded);
        expect(uploaded.ownerProjectId).toBe(projectId);
        expect(uploaded.cardId).toBe(card.id);
        expect(
          uploaded.attachments.filter(
            (attachment) => attachment.state === "ATTACHED",
          ),
        ).toHaveLength(1);
        await noExpenses();
        await evidence.capture("duplicate-acknowledged-analysis-succeeded");

        await page.reload();
        await expect(
          page.getByRole("region", {
            name: "Conversa da importação",
            exact: true,
          }),
        ).toBeVisible();
        expect(new URL(page.url()).searchParams.get("importSessionId")).toBe(
          sessionId,
        );
        await expect(picker).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: "Analisar e guardar rascunho",
            exact: true,
          }),
        ).toHaveCount(0);
        assertPurchaseProjection(await view());
        await noExpenses();
        await evidence.capture("reload-resumes-uploaded-draft");

        const payment = page.getByRole("group", {
          name: /^Linha ignorada: .*Pagamento de fatura/i,
        });
        await expect(payment).toBeVisible();
        await expect(payment.getByRole("checkbox")).toHaveCount(0);
        await expect(
          payment.getByRole("button", { name: /Incluir|Retirar|Confirmar/ }),
        ).toHaveCount(0);
        await payment
          .getByRole("button", { name: "Ver motivo", exact: true })
          .click();
        await expect(payment).toContainText(
          "Pagamento de fatura de cartão não é uma compra e não será importado.",
        );
        const draft = await view();
        assertPurchaseProjection(draft);
        await noExpenses();
        await evidence.capture("ignored-payment-no-financial-effects");
        if (phase === "upload") return;
        const selectedIds = draft.lines
          .filter((line) => chosen.includes(line.titulo ?? ""))
          .map((line) => line.id);
        expect(selectedIds).toHaveLength(2);
        for (const line of draft.lines) {
          const row = page
            .locator(`[data-review-blocker-line="${line.id}"]`)
            .first();
          await expect(row).toBeVisible();
          const wasSelected = (await view()).selectedLineIds.includes(line.id);
          if (selectedIds.includes(line.id) && !wasSelected) {
            await row
              .getByRole("button", {
                name: `Incluir compra ${line.id} na revisão`,
                exact: true,
              })
              .click();
          } else if (!selectedIds.includes(line.id) && wasSelected) {
            await row
              .getByRole("button", {
                name: `Retirar compra ${line.id} da seleção`,
                exact: true,
              })
              .click();
          }
          await expect
            .poll(async () => (await view()).selectedLineIds.includes(line.id))
            .toBe(selectedIds.includes(line.id));
        }
        await noExpenses();
        await evidence.capture("ignored-payment-and-human-subset");

        let voiceReviewTransition = false;
        let lostAnswerRecovered = false;
        let cleanCreateChosen = false;
        // Read-only state identifies the active field; every answer is sent by the actual guided UI.
        for (let attempt = 0; attempt < 30; attempt++) {
          let current = await view();
          let question = current.questions.find(
            (q) =>
              isPendingImportQuestion(q) &&
              q.lineIds.some((id) => selectedIds.includes(id)),
          );
          if (!question) {
            // PREPARE may add decision/targets questions; an empty pre-prepare
            // question list is not proof that the financial review is ready.
            let prepareRequests = 0;
            const countPrepare = (
              request: import("@playwright/test").Request,
            ) => {
              if (
                request.method() === "POST" &&
                new URL(request.url()).pathname ===
                  `/import-sessions/${sessionId}/prepare`
              )
                prepareRequests++;
            };
            page.on("request", countPrepare);
            const prepared = page.waitForResponse(
              (response) =>
                new URL(response.url()).pathname ===
                  `/import-sessions/${sessionId}/prepare` &&
                response.request().method() === "POST",
              { timeout: 120_000 },
            );
            let response;
            if (!voiceReviewTransition) {
              await enqueueSpeech(page, "sim");
              await page
                .getByRole("button", {
                  name: "Responder por voz",
                  exact: true,
                })
                .click();
              await expect
                .poll(() => prepareRequests, {
                  message: "VOICE recognition must preview, never auto-submit",
                })
                .toBe(0);
              await expect(
                page.getByRole("button", {
                  name: "Abrir revisão do lote",
                  exact: true,
                }),
              ).toBeFocused();
              [response] = await Promise.all([
                prepared,
                page
                  .getByRole("button", {
                    name: "Abrir revisão do lote",
                    exact: true,
                  })
                  .click(),
              ]);
              voiceReviewTransition = true;
            } else {
              [response] = await Promise.all([
                prepared,
                page
                  .getByRole("button", {
                    name: "Abrir revisão do lote",
                    exact: true,
                  })
                  .click(),
              ]);
            }
            page.off("request", countPrepare);
            await evidence.checkApi(response);
            await evidence.capture(`prepare-${attempt + 1}-response`);
            current = await view();
            question = current.questions.find(
              (q) =>
                isPendingImportQuestion(q) &&
                q.lineIds.some((id) => selectedIds.includes(id)),
            );
            if (!question) break;
          }
          const form = await visibleCurrentQuestionForm(page, question);
          const answer = answerFromFixture(question, current, selectedIds);
          if (isFocusedDraftQuestion(question)) {
            await nativeFocusedOnly(form, async () => {
              if (question.field === "decision") {
                for (const lineId of question.lineIds) {
                  const catalog = (await get(
                    `/import-sessions/${sessionId}/candidates?lineId=${lineId}`,
                  )) as { items: unknown[] };
                  expect(
                    catalog.items,
                    `Decision candidate catalog for ${lineId} must be empty`,
                  ).toEqual([]);
                }
              }
              const typed = await fillFocusedDraftPreview(
                form,
                question,
                expected.declarations.firstDueDate,
                current,
              );
              if (typed.field === "decision") {
                expect(typed.value).toEqual({
                  kind: "CREATE",
                  acceptNaturalDuplicate: false,
                });
                cleanCreateChosen = true;
              }
              await evidence.capture(
                `answer-${attempt + 1}-${question.field}-typed-preview`,
              );
              const contract = focusedDraftContract(
                sessionId,
                question,
                current,
                typed,
              );
              if (!lostAnswerRecovered) {
                let requests = 0;
                let committed = false;
                const draftUrl = `${apiURL.replace(/\/$/, "")}/import-sessions/${sessionId}/draft`;
                const expectedDraftAbort =
                  evidence.expectRequestAbortConsoleFailure({
                    phase: `${phase}-lost-answer`,
                    method: "PATCH",
                    url: draftUrl,
                  });
                await page.route(
                  (url) =>
                    url.pathname === `/import-sessions/${sessionId}/draft`,
                  async (route) => {
                    requests++;
                    const abortScope = {
                      phase: `${phase}-lost-answer`,
                      method: route.request().method(),
                      url: route.request().url(),
                    };
                    const response = await route.fetch();
                    expect(response.status()).toBe(200);
                    committed = true;
                    await route.abort("failed");
                    expectedDraftAbort.recordRouteAbort(abortScope);
                  },
                );
                const recovered = page.waitForResponse(
                  (response) =>
                    committed &&
                    response.request().method() === "GET" &&
                    new URL(response.url()).pathname ===
                      `/import-sessions/${sessionId}` &&
                    response.ok(),
                  { timeout: 120_000 },
                );
                await form
                  .getByRole("button", {
                    name: "Guardar informação",
                    exact: true,
                  })
                  .click();
                await recovered;
                await page.unroute(
                  (url) =>
                    url.pathname === `/import-sessions/${sessionId}/draft`,
                );
                expect(requests).toBe(1);
                const recoveredView = await view();
                expect(recoveredView.revision).toBe(current.revision + 1);
                expect(
                  recoveredView.questions.some(
                    (candidate) => candidate.id === question.id,
                  ),
                ).toBe(false);
                lostAnswerRecovered = true;
              } else {
                await captureNativeDocumentaryAnswer(
                  page,
                  info,
                  `answer-${attempt + 1}-${question.field}-focused-draft`,
                  contract,
                  () =>
                    form
                      .getByRole("button", {
                        name: "Guardar informação",
                        exact: true,
                      })
                      .click(),
                );
              }
              await noExpenses();
              await evidence.capture(
                `answer-${attempt + 1}-${question.field}-saved`,
              );
            });
            continue;
          }
          if (
            question.field === "amountMeaning" &&
            (await form
              .getByRole("radio", { name: "Total da compra", exact: true })
              .count())
          ) {
            await form
              .getByRole("radio", { name: "Total da compra", exact: true })
              .check();
          } else {
            const textMode = form.getByRole("button", {
              name: "Responder com texto",
              exact: true,
            });
            if (question.field === "dataCompra" && (await textMode.count()))
              await textMode.click();
            await form.locator("input:not([type=radio])").fill(answer);
          }
          await evidence.capture(
            `answer-${attempt + 1}-${question.field}-before-send`,
          );
          if ("subject" in question) {
            await form
              .getByRole("button", { name: "Conferir informação", exact: true })
              .click();
            await expect(
              form.getByLabel("Prévia da informação", { exact: true }),
            ).toBeVisible();
            await captureNativeDocumentaryAnswer(
              page,
              info,
              `answer-${attempt + 1}-${question.field}`,
              nativeDocumentaryContract(sessionId, question, current, answer),
              () =>
                form
                  .getByRole("button", {
                    name: "Guardar informação",
                    exact: true,
                  })
                  .click(),
            );
          } else {
            await evidence.submitAnswer(
              {
                attempt: attempt + 1,
                field: question.field,
                value: answer,
                sessionId,
                questionId: question.id,
                lineIds: question.lineIds,
                revisionBefore: current.revision,
              },
              () =>
                form
                  .getByRole("button", {
                    name: "Responder à pergunta",
                    exact: true,
                  })
                  .click(),
            );
          }
          await expect
            .poll(async () => (await view()).revision, {
              message: `Answer ${question.field} must persist`,
            })
            .toBeGreaterThan(current.revision);
          await noExpenses();
          await evidence.capture(
            `answer-${attempt + 1}-${question.field}-saved`,
          );
        }
        expect(
          (await view()).questions.filter(
            (q) =>
              isPendingImportQuestion(q) &&
              q.lineIds.some((id) => selectedIds.includes(id)),
          ),
        ).toEqual([]);
        expect(voiceReviewTransition).toBe(true);
        expect(lostAnswerRecovered).toBe(true);
        expect(cleanCreateChosen).toBe(true);
        const ready = await view();
        expect(ready.state).toBe("READY");
        expect(
          ready.proposal?.lines.every(
            (planned) =>
              planned.kind !== "CREATE" || planned.targets.length === 0,
          ),
          "CSV covers the explicit NO_TARGETS branch",
        ).toBe(true);
        expect(
          activeAgentChatRequests,
          "An active import session must use only direct session endpoints",
        ).toEqual([]);
        const review = page.getByRole("region", {
          name: "Revisão do lote",
          exact: true,
        });
        await expect(review).toBeVisible();
        const purchases = review.getByRole("list", {
          name: "Compras do lote",
          exact: true,
        });
        await expect(purchases.locator(":scope > li")).toHaveCount(2);
        for (const title of chosen)
          await expect(purchases).toContainText(title);
        await expect(purchases).not.toContainText("Pagamento de fatura");
        await test.step("money readability metric (non-blocking until test end)", async () => {
          await assertReadableMoney(review, true);
        });
        const confirm = review.getByRole("button", {
          name: "Confirmar lote",
          exact: true,
        });
        await assertTouchable(confirm, evidence);
        await noExpenses();
        await evidence.capture("review-exact-subset-no-financial-writes");
        let executeRequests = 0;
        let executeCommitted = false;
        const executeUrl = `${apiURL.replace(/\/$/, "")}/import-sessions/${sessionId}/execute`;
        const expectedExecuteAbort = evidence.expectRequestAbortConsoleFailure({
          phase,
          method: "POST",
          url: executeUrl,
        });
        await page.route(
          (url) => url.pathname === `/import-sessions/${sessionId}/execute`,
          async (route) => {
            executeRequests++;
            const abortScope = {
              phase,
              method: route.request().method(),
              url: route.request().url(),
            };
            const committed = await route.fetch();
            expect(
              committed.status(),
              "The server must commit execute before its browser response is lost",
            ).toBe(200);
            executeCommitted = true;
            await route.abort("failed");
            expectedExecuteAbort.recordRouteAbort(abortScope);
          },
        );
        const recoveredRead = page.waitForResponse(
          (response) =>
            executeCommitted &&
            response.request().method() === "GET" &&
            new URL(response.url()).pathname ===
              `/import-sessions/${sessionId}` &&
            response.ok(),
          { timeout: 120_000 },
        );
        await confirm.click();
        await recoveredRead;
        const receipt = page.getByTestId("import-receipt");
        await expect(receipt).toBeVisible();
        const storedStateNotice = review.getByRole("status").filter({
          hasText:
            "A resposta da ação não pôde ser confirmada. O estado guardado foi consultado; confira-o antes de continuar.",
        });
        await expect(storedStateNotice).toBeVisible();
        await expect(storedStateNotice).toHaveText(
          "A resposta da ação não pôde ser confirmada. O estado guardado foi consultado; confira-o antes de continuar.",
        );
        await expect(
          review.getByText(/^Resultado guardado · Revisão \d+$/),
        ).toBeVisible();
        await expect(
          review.getByRole("button", {
            name: /Confirmar lote|Aplicar lote confirmado/,
          }),
        ).toHaveCount(0);
        await expect(
          review.getByRole("heading", {
            name: "Revisão do lote",
            exact: true,
          }),
        ).toBeFocused();
        await assertUniqueButtonNames(page);
        await evidence.assertAndRecordViewport(
          "applied-after-lost-execute-recovery",
          expectedViewportWidth!,
        );
        await expect(
          receipt.getByRole("heading", {
            name: "Comprovante da importação",
            exact: true,
          }),
        ).toBeVisible();
        await expect.poll(async () => (await expenses()).total).toBe(2);
        const applied = await expenses();
        expect(applied.items.map((item) => item.titulo).sort()).toEqual(
          [...chosen].sort(),
        );
        expect(new Set(applied.items.map((item) => item.id)).size).toBe(2);
        expect(applied.items.every((item) => item.cardLast4 === "4242")).toBe(
          true,
        );
        expect(applied.items.reduce((sum, item) => sum + item.valor, 0)).toBe(
          selectedTotal,
        );
        const terminal = await view();
        expect(terminal.cardId).toBe(card.id);
        expect(terminal.state).toBe("APPLIED");
        expect(terminal.receipt).toBeTruthy();
        expect(executeRequests).toBe(1);
        expect(
          terminal.receipt!.items.map((item) => item.sourceExpenseId).sort(),
        ).toEqual(applied.items.map((item) => item.id).sort());
        expect(terminal.receipt!.items).toHaveLength(2);
        expect(terminal.receipt!.snapshot.createdEconomicTotalCents).toBe(
          selectedTotal,
        );
        const auditedReceipt = terminal.receipt as typeof terminal.receipt & {
          auditItems: Array<{
            observationId: string;
            outcome: string;
            reason: string;
            title: string;
            amountCents: number | null;
          }>;
        };
        expect(auditedReceipt.auditItems).toEqual([
          {
            observationId: expect.any(String),
            outcome: "IGNORED",
            reason: "INVOICE_PAYMENT",
            title: expected.ignoredPaymentRow,
            amountCents: expected.ignoredPaymentAmountCents,
          },
        ]);
        const continuationSessionId = terminal.receipt!.continuationSessionId;
        expect(continuationSessionId).toEqual(expect.any(String));
        const continuation = (await get(
          `/import-sessions/${continuationSessionId}`,
        )) as ImportSessionViewV1;
        const remaining = expected.purchases.slice(2);
        expect(continuation.lines.map((line) => line.titulo)).toEqual(
          remaining.map((purchase) => purchase.title),
        );
        expect(continuation.lines.map((line) => line.amountCents)).toEqual(
          remaining.map((purchase) => purchase.amountCents),
        );
        expect(continuation.selectedLineIds).toEqual(
          continuation.lines.map((line) => line.id),
        );
        const continuationObservations = (await get(
          `/import-sessions/${continuationSessionId}/observations`,
        )) as {
          items: Array<{
            id: string;
            text: string;
            ignoredReason?: string | null;
          }>;
        };
        expect(continuationObservations.items).toHaveLength(3);
        expect(
          continuationObservations.items.every(
            (observation) =>
              !Object.hasOwn(observation, "ignoredReason") ||
              observation.ignoredReason === null,
          ),
        ).toBe(true);
        expect(
          continuationObservations.items.map((observation) => observation.id),
        ).not.toContain(auditedReceipt.auditItems[0].observationId);
        const continuationAction = receipt.getByRole("button", {
          name: "Ver rascunho restante",
          exact: true,
        });
        await expect(continuationAction).toBeVisible();
        await assertTouchable(continuationAction, evidence);
        await assertReadableMoney(receipt, true);
        await evidence.capture("confirmed-receipt-two-purchases");

        await page.reload();
        await expect(
          page.getByRole("region", {
            name: "Conversa da importação",
            exact: true,
          }),
        ).toBeVisible();
        // Terminal reads can require opening the saved result; this is not a new financial consent.
        if (!(await receipt.isVisible())) {
          await page
            .getByRole("button", { name: "Consultar comprovante", exact: true })
            .click();
        }
        await expect(receipt).toBeVisible();
        expect((await view()).state).toBe("APPLIED");
        expect((await view()).receipt).toEqual(terminal.receipt);
        expect(executeRequests).toBe(1);
        await expect(picker).toHaveCount(0);
        await expect(
          page.getByRole("button", {
            name: /Analisar documento|Analisar e guardar rascunho|Confirmar lote|Aplicar lote confirmado|Retomar envio/,
          }),
        ).toHaveCount(0);
        expect((await expenses()).items.map((item) => item.id).sort()).toEqual(
          applied.items.map((item) => item.id).sort(),
        );
        await assertDisposableInventory(sessionId, selectedIds);
        expect(executeRequests).toBe(1);
        await assertReadableMoney(receipt, true);
        await evidence.capture("terminal-receipt-persists-no-reupload");
        await continuationAction.click();
        await expect(page).toHaveURL(
          new RegExp(
            `/projects/${projectId}/maria\\?importSessionId=${continuationSessionId}$`,
          ),
        );
        const continuationConversation = page.getByRole("region", {
          name: "Conversa da importação",
          exact: true,
        });
        await expect(continuationConversation).toBeVisible();
        await expect(continuationConversation).toBeFocused();
        await expect
          .poll(async () => {
            const current = (await get(
              `/import-sessions/${continuationSessionId}`,
            )) as ImportSessionViewV1;
            return current.selectedLineIds;
          })
          .toEqual(continuation.lines.map((line) => line.id));
        expect(executeRequests).toBe(1);
        await evidence.capture("continuation-opens-selected-remaining-draft");
      } catch (error) {
        primaryFailure = { error };
        throw error;
      } finally {
        await evidence.finalize(primaryFailure);
      }
    },
  );
}
