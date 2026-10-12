import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type Response } from "@playwright/test";
import {
  isPendingImportQuestion,
  type ImportSessionViewV1,
} from "@reformaflow/domain";
import {
  assertReadableMoney,
  assertTouchable,
  assertUniqueButtonNames,
} from "./helpers/evidence";
import {
  generateLivePdf,
  pdfExpected,
  pdfFixtureAnswer,
} from "./helpers/pdf-fixture";
import {
  PdfEvidence,
  sessionIdFromAnalyzeResponseUrl,
  startPdfJourney,
} from "./helpers/pdf-live-journey";
import { identicalImportNotice } from "./helpers/supported-import-entry";
import { nativeDocumentaryContract } from "./helpers/native-documentary-answer";
import {
  fillFocusedDraftPreview,
  focusedDraftContract,
  isAgentChatPost,
  isFocusedDraftQuestion,
  nativeFocusedOnly,
  visibleCurrentQuestionForm,
} from "./helpers/focused-draft-answer";

let fixtures: string;
test.beforeAll(async () => {
  fixtures = await generateLivePdf();
});
test.afterAll(async () => {
  if (fixtures) await fs.rm(fixtures, { recursive: true, force: true });
});

const sessionFromUrl = (page: Page) =>
  new URL(page.url()).searchParams.get("importSessionId") ?? "";
const sessionResponse =
  (sessionId: string, suffix = "", method = "GET") =>
  (response: Response) =>
    new URL(response.url()).pathname ===
      `/import-sessions/${sessionId}${suffix}` &&
    response.request().method() === method;
const assertPurchases = (view: ImportSessionViewV1) => {
  expect(view.lines).toHaveLength(pdfExpected.purchases.length);
  for (const purchase of pdfExpected.purchases) {
    expect(
      view.lines.filter((line) => line.titulo === purchase.title),
    ).toHaveLength(1);
  }
  expect(view.lines.map((line) => line.titulo)).not.toContain(
    pdfExpected.ignoredPaymentRow,
  );
};

