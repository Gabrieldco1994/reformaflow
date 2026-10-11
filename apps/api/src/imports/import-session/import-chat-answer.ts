import {
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  ImportSessionAmountMeaning,
  parseInstallmentDateOnlyUtc,
  type ImportClarificationReason,
  type ImportHumanFactFieldV1,
  type ImportSessionCandidateV1,
  type ImportSessionDraftLineV1,
  type ImportSessionDraftQuestionV1,
} from "@reformaflow/domain";
import {
  IMPORT_DECISION_ANSWER,
  parseImportToolArguments,
  type ImportFocusedAnswerV1,
  type ImportTargetAnswerV1,
} from "../../agent/import-chat.contract";
import { parseSpokenMoney } from "../../agent/tools/money-parse";

export type ResolvedImportAnswerV1 =
  | { kind: "VALUE"; lines: ImportSessionDraftLineV1[] }
  | {
      kind: "CLARIFY";
      reason: Exclude<ImportClarificationReason, "SCOPE_REVIEW">;
    };
export type ResolvedImportDocumentaryAnswerV1 =
  | { kind: "VALUE"; literal: string }
  | Extract<ResolvedImportAnswerV1, { kind: "CLARIFY" }>;
export type ImportAnswerReferences = {
  projects: readonly {
    id: string;
    name: string;
    rooms: readonly { id: string; name: string }[];
  }[];
  candidates: readonly ImportSessionCandidateV1[];
};

type Token<T> = {
  start: number;
  end: number;
  text: string;
  value: T;
};

const clarify = (
  reason: Exclude<ImportClarificationReason, "SCOPE_REVIEW">,
): Extract<ResolvedImportAnswerV1, { kind: "CLARIFY" }> => ({
  kind: "CLARIFY",
  reason,
});
const normalized = (text: string) =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const words = (text: string) =>
  normalized(text)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const mentioned = (text: string, name: string) =>
  words(name).length > 0 && ` ${words(text)} `.includes(` ${words(name)} `);
const unknownAnswer = (literal: string) =>
  /^(?:nao sei(?: informar)?|desconhecido|remover|limpar)$/i.test(
    normalized(literal),
  );
const splitsPair = (literal: string, index: number) =>
  index > 0 &&
  index < literal.length &&
  /[\uD800-\uDBFF]/.test(literal[index - 1]) &&
  /[\uDC00-\uDFFF]/.test(literal[index]);
const validRange = (literal: string, start: number, end: number) =>
  start >= 0 &&
  start < end &&
  end <= literal.length &&
  !splitsPair(literal, start) &&
  !splitsPair(literal, end);
const only = <T>(tokens: readonly Token<T>[]): Token<T> | null =>
  tokens.length === 1 ? tokens[0] : null;

const MONEY_TOKEN =
  /(?<![\p{L}\p{N}_])(?:R\$\s*)?(?:\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[,.]\d{1,2})?)(?![\p{L}\p{N}_])/giu;
function moneyTokens(literal: string): Token<number | null>[] {
  return [...literal.matchAll(MONEY_TOKEN)].map((match) => {
    const start = match.index;
    const text = match[0];
    const end = start + text.length;
    const reais = parseSpokenMoney(text);
    const cents = reais === null ? null : Math.round(reais * 100);
    return {
      start,
      end,
      text,
      value:
        validRange(literal, start, end) &&
        cents !== null &&
        Number.isSafeInteger(cents) &&
        cents >= PRIMITIVES.minPurchaseCents &&
        cents <= PRIMITIVES.maxCents
          ? cents
          : null,
    };
  });
}
function oneMoney(literal: string): Token<number> | null {
  const token = only(moneyTokens(literal));
  return token?.value === null ? null : (token as Token<number> | null);
}

const DATE_TOKEN =
  /(?<![\p{L}\p{N}_])(?:\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})(?![\p{L}\p{N}_])/gu;
