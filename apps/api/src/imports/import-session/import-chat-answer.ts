import {
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  parseInstallmentDateOnlyUtc,
  type ImportClarificationReason,
  type ImportSessionDraftLineV1,
  type ImportSessionDraftQuestionV1,
  type ImportSessionCandidateV1,
} from "@reformaflow/domain";
import {
  parseImportToolArguments,
  type ImportLiteralSpanV1,
  type ImportMoneyLiteralV1,
} from "../../agent/import-chat.contract";
import { parseSpokenMoney } from "../../agent/tools/money-parse";

export type ResolvedImportAnswerV1 =
  | { kind: "VALUE"; lines: ImportSessionDraftLineV1[] }
  | {
      kind: "CLARIFY";
      reason: Exclude<ImportClarificationReason, "SCOPE_REVIEW">;
    };
export type ImportAnswerReferences = {
  projects: readonly {
    id: string;
    name: string;
    rooms: readonly { id: string; name: string }[];
  }[];
  candidates: readonly ImportSessionCandidateV1[];
};
const clarify = (
  reason: Exclude<ImportClarificationReason, "SCOPE_REVIEW">,
): ResolvedImportAnswerV1 => ({ kind: "CLARIFY", reason });
const normalized = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const words = (text: string) =>
  normalized(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const mentioned = (text: string, name: string) =>
  words(name).length > 0 && ` ${words(text)} `.includes(` ${words(name)} `);
function spanText(literal: string, span: ImportLiteralSpanV1): string | null {
  const splitsPair = (index: number) =>
    index > 0 &&
    index < literal.length &&
    /[\uD800-\uDBFF]/.test(literal[index - 1]) &&
    /[\uDC00-\uDFFF]/.test(literal[index]);
  return span.end <= literal.length &&
    !splitsPair(span.start) &&
    !splitsPair(span.end)
    ? literal.slice(span.start, span.end)
    : null;
}
function money(literal: string, value: ImportMoneyLiteralV1): number | null {
  if (spanText(literal, value.span) !== value.text) return null;
  const token = value.text.trim();
  if (
    !/^(?:R\$\s*)?(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)$/i.test(
      token,
    )
  )
    return null;
  const before = literal.slice(0, value.span.start);
  const after = literal.slice(value.span.end);
  if (
    /[\d.,+\-]\s*$/.test(before) ||
    /^\s*[\d.,]/.test(after) ||
    /[\p{L}\p{N}_]$/u.test(before) ||
    /^[\p{L}\p{N}_]/u.test(after)
  )
    return null;
  const amount = parseSpokenMoney(value.text);
  if (amount === null) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) &&
    cents >= PRIMITIVES.minPurchaseCents &&
    cents <= PRIMITIVES.maxCents
    ? cents
    : null;
}

