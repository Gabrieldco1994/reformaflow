import { expect, type Page, type Response } from "@playwright/test";

export const invoiceImportCTA = "Importar fatura de cartão";
export const identicalImportNotice =
  "Este arquivo idêntico já está guardado nesta importação; o arquivo repetido foi ignorado.";

const formatCopy = {
  CSV: "CSV",
  PDF: "PDF textual sem imagens",
} as const;
const extensions = { CSV: ".csv", PDF: ".pdf" } as const;
const pdfWarning =
  "PDF textual sem imagens; documentos com imagens podem exigir OCR, ainda indisponível. Isso inclui imagens como logotipos de bancos. Use um arquivo com texto e sem imagens ou cancele; nenhum lançamento será confirmado.";

/** Assert the actual server-qualified entry, including CSV-only capability.
 * Never import production view/parser modules into the browser spec.
 */
export async function assertSupportedImportEntry(
  page: Page,
  response: Response,
  requiredFormat: keyof typeof formatCopy,
) {
  const body = await response.json();
  expect(body.importEntryAction).toMatchObject({
    version: 1,
    kind: "START_CARD_INVOICE_IMPORT",
  });
  const formats: unknown = body.importEntryAction.formats;
  expect(Array.isArray(formats)).toBe(true);
  if (!Array.isArray(formats))
    throw new Error("Missing qualified import formats");
  expect(formats.length).toBeGreaterThan(0);
  expect(new Set(formats).size).toBe(formats.length);
  for (const format of formats) expect(["CSV", "PDF"]).toContain(format);
  expect(formats).toContain(requiredFormat);
  const supported = formats as (keyof typeof formatCopy)[];
  const form = page.getByRole("form", {
    name: "Documentos para análise",
    exact: true,
  });
  await expect(form).toBeVisible();
  const picker = form.getByLabel("Selecionar arquivos", { exact: true });
  await expect(picker).toHaveAttribute(
    "accept",
    supported.map((format) => extensions[format]).join(","),
  );
  await expect(
    form.getByText(
      `${supported.map((format) => formatCopy[format]).join(" e ")}. Até 5 arquivos, 10485760 bytes por arquivo. A seleção não valida o conteúdo; a análise depende dos formatos habilitados.`,
      { exact: true },
    ),
  ).toBeVisible();
  const warning = form.getByText(pdfWarning, { exact: true });
  if (supported.includes("PDF")) await expect(warning).toBeVisible();
  else await expect(warning).toHaveCount(0);
}