function oneDate(literal: string): Token<string> | null {
  const tokens = [...literal.matchAll(DATE_TOKEN)].map((match) => {
    const start = match.index;
    const text = match[0];
    const end = start + text.length;
    const value = text.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1");
    const date = parseInstallmentDateOnlyUtc(value);
    return {
      start,
      end,
      text,
      value:
        validRange(literal, start, end) &&
        date &&
        date.getUTCFullYear() >= PRIMITIVES.minYear &&
        date.getUTCFullYear() <= PRIMITIVES.maxYear
          ? value
          : null,
    };
  });
  const token = only(tokens);
  return token?.value === null ? null : (token as Token<string> | null);
}

function numberToken(
  literal: string,
  field: "installmentCount" | "installmentIndex",
): Token<number> | null {
  const patterns =
    field === "installmentCount"
      ? [/(?<![\p{L}\p{N}_])(\d+)\s*(?:parcelas?|vezes?)(?!\p{L})/giu]
      : [
          /(?<![\p{L}\p{N}_])(\d+)\s*(?:ª|º)\s*parcela(?!\p{L})/giu,
          /\bparcela\s+(?:n[ºo]\s*)?(\d+)(?![\p{L}\p{N}_])/giu,
        ];
  const tokens: Token<number>[] = [];
  for (const pattern of patterns) {
    for (const match of literal.matchAll(pattern)) {
      const text = match[1];
      const offset = match[0].indexOf(text);
      const start = match.index + offset;
      const end = start + text.length;
      const value = Number(text);
      tokens.push({
        start,
        end,
        text,
        value:
          validRange(literal, start, end) &&
          Number.isSafeInteger(value) &&
          value >= 1 &&
          value <= LIMITS.installmentsPerPurchase
            ? value
            : Number.NaN,
      });
    }
  }
  if (!tokens.length) {
    const match = /^\s*(\d+)\s*$/.exec(literal);
    if (match) {
      const text = match[1];
      const start = literal.indexOf(text);
      const value = Number(text);
      tokens.push({
        start,
        end: start + text.length,
        text,
        value:
          Number.isSafeInteger(value) &&
          value >= 1 &&
          value <= LIMITS.installmentsPerPurchase
            ? value
            : Number.NaN,
      });
    }
  }
  const deduplicated = [
    ...new Map(
      tokens.map((token) => [`${token.start}:${token.end}`, token]),
    ).values(),
  ];
  const token = only(deduplicated);
  return token && Number.isFinite(token.value) ? token : null;
}

function oneAmountMeaning(
  literal: string,
): Token<ImportSessionDraftLineV1["amountMeaning"]> | null {
  const candidates: Token<ImportSessionDraftLineV1["amountMeaning"]>[] = [];
  for (const [pattern, value] of [
    [/\btotal\b/giu, ImportSessionAmountMeaning.TOTAL_PURCHASE],
    [/\bparcelas?\b/giu, ImportSessionAmountMeaning.INSTALLMENT_CHARGE],
  ] as const) {
    for (const match of literal.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (validRange(literal, start, end))
        candidates.push({ start, end, text: match[0], value });
    }
  }
  return only(candidates);
}

function exactUniqueSubstring(literal: string, answer: string): boolean {
  if (!answer.length || answer.trim() !== answer) return false;
  const first = literal.indexOf(answer);
  return (
    first >= 0 &&
    validRange(literal, first, first + answer.length) &&
    literal.indexOf(answer, first + answer.length) === -1
  );
}

function parseFocusedAnswer(
  field: ImportSessionDraftQuestionV1["field"] | ImportHumanFactFieldV1,
  value: unknown,
): ImportFocusedAnswerV1 {
  const parsed = parseImportToolArguments("import_edit_answer", value, field);
  if (parsed.name !== "import_edit_answer")
    throw Error("Unexpected tool parser result");
  return parsed.arguments;
}