/** Draft-field interpretation only. Original observations and financial identity never change. */
export function resolveImportAnswer(
  literal: string,
  field: ImportSessionDraftQuestionV1["field"],
  unknownInterpretation: unknown,
  lines: readonly ImportSessionDraftLineV1[],
  references?: ImportAnswerReferences,
): ResolvedImportAnswerV1 {
  const parsed = parseImportToolArguments("import_edit_answer", {
    interpretation: unknownInterpretation,
  });
  if (parsed.name !== "import_edit_answer")
    throw Error("Unexpected tool parser result");
  const answer = parsed.arguments.interpretation;
  if (answer.kind === "MULTI_FIELD") return clarify("MULTI_FIELD");
  if (answer.kind !== "VALUE") {
    return clarify(answer.kind === "INVALID" ? "INVALID_VALUE" : answer.kind);
  }
  if (answer.field !== field || !lines.length) return clarify("INVALID_VALUE");
  const evidence = spanText(literal, answer.evidence);
  if (evidence === null || !evidence.trim()) return clarify("INVALID_VALUE");
  const unknown =
    /^(?:nao sei(?: informar)?|desconhecido|remover|limpar)$/i.test(
      normalized(evidence),
    );
  if (answer.value === null && !unknown) return clarify("AMBIGUOUS");
  if (
    (answer.field === "tipoDespesa" || answer.field === "categoriaMaoDeObra") &&
    words(literal) === "sim" &&
    lines.some((line) => line[answer.field] !== answer.value)
  )
    return clarify("AMBIGUOUS");
  const result = lines.map((line) => ({ ...line }));
  switch (answer.field) {
    case "amountCents": {
      if (answer.value === null) {
        for (const line of result) line.amountCents = null;
        break;
      }
      const cents = money(literal, answer.value);
      const outside =
        literal.slice(0, answer.value.span.start) +
        literal.slice(answer.value.span.end);
      if (cents === null || /\d/.test(outside)) return clarify("INVALID_VALUE");
      for (const line of result) line.amountCents = cents;
      break;
    }
    case "installmentCount": {
      if (
        answer.value !== null &&
        (!/^\d+$/.test(evidence.trim()) ||
          Number(evidence.trim()) !== answer.value)
      )
        return clarify("UNSUPPORTED_NORMALIZATION");
      for (const line of result) line.installmentCount = answer.value;
      break;
    }
    case "dataCompra":
    case "firstDueDate": {
      if (answer.value !== null) {
        const date = evidence
          .trim()
          .replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1");
        if (date !== answer.value || !parseInstallmentDateOnlyUtc(date))
          return clarify("UNSUPPORTED_NORMALIZATION");
      }
      for (const line of result) line[answer.field] = answer.value;
      break;
    }
    case "amountMeaning":
      if (
        /\btotal\b/.test(normalized(evidence)) &&
        /\bparcela\b/.test(normalized(evidence))
      )
        return clarify("AMBIGUOUS");
      if (answer.value === "UNKNOWN" && !unknown) return clarify("AMBIGUOUS");
      if (
        answer.value === "TOTAL_PURCHASE" &&
        !/\btotal\b/.test(normalized(evidence))
      )
        return clarify("AMBIGUOUS");
      if (
        answer.value === "INSTALLMENT_CHARGE" &&
        !/\bparcela\b/.test(normalized(evidence))
      )
        return clarify("AMBIGUOUS");
      for (const line of result) line.amountMeaning = answer.value;
      break;
    case "decision":
      if (answer.value.kind === "UNRESOLVED" && !unknown)
        return clarify("AMBIGUOUS");
      if (
        answer.value.kind === "CREATE" &&
        answer.value.acceptNaturalDuplicate &&
        !/\bcompras? (?:diferentes|distintas|separadas)\b/.test(
          normalized(evidence),
        )
      )
        return clarify("AMBIGUOUS");
      if (words(literal) === "sim") return clarify("AMBIGUOUS");
      if (answer.value.kind === "KEEP_EXISTING") {
        const expenseId = answer.value.expenseId;
        if (
          lines.some(
            (line) =>
              !references?.candidates.some(
                (candidate) =>
                  candidate.lineId === line.id &&
                  candidate.kind === "EXPENSE" &&
                  candidate.id === expenseId &&
                  candidate.canKeepExisting,
              ),
          )
        )
          return clarify("AMBIGUOUS");
      }
      for (const line of result) line.decision = answer.value;
      break;
    case "targets":
      if (answer.value === null || answer.value.kind === "NO_TARGETS") {
        if (
          answer.value !== null &&
          !/\bsem (?:destino|rateio)\b/.test(normalized(evidence))
        )
          return clarify("AMBIGUOUS");
        for (const line of result)
          line.targets = answer.value === null ? null : [];
      } else {
        const targets = answer.value.items;
        for (const target of targets) {
          const project = references?.projects.find(
            (project) => project.id === target.projectId,
          );
          if (
            !project ||
            !mentioned(evidence, project.name) ||
            references?.projects.some(
              (other) =>
                (other.id !== project.id &&
                  words(other.name) === words(project.name)) ||
                words(other.id) === words(project.name),
            )
          )
            return clarify("AMBIGUOUS");
          if (target.roomId !== null) {
            const room = project.rooms.find(
              (room) => room.id === target.roomId,
            );
            if (
              !room ||
              !mentioned(evidence, room.name) ||
              project.rooms.some(
                (other) =>
                  other.id !== room.id &&
                  words(other.name) === words(room.name),
              )
            )
              return clarify("AMBIGUOUS");
          }
        }
        for (const line of result) {
          const resolved = [];
          for (const target of targets) {
            const cents =
              "kind" in target.amount
                ? line.amountMeaning === "TOTAL_PURCHASE"
                  ? line.amountCents
                  : null
                : money(literal, target.amount);
            if (cents === null || cents <= 0) return clarify("INVALID_VALUE");
            resolved.push({
              projectId: target.projectId,
              roomId: target.roomId,
              amountCents: cents,
            });
          }
          line.targets = resolved;
        }
      }
      break;
    case "tipoDespesa":
      for (const line of result) line.tipoDespesa = answer.value;
      break;
    case "categoriaMaoDeObra":
      for (const line of result) line.categoriaMaoDeObra = answer.value;
      break;
  }
  return { kind: "VALUE", lines: result };
}
