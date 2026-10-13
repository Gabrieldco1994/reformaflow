import { expect, test, type Page } from "@playwright/test";
import type { ImportSessionViewV1 } from "@reformaflow/domain";

const PROJECT = "pdf-personal";
const CARD = "pdf-card";
const SESSION = "pdf-session";
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});
const emptyView = (): ImportSessionViewV1 => ({
  version: 1,
  id: SESSION,
  ownerProjectId: PROJECT,
  cardId: CARD,
  state: "DRAFT",
  revision: 1,
  expiresAt: "2026-10-17T16:00:00.000Z",
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
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function mockApi(
  page: Page,
  baseURL: string,
  formats: string[],
  cancelled = false,
) {
  await page.clock.setFixedTime(new Date("2026-10-10T16:00:00.000Z"));
  await page
    .context()
    .addCookies([{ name: "rf_token", value: "pdf-synthetic", url: baseURL }]);
  const writes: Array<{ path: string; body: unknown }> = [];
  let current = emptyView();
  if (cancelled)
    current = { ...current, state: "CANCELLED", expiresAt: null, actions: [] };
  await page.route("http://localhost:3001/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "OPTIONS")
      return route.fulfill({
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "*",
        },
      });
    if (path === "/auth/me")
      return route.fulfill(
        json({
          id: "pdf-user",
          username: "pdf-user",
          name: "PDF QA",
          role: "USER",
          isGuest: false,
          tenantId: "pdf-tenant",
          allowedProjects: [PROJECT],
          allowedProjectTypes: ["PESSOAL"],
          allowedModules: [
            "monthlyOverview",
            "expenses",
            "receipts",
            "cashFlow",
            "creditCards",
            "bankAccounts",
            "dashboard",
            "schedule",
            "pendencias",
            "recurringBills",
            "reminders",
          ],
        }),
      );
    if (path === "/auth/config")
      return route.fulfill(
        json({ registerEnabled: false, guestEnabled: false }),
      );
    const project = {
      id: PROJECT,
      name: "Pessoal PDF",
      type: "PESSOAL",
      onboardedAt: "2026-01-01T00:00:00.000Z",
    };
    if (path === "/projects") return route.fulfill(json([project]));
    if (path === `/projects/${PROJECT}`) return route.fulfill(json(project));
    if (path === "/agent/chat")
      return route.fulfill(
        json({
          reply: "Escolha o cartão e os documentos.",
          toolsUsed: [],
          provider: "synthetic",
          importEntryAction: {
            version: 1,
            kind: "START_CARD_INVOICE_IMPORT",
            formats,
            suggestedCardId: CARD,
          },
        }),
      );
    if (path === "/import-sessions" && request.method() === "GET")
      return route.fulfill(
        json({
          items: [],
          nextCursor: null,
          entry: { kind: "CARD_INVOICE", formats },
        }),
      );
    if (path === "/tenant/credit-cards")
      return route.fulfill(
        json([
          {
            id: CARD,
            nickname: "Cartão PDF",
            last4: "1234",
            closingDay: 5,
            dueDay: 12,
            project: { id: PROJECT, name: "Pessoal PDF" },
          },
        ]),
      );
    if (path === `/import-sessions/${SESSION}` && request.method() === "GET")
      return route.fulfill(json(current));
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      const body: unknown =
        request.method() === "PUT" ? null : request.postDataJSON();
      writes.push({ path, body });
      if (path === "/import-sessions") return route.fulfill(json(current, 201));
      if (path === `/import-sessions/${SESSION}/attachments`) {
        if (!record(body) || !Array.isArray(body.files))
          throw new Error("Invalid reserve request");
        current = {
          ...current,
          revision: current.revision + 1,
          attachments: body.files.map((file: unknown) => {
            if (
              !record(file) ||
              typeof file.id !== "string" ||
              typeof file.fileName !== "string" ||
              typeof file.declaredBytes !== "number"
            )
              throw new Error("Invalid file reservation");
            return {
              id: file.id,
              fileName: file.fileName,
              declaredBytes: file.declaredBytes,
              state: "RESERVED",
              canAnalyze: false,
              materializedInSession: false,
            };
          }),
        };
        return route.fulfill(json(current));
      }
      if (path.endsWith("/content")) {
        current = {
          ...current,
          revision: current.revision + 1,
          actions: ["ANALYZE", "CANCEL"],
          attachments: current.attachments.map((file) => ({
            ...file,
            state: "ATTACHED",
            canAnalyze: true,
          })),
        };
        return route.fulfill(json(current));
      }
      if (path.endsWith("/analyze"))
        return route.fulfill(
          json(
            {
              code: "OCR_REQUIRED",
              retryable: false,
              sessionId: SESSION,
              currentRevision: current.revision,
              reason: null,
            },
            422,
          ),
        );
      if (path.endsWith("/cancel")) {
        current = {
          ...emptyView(),
          state: "CANCELLED",
          expiresAt: null,
          revision: current.revision + 1,
          actions: [],
        };
        return route.fulfill(json(current));
      }
      return route.fulfill(json({ message: "Unexpected write" }, 400));
    }
    // Unrelated opening/nav data is deliberately absent, not fabricated financial content.
    return route.fulfill(json([], 404));
  });
  return writes;
}

