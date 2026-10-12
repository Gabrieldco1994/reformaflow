import { formatDateBR } from "@/lib/utils";
import type { ImportSessionDocumentFormat } from "@reformaflow/domain";

export const IMPORT_FORMAT_EXTENSIONS: Record<
  ImportSessionDocumentFormat,
  string
> = {
  CSV: ".csv",
  OFX: ".ofx",
  PDF: ".pdf",
  XLS: ".xls",
  XLSX: ".xlsx",
  PNG: ".png",
  JPEG: ".jpeg,.jpg",
  WEBP: ".webp",
};

export const IMPORT_FORMAT_MIME = {
  CSV: "text/csv",
  PDF: "application/pdf",
} as const;

export function importFormatLabel(
  formats: readonly ImportSessionDocumentFormat[],
) {
  const labels = formats.map((format) =>
    format === "PDF" ? "PDF textual sem imagens" : format,
  );
  if (labels.length < 2) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} e ${labels.at(-1)}`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DUE_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

const BRT_PARTS = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Date-only strings are printed as-is; they never go through `new Date`. */
export function formatDateOnly(
  value: string | null | undefined,
): string | null {
  return typeof value === "string" && DATE_ONLY.test(value)
    ? formatDateBR(value)
    : null;
}

/** An instant is the only value that legitimately needs the BRT conversion. */
export function formatInstantBRT(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string" || !INSTANT.test(value)) return null;
  const parts = Object.fromEntries(
    BRT_PARTS.formatToParts(new Date(value)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `${parts.day}/${parts.month}/${parts.year} às ${parts.hour}:${parts.minute}`;
}

export function formatDueMonth(
  value: string | null | undefined,
): string | null {
  const match = typeof value === "string" ? DUE_MONTH.exec(value) : null;
  return match ? `${match[2]}/${match[1]}` : null;
}