function deterministicLiteral(
  literal: string,
  field:
    | "amountCents"
    | "installmentCount"
    | "installmentIndex"
    | "dataCompra"
    | "firstDueDate"
    | "amountMeaning",
): Token<number | string> | null {
  switch (field) {
    case "amountCents":
      return oneMoney(literal);
    case "installmentCount":
    case "installmentIndex":
      return numberToken(literal, field);
    case "dataCompra":
    case "firstDueDate":
      return oneDate(literal);
    case "amountMeaning":
      return oneAmountMeaning(literal);
  }
}

/** Resolve an observation answer without trusting a model-provided normalized value. */
export function resolveImportDocumentaryAnswer(
  literal: string,
  field: ImportHumanFactFieldV1,
  unknownAnswerPayload: unknown,
): ResolvedImportDocumentaryAnswerV1 {
  const answer = parseFocusedAnswer(field, unknownAnswerPayload);
  if (answer.kind === "NO_DECISION") return clarify("AMBIGUOUS");
  if (field === "merchant") {
    if (answer.answer === null)
      return unknownAnswer(literal)
        ? { kind: "VALUE", literal: "não sei informar" }
        : clarify("INVALID_VALUE");
    if (
      typeof answer.answer !== "string" ||
      !exactUniqueSubstring(literal, answer.answer)
    )
      return clarify("INVALID_VALUE");
    return { kind: "VALUE", literal: JSON.stringify(answer.answer) };
  }
  const token = deterministicLiteral(literal, field);
  if (!token) return clarify("INVALID_VALUE");
  switch (field) {
    case "amountMeaning":
      return {
        kind: "VALUE",
        literal:
          token.value === ImportSessionAmountMeaning.TOTAL_PURCHASE
            ? "total da compra"
            : "valor da parcela",
      };
    case "dataCompra":
      return { kind: "VALUE", literal: String(token.value) };
    default:
      return { kind: "VALUE", literal: token.text };
  }
}

function targetAmount(
  literal: string,
  target: ImportTargetAnswerV1,
  line: ImportSessionDraftLineV1,
): number | null {
  if (target.amountText === null)
    return line.amountMeaning === ImportSessionAmountMeaning.TOTAL_PURCHASE
      ? line.amountCents
      : null;
  if (!exactUniqueSubstring(literal, target.amountText)) return null;
  const token = oneMoney(target.amountText);
  return token?.start === 0 && token.end === target.amountText.length
    ? token.value
    : null;
}

/**
 * Resolve one focused draft answer. Only the current field is copied into
 * server-owned line clones; original observations and financial identity never change.
 */