for (const width of [375, 390, 1280]) {
  test(`PDF local consent, explicit single-card selection and honest OCR blocker at ${width}px`, async ({
    page,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const writes = await mockApi(page, baseURL!, ["CSV", "PDF"]);
    await page.goto(`/projects/${PROJECT}/maria`);
    await page
      .getByRole("button", { name: "Importar fatura de cartão", exact: true })
      .click();
    const card = page.getByRole("combobox", { name: "Cartão da fatura" });
    await expect(card).toHaveValue("");
    const picker = page.getByLabel("Selecionar arquivos", { exact: true });
    await expect(picker).toBeDisabled();
    expect(writes).toHaveLength(0);
    await card.selectOption(CARD);
    await expect(
      page.getByText(
        /PDF textual sem imagens; documentos com imagens podem exigir OCR, ainda indisponível/,
      ),
    ).toBeVisible();
    await picker.setInputFiles({
      name: "digitalizado.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-synthetic-scanned"),
    });
    expect(writes).toHaveLength(0);
    const consent = page.getByRole("button", {
      name: "Analisar e guardar rascunho",
    });
    await consent.scrollIntoViewIfNeeded();
    const bounds = await consent.boundingBox();
    expect(bounds?.height).toBeGreaterThanOrEqual(44);
    await consent.click();
    await expect(
      page.getByText(/Este PDF contém imagens e pode exigir OCR/),
    ).toBeVisible();
    const reserved = writes.find((write) =>
      write.path.endsWith("/attachments"),
    )?.body;
    expect(reserved).toMatchObject({
      files: [{ fileName: "digitalizado.pdf", mime: "application/pdf" }],
    });
    await expect(
      page.getByRole("button", {
        name: /Confirmar|Abrir revisão|Retomar envio|Repetir esta tentativa/,
      }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Analisar documento/ }),
    ).toBeDisabled();
    await page
      .getByRole("button", { name: "Consultar estado dos documentos" })
      .click();
    await expect(
      page.getByText(/Este PDF contém imagens e pode exigir OCR/),
    ).toBeVisible();
    expect(
      writes.filter((write) => write.path.endsWith("/analyze")),
    ).toHaveLength(1);
    const cancel = page.getByRole("button", {
      name: "Cancelar e voltar à Maria para pedir outra importação",
    });
    page.once("dialog", (dialog) => dialog.accept());
    await cancel.click();
    await expect(page).toHaveURL(new RegExp(`/projects/${PROJECT}/maria$`));
    expect(
      writes.filter((write) => write.path.endsWith("/cancel")),
    ).toHaveLength(1);
    expect(errors).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      ),
    ).toBe(false);
  });
}

test("CSV-only capability never advertises or accepts PDF", async ({
  page,
  baseURL,
}) => {
  const writes = await mockApi(page, baseURL!, ["CSV"]);
  await page.goto(`/projects/${PROJECT}/maria`);
  await page
    .getByRole("button", { name: "Importar fatura de cartão", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Cartão da fatura" })
    .selectOption(CARD);
  const picker = page.getByLabel("Selecionar arquivos", { exact: true });
  await expect(picker).toHaveAttribute("accept", ".csv");
  await picker.setInputFiles({
    name: "fatura.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-text"),
  });
  await expect(
    page.getByRole("alert").filter({ hasText: "Formato não suportado" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Analisar e guardar rascunho" }),
  ).toBeDisabled();
  await expect(page.getByText(/PDF textual/)).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("terminal reload does not expose any upload picker", async ({
  page,
  baseURL,
}) => {
  const writes = await mockApi(page, baseURL!, ["CSV", "PDF"], true);
  await page.goto(`/projects/${PROJECT}/maria?importSessionId=${SESSION}`);
  const conversation = page.getByRole("region", {
    name: "Conversa da importação",
  });
  await expect(
    conversation.getByText("Importação · Revisão 1", { exact: true }),
  ).toBeVisible();
  await expect(conversation).not.toContainText(SESSION);
  await expect(conversation).not.toHaveAccessibleName(new RegExp(SESSION));
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  expect(writes).toHaveLength(0);
});

test("PDF-capable upload reload requires a new local selection and consent", async ({
  page,
  baseURL,
}) => {
  const writes = await mockApi(page, baseURL!, ["CSV", "PDF"]);
  await page.goto(`/projects/${PROJECT}/maria?importSessionId=${SESSION}`);
  const picker = page.getByLabel("Selecionar arquivos", { exact: true });
  await expect(picker).toHaveAttribute("accept", ".csv,.pdf");
  await expect(
    page.getByRole("button", { name: "Analisar e guardar rascunho" }),
  ).toBeDisabled();
  await picker.setInputFiles({
    name: "fatura.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-synthetic-text"),
  });
  expect(writes).toHaveLength(0);
  await page
    .getByRole("button", { name: "Analisar e guardar rascunho" })
    .click();
  await expect(
    page.getByText(/Este PDF contém imagens e pode exigir OCR/),
  ).toBeVisible();
  expect(writes.some((write) => write.path === "/import-sessions")).toBe(false);
  expect(
    writes.find((write) => write.path.endsWith("/attachments"))?.body,
  ).toMatchObject({
    files: [{ fileName: "fatura.pdf", mime: "application/pdf" }],
  });
});