test("real typed-origin PDF → one integral REFORMA target → ignored payment → persistent receipt", async ({
  page,
}, info) => {
  // Each real 7b answer has its own 120s transport budget, not a mocked response.
  test.setTimeout(900_000);
  const evidence = new PdfEvidence(page, info, "confirmation");
  let primary: unknown;
  try {
    const journey = await startPdfJourney(page, evidence);
    const first = path.join(fixtures, "textual-invoice.pdf");
    const copy = path.join(fixtures, "renamed-textual-invoice.pdf");
    expect((await fs.readFile(first)).equals(await fs.readFile(copy))).toBe(
      true,
    );
    await journey.filePicker.setInputFiles([first, copy]);
    const files = page.getByRole("list", {
      name: "Arquivos selecionados",
      exact: true,
    });
    await expect(files.getByRole("listitem")).toHaveCount(2);
    await expect(files).toContainText("textual-invoice.pdf");
    await expect(files).toContainText("renamed-textual-invoice.pdf");
    expect(sessionFromUrl(page)).toBe("");
    await journey.noFinance();
    await evidence.capture("local-files-before-documentary-consent");
    const consent = page.getByRole("button", {
      name: "Analisar e guardar rascunho",
      exact: true,
    });
    await assertTouchable(consent);
    await evidence.response(
      "textual-analysis",
      (r) =>
        /\/import-sessions\/[^/]+\/attachments\/[^/]+\/analyze$/.test(
          new URL(r.url()).pathname,
        ) && r.request().method() === "POST",
      () => consent.click(),
    );
    await expect(
      page.getByText(identicalImportNotice, { exact: true }),
    ).toBeVisible();
    const sessionId = sessionFromUrl(page);
    expect(sessionId).not.toBe("");
    const activeAgentChatRequests: string[] = [];
    page.on("request", (request) => {
      if (isAgentChatPost(request))
        activeAgentChatRequests.push(new URL(request.url()).pathname);
    });
    const view = () => journey.view(sessionId);
    const uploaded = await view();
    assertPurchases(uploaded);
    expect(uploaded.ownerProjectId).toBe(journey.projectId);
    expect(uploaded.cardId).toBe(journey.card.id);
    expect(
      uploaded.attachments.filter(
        (attachment) => attachment.state === "ATTACHED",
      ),
    ).toHaveLength(1);
    await journey.noFinance();
    await evidence.capture("identical-pdf-deduplicated-real-analysis");

    await page.reload();
    await expect(
      page.getByRole("region", { name: "Conversa da importação", exact: true }),
    ).toBeVisible();
    expect(sessionFromUrl(page)).toBe(sessionId);
    await expect(journey.filePicker).toHaveCount(0);
    assertPurchases(await view());
    await journey.noFinance();
    const payment = page.getByRole("group", {
      name: /^Linha ignorada: .*PAGAMENTO DE FATURA/i,
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
    await evidence.capture("reload-draft-ignored-payment");

    const selected = pdfExpected.purchases.slice(0, 2);
    expect(
      selected.reduce((sum, purchase) => sum + purchase.amountCents, 0),
    ).toBe(pdfExpected.selectedTotalCents);
    const selectedIds = (await view()).lines
      .filter((line) => selected.some((p) => p.title === line.titulo))
      .map((line) => line.id);
    expect(selectedIds).toHaveLength(2);
    for (const line of (await view()).lines) {
      const row = page
        .locator(`[data-review-blocker-line="${line.id}"]`)
        .first();
      await expect(row).toBeVisible();
      const desired = selectedIds.includes(line.id);
      const current = (await view()).selectedLineIds.includes(line.id);
      if (current !== desired) {
        await row
          .getByRole("button", {
            name: desired
              ? `Incluir compra ${line.id} na revisão`
              : `Retirar compra ${line.id} da seleção`,
            exact: true,
          })
          .click();
      }
      await expect
        .poll(async () => (await view()).selectedLineIds.includes(line.id))
        .toBe(desired);
      await journey.noFinance();
    }
    expect([...(await view()).selectedLineIds].sort()).toEqual(
      [...selectedIds].sort(),
    );
    await evidence.capture("explicit-two-purchase-subset");

    for (let attempt = 0; attempt < 30; attempt++) {
      let current = await view();
      let question = current.questions.find(
        (q) =>
          isPendingImportQuestion(q) &&
          q.lineIds.some((id) => selectedIds.includes(id)),
      );
      if (!question) {
        await evidence.response(
          `prepare-${attempt + 1}`,
          sessionResponse(sessionId, "/prepare", "POST"),
          () =>
            page
              .getByRole("button", {
                name: "Abrir revisão do lote",
                exact: true,
              })
              .click(),
        );
        await journey.noFinance();
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
      const answer = pdfFixtureAnswer(question, current, selectedIds);
      if (isFocusedDraftQuestion(question)) {
        await nativeFocusedOnly(form, async () => {
          const typed = await fillFocusedDraftPreview(
            form,
            question,
            pdfExpected.declarations.firstDueDate,
            current,
            journey.target,
          );
          await evidence.capture(
            `answer-${attempt + 1}-${question.field}-typed-preview`,
          );
          const contract = focusedDraftContract(
            sessionId,
            question,
            current,
            typed,
          );
          const response = await evidence.response(
            `answer-${attempt + 1}-${question.field}-focused-draft`,
            contract.matches,
            () =>
              form
                .getByRole("button", {
                  name: "Guardar informação",
                  exact: true,
                })
                .click(),
          );
          await contract.assertSaved(response);
          await journey.noFinance();
          await evidence.capture(
            `answer-${attempt + 1}-${question.field}-saved`,
          );
        });
        continue;
      }
      const radio = form.getByRole("radio", {
        name: "Total da compra",
        exact: true,
      });
      if (question.field === "amountMeaning" && (await radio.count()))
        await radio.check();
      else {
        // Documentary dates have a native date control; use its explicit text
        // alternative for the manifest's Brazilian literal, not imperative DOM.
        const textMode = form.getByRole("button", {
          name: "Responder com texto",
          exact: true,
        });
        if (question.field === "dataCompra" && (await textMode.count()))
          await textMode.click();
        await form.locator("input:not([type=radio])").fill(answer);
      }
      await evidence.capture(`answer-${attempt + 1}-${question.field}-literal`);
      if ("subject" in question) {
        await form
          .getByRole("button", { name: "Conferir informação", exact: true })
          .click();
        await expect(
          form.getByLabel("Prévia da informação", { exact: true }),
        ).toBeVisible();
      }
      const native =
        "subject" in question
          ? nativeDocumentaryContract(sessionId, question, current, answer)
          : null;
      const savedResponse = await evidence.response(
        `answer-${attempt + 1}-${question.field}`,
        (r) => {
          if (native) return native.matches(r);
          return false;
        },
        () =>
          form
            .getByRole("button", {
              name:
                "subject" in question
                  ? "Guardar informação"
                  : "Responder à pergunta",
              exact: true,
            })
            .click(),
      );
      if (native) await native.assertSaved(savedResponse);
      await expect
        .poll(async () => (await view()).revision)
        .toBeGreaterThan(current.revision);
      await journey.noFinance();
      await evidence.capture(`answer-${attempt + 1}-${question.field}-saved`);
    }
    expect(
      (await view()).questions.filter(
        (q) =>
          isPendingImportQuestion(q) &&
          q.lineIds.some((id) => selectedIds.includes(id)),
      ),
    ).toEqual([]);
    expect(
      activeAgentChatRequests,
      "An active PDF session must never call /agent/chat",
    ).toEqual([]);
    const ready = await view();
    const creates = ready.proposal?.lines.filter(
      (planned) => planned.kind === "CREATE",
    );
    expect(creates).toHaveLength(selected.length);
    for (const planned of creates ?? []) {
      if (planned.kind !== "CREATE") throw new Error("expected CREATE");
      expect(planned.targets).toHaveLength(1);
      expect(planned.targets[0]).toMatchObject({
        projectId: journey.target.projectId,
        roomId: journey.target.roomId,
        amountCents: planned.totalCents,
      });
    }
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
    for (const purchase of selected)
      await expect(purchases).toContainText(purchase.title);
    for (const purchase of pdfExpected.purchases.slice(2))
      await expect(purchases).not.toContainText(purchase.title);
    await expect(purchases).not.toContainText(pdfExpected.ignoredPaymentRow);
    await assertUniqueButtonNames(page);
    await assertReadableMoney(review, true);
    await journey.noFinance();
    await evidence.capture("review-before-explicit-financial-consent");
    const confirm = review.getByRole("button", {
      name: "Confirmar lote",
      exact: true,
    });
    await assertTouchable(confirm);
    await evidence.response(
      "execute-after-explicit-confirm",
      (r) =>
        new URL(r.url()).pathname === `/import-sessions/${sessionId}/execute` &&
        r.request().method() === "POST",
      () => confirm.click(),
    );
    const receipt = page.getByTestId("import-receipt");
    await expect(receipt).toBeVisible();
    await expect.poll(async () => (await journey.expenses()).total).toBe(2);
    const applied = await journey.expenses();
    expect(
      applied.items
        .map((item) => ({ title: item.titulo, amountCents: item.valor }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    ).toEqual(
      selected
        .map((p) => ({ title: p.title, amountCents: p.amountCents }))
        .sort((a, b) => a.title.localeCompare(b.title)),
    );
    expect(applied.items.reduce((sum, item) => sum + item.valor, 0)).toBe(
      20697,
    );
    expect(new Set(applied.items.map((item) => item.id)).size).toBe(2);
    expect(applied.items.every((item) => item.cardLast4 === "4242")).toBe(true);
    const terminal = await view();
    expect(terminal.cardId).toBe(journey.card.id);
    expect(terminal.state).toBe("APPLIED");
    expect(terminal.receipt).toBeTruthy();
    expect(
      terminal.receipt!.items.map((item) => item.sourceExpenseId).sort(),
    ).toEqual(applied.items.map((item) => item.id).sort());
    await assertReadableMoney(receipt, true);
    await evidence.capture("two-exact-pdf-purchases-receipt");
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Conversa da importação", exact: true }),
    ).toBeVisible();
    if (!(await receipt.isVisible())) {
      await evidence.response(
        "saved-receipt",
        (r) =>
          new URL(r.url()).pathname ===
            `/import-sessions/${sessionId}/result` &&
          r.request().method() === "GET",
        () =>
          page
            .getByRole("button", { name: "Consultar comprovante", exact: true })
            .click(),
      );
    }
    await expect(receipt).toBeVisible();
    expect((await view()).state).toBe("APPLIED");
    expect((await view()).receipt).toEqual(terminal.receipt);
    expect(
      (await journey.expenses()).items.map((item) => item.id).sort(),
    ).toEqual(applied.items.map((item) => item.id).sort());
    await expect(journey.filePicker).toHaveCount(0);
    await expect(
      page.getByRole("button", {
        name: /Analisar documento|Analisar e guardar rascunho|Confirmar lote|Aplicar lote confirmado|Retomar envio/,
      }),
    ).toHaveCount(0);
    await evidence.capture("terminal-reload-no-reupload-or-reexecution");
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    await evidence.finalize(primary);
  }
});

for (const fixture of [
  {
    name: "scanned",
    code: "OCR_REQUIRED",
    copy: /Este PDF contém imagens e pode exigir OCR/,
  },
  {
    name: "mixed",
    code: "OCR_REQUIRED",
    copy: /Este PDF contém imagens e pode exigir OCR/,
  },
  {
    name: "invalid",
    code: "DOCUMENT_UNREADABLE",
    copy: /Não foi possível ler este documento/,
  },
]) {
  test(`real ${fixture.name} PDF → explicit ${fixture.code} → no published purchases or finance`, async ({
    page,
  }, info) => {
    const evidence = new PdfEvidence(page, info, fixture.name);
    let primary: unknown;
    try {
      const journey = await startPdfJourney(page, evidence);
      await journey.filePicker.setInputFiles(
        path.join(fixtures, `${fixture.name}-invoice.pdf`),
      );
      expect(sessionFromUrl(page)).toBe("");
      await journey.noFinance();
      await evidence.capture("local-document-before-consent");
      // Learn the exact attachment URL from the real reservation response BEFORE analysis.
      page.on("response", (response) => {
        if (
          response.request().method() === "POST" &&
          /\/import-sessions\/[^/]+\/attachments$/.test(
            new URL(response.url()).pathname,
          )
        ) {
          const reserved = response.request().postDataJSON().files;
          expect(reserved).toHaveLength(1);
          evidence.expectedDocumentFailure = {
            path: `${new URL(response.url()).pathname}/${reserved[0].id}/analyze`,
            code: fixture.code,
          };
        }
      });
      const analyzeResponse = await evidence.response(
        "document-rejection",
        (r) =>
          r.request().method() === "POST" &&
          new URL(r.url()).pathname === evidence.expectedDocumentFailure?.path,
        () =>
          page
            .getByRole("button", {
              name: "Analisar e guardar rascunho",
              exact: true,
            })
            .click(),
        fixture.code,
      );
      const sessionId = sessionIdFromAnalyzeResponseUrl(analyzeResponse.url());
      const persistentSessionHref = `/projects/${journey.projectId}/maria?importSessionId=${encodeURIComponent(sessionId)}`;
      await expect(
        page.getByRole("alert").filter({ hasText: fixture.copy }),
      ).toBeVisible();
      const assertUnpublished = async () => {
        const current = await journey.view(sessionId);
        expect(current.lines).toEqual([]);
        expect(current.selectedLineIds).toEqual([]);
        expect(current.questions).toEqual([]);
        expect(current.declaredFacts).toEqual([]);
        expect(current.proposal).toBeNull();
        expect(current.confirmation).toBeNull();
        expect(current.receipt).toBeNull();
        expect(current.attachments.every((a) => !a.materializedInSession)).toBe(
          true,
        );
        expect(current.state).not.toBe("APPLIED");
        expect(current.actions).not.toContain("CONFIRM");
        expect(current.actions).not.toContain("EXECUTE");
        expect(
          await journey.get(`/import-sessions/${sessionId}/observations`),
        ).toMatchObject({ items: [] });
        await journey.noFinance();
      };
      await assertUnpublished();
      await expect(
        page.getByRole("button", {
          name: /Confirmar lote|Aplicar lote confirmado/,
        }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("region", {
          name: "Substituir documento ou cancelar",
          exact: true,
        }),
      ).toBeVisible();
      await evidence.capture("explicit-document-error-no-publication");
      await page
        .getByRole("button", {
          name: "Consultar estado dos documentos",
          exact: true,
        })
        .click();
      await expect(
        page.getByRole("alert").filter({ hasText: fixture.copy }),
      ).toBeVisible();
      await assertUnpublished();
      // Reload reads persistent server state without re-analyzing/re-uploading.
      await page.goto(persistentSessionHref);
      await page.reload();
      await expect(
        page.getByRole("region", {
          name: "Conversa da importação",
          exact: true,
        }),
      ).toBeVisible();
      await assertUnpublished();
      await evidence.capture("reloaded-unpublished-no-financial-effects");
    } catch (error) {
      primary = error;
      throw error;
    } finally {
      await evidence.finalize(primary);
    }
  });
}