export function resolveImportAnswer(
  literal: string,
  field: ImportSessionDraftQuestionV1["field"],
  unknownAnswerPayload: unknown,
  lines: readonly ImportSessionDraftLineV1[],
  references?: ImportAnswerReferences,
): ResolvedImportAnswerV1 {
  const answer = parseFocusedAnswer(field, unknownAnswerPayload);
  if (answer.kind === "NO_DECISION") return clarify("AMBIGUOUS");
  if (!lines.length) return clarify("INVALID_VALUE");
  const result = lines.map((line) => ({ ...line }));
  switch (field) {
    case "amountCents": {
      const token = deterministicLiteral(literal, field);
      if (!token || typeof token.value !== "number")
        return clarify("INVALID_VALUE");
      for (const line of result) line.amountCents = token.value;
      break;
    }
    case "installmentCount": {
      const token = deterministicLiteral(literal, field);
      if (!token || typeof token.value !== "number")
        return clarify("INVALID_VALUE");
      for (const line of result) line.installmentCount = token.value;
      break;
    }
    case "dataCompra":
    case "firstDueDate": {
      const token = deterministicLiteral(literal, field);
      if (!token || typeof token.value !== "string")
        return clarify("INVALID_VALUE");
      for (const line of result) line[field] = token.value;
      break;
    }
    case "amountMeaning": {
      const token = deterministicLiteral(literal, field);
      if (
        !token ||
        (token.value !== ImportSessionAmountMeaning.TOTAL_PURCHASE &&
          token.value !== ImportSessionAmountMeaning.INSTALLMENT_CHARGE)
      )
        return clarify("INVALID_VALUE");
      for (const line of result) line.amountMeaning = token.value;
      break;
    }
    case "decision": {
      if (typeof answer.answer !== "string") return clarify("INVALID_VALUE");
      if (answer.answer === IMPORT_DECISION_ANSWER.UNRESOLVED) {
        if (!unknownAnswer(literal)) return clarify("AMBIGUOUS");
        for (const line of result)
          line.decision = { kind: IMPORT_DECISION_ANSWER.UNRESOLVED };
        break;
      }
      if (
        answer.answer === IMPORT_DECISION_ANSWER.CREATE ||
        answer.answer === IMPORT_DECISION_ANSWER.CREATE_ACCEPT_NATURAL_DUPLICATE
      ) {
        if (
          words(literal) === "sim" ||
          !/\b(?:criar|nova?|novo)\b/.test(normalized(literal))
        )
          return clarify("AMBIGUOUS");
        const accepts =
          answer.answer ===
          IMPORT_DECISION_ANSWER.CREATE_ACCEPT_NATURAL_DUPLICATE;
        if (
          accepts &&
          !/\bcompras? (?:diferentes|distintas|separadas)\b/.test(
            normalized(literal),
          )
        )
          return clarify("AMBIGUOUS");
        for (const line of result)
          line.decision = {
            kind: IMPORT_DECISION_ANSWER.CREATE,
            acceptNaturalDuplicate: accepts,
          };
        break;
      }
      const expenseId = answer.answer;
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
      for (const line of result)
        line.decision = {
          kind: "KEEP_EXISTING",
          expenseId,
        };
      break;
    }
    case "targets": {
      const targetAnswer = answer.answer;
      if (targetAnswer === null) {
        if (!unknownAnswer(literal)) return clarify("AMBIGUOUS");
        for (const line of result) line.targets = null;
        break;
      }
      if (targetAnswer === "NO_TARGETS") {
        if (!/\bsem (?:destino|rateio)\b/.test(normalized(literal)))
          return clarify("AMBIGUOUS");
        for (const line of result) line.targets = [];
        break;
      }
      if (!Array.isArray(targetAnswer)) return clarify("INVALID_VALUE");
      for (const target of targetAnswer) {
        const project = references?.projects.find(
          (project) => project.id === target.projectId,
        );
        if (
          !project ||
          !mentioned(literal, project.name) ||
          references?.projects.some(
            (other) =>
              (other.id !== project.id &&
                words(other.name) === words(project.name)) ||
              words(other.id) === words(project.name),
          )
        )
          return clarify("AMBIGUOUS");
        if (target.roomId !== null) {
          const room = project.rooms.find((room) => room.id === target.roomId);
          if (
            !room ||
            !mentioned(literal, room.name) ||
            project.rooms.some(
              (other) =>
                other.id !== room.id && words(other.name) === words(room.name),
            )
          )
            return clarify("AMBIGUOUS");
        }
      }
      for (const line of result) {
        const targets = targetAnswer.map((target) => ({
          projectId: target.projectId,
          roomId: target.roomId,
          amountCents: targetAmount(literal, target, line),
        }));
        if (
          targets.some(
            (target) => target.amountCents === null || target.amountCents <= 0,
          )
        )
          return clarify("INVALID_VALUE");
        line.targets = targets as ImportSessionDraftLineV1["targets"];
      }
      break;
    }
    case "tipoDespesa":
      if (answer.answer === null && !unknownAnswer(literal))
        return clarify("AMBIGUOUS");
      for (const line of result)
        line.tipoDespesa =
          answer.answer as ImportSessionDraftLineV1["tipoDespesa"];
      break;
    case "categoriaMaoDeObra":
      if (answer.answer === null && !unknownAnswer(literal))
        return clarify("AMBIGUOUS");
      for (const line of result)
        line.categoriaMaoDeObra =
          answer.answer as ImportSessionDraftLineV1["categoriaMaoDeObra"];
      break;
  }
  return { kind: "VALUE", lines: result };
}
