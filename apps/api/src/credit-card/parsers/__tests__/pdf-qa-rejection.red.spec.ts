import { createHash } from "node:crypto";
import { extractPdfDocument } from "../pdf-document";
import { buildImportMaterialization } from "../../../imports/import-session/import-session.extraction";
import {
  ignoredImportObservation,
  parseStoredImportObservationEvidence,
} from "../../../imports/import-session/import-session.observation";
import { EMPTY_DRAFT_JSON } from "../../../imports/import-session/import-session.projection";
import {
  generateMixedInvoicePdf,
  generateScannedOnlyPdf,
  generateTextInvoicePdf,
  PDF_QA_PAYMENT,
  PDF_QA_PURCHASES,
  PDF_QA_PURCHASE_TOTAL_CENTS,
} from "./pdf-qa-fixtures";

/**
 * Acceptance contracts retargeted to the private document adapter/materializer.
 * Legacy signed-ledger behavior remains characterized in pdf-qa-extraction.
 * These yearless source dates must remain unknown, not inferred from the clock.
 */
describe("PDF QA: safe purchase-document acceptance", () => {
  it("marks only scanned-only PDFs OCR_REQUIRED", async () => {
    await expect(
      extractPdfDocument(generateScannedOnlyPdf()),
    ).rejects.toMatchObject({ code: "OCR_REQUIRED" });
  });

  it("fails mixed searchable/raster PDFs without external OCR eligibility", async () => {
    await expect(
      extractPdfDocument(generateMixedInvoicePdf()),
    ).rejects.toMatchObject({ code: "DOCUMENT_UNREADABLE" });
  });

  it("materializes five editable purchases and retains ignored payment evidence", async () => {
    const bytes = generateTextInvoicePdf();
    const result = await extractPdfDocument(bytes);
    expect(result.parserVersion).toBe("card-local-pdf-v1");
    expect(result.metrics.pages).toBe(1);
    expect(result.occurrences).toHaveLength(6);
    expect(
      result.occurrences.map((occurrence) => ({
        dateOnly: occurrence.dateOnly,
        merchant: occurrence.merchant,
        amountCents: occurrence.amountCents,
      })),
    ).toEqual(
      [...PDF_QA_PURCHASES, PDF_QA_PAYMENT].map((tx) => ({
        dateOnly: null,
        merchant: tx.merchant,
        amountCents: tx.amountCents,
      })),
    );
    const session = {
      id: "pdf-qa-session",
      tenantId: "pdf-qa-tenant",
      ownerProjectId: "pdf-qa-project",
    };
    const attachment = {
      ...session,
      id: "pdf-qa-attachment",
      sessionId: session.id,
      artifactId: "pdf-qa-artifact",
      state: "ATTACHED",
    };
    const artifact = {
      ...session,
      id: attachment.artifactId,
      state: "EXTRACTED",
      parserVersion: result.parserVersion,
      documentSha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const draft = JSON.parse(EMPTY_DRAFT_JSON);
    draft.scope.pendingAttachmentIds = [attachment.id];
    const materialized = buildImportMaterialization({
      session,
      attachment: attachment as never,
      artifact: artifact as never,
      extraction: result,
      draft,
      observations: [],
      newIds: new Map(
        result.occurrences.map((occurrence, i) => [
          occurrence.reference,
          {
            observationId: `pdf-qa-observation-${i}`,
            lineId: `pdf-qa-line-${i}`,
          },
        ]),
      ),
    });
    const evidence = materialized.observations.map((row) =>
      parseStoredImportObservationEvidence(row.evidenceJson),
    );
    expect(evidence.map(ignoredImportObservation)).toEqual([
      null,
      null,
      null,
      null,
      null,
      "INVOICE_PAYMENT",
    ]);
    expect(evidence.map((row) => row.amountCents)).toEqual([
      20696, 1, 150000, 2069600, 8743, -2249040,
    ]);
    expect(
      evidence.slice(0, 5).reduce((sum, row) => sum + row.amountCents!, 0),
    ).toBe(PDF_QA_PURCHASE_TOTAL_CENTS);
    expect(evidence[5]).toMatchObject({
      sourceDescription: "PAGAMENTO DE FATURA",
      amountCents: -2249040,
      dataCompra: null,
    });
    expect(materialized.draft.scope.observationIds).toEqual(
      materialized.observations.map((row) => row.id),
    );
    expect(materialized.draft.scope.pendingAttachmentIds).toEqual([]);
    expect(materialized.draft.lines.map((line) => line.fornecedor)).toEqual(
      PDF_QA_PURCHASES.map((tx) => tx.merchant),
    );
    expect(
      materialized.draft.lines.flatMap((line) => line.observationIds),
    ).toEqual(materialized.observations.slice(0, 5).map((row) => row.id));
    expect(materialized.draft.selectedLineIds).toEqual([]);
    expect(draft.scope.pendingAttachmentIds).toEqual([attachment.id]);
    expect(draft.lines).toEqual([]);
  });
});
