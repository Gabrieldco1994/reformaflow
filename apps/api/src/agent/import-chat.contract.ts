import {
  ExpenseType,
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  LaborCategory,
  type ImportChatTurnV1,
  type ImportSessionCandidateV1,
  type ImportSessionDecisionV1,
  type ImportSessionDraftLineV1,
  type ImportSessionObservationViewV1,
  type ImportSessionQuestionV1,
  type ImportSessionState,
  type ProjectType,
} from "@reformaflow/domain";
import type { ToolDef } from "./llm/llm.types";

/**
 * Private, inactive data contract. No consumer, admission, paging cursor, provider or writer
 * is registered here. Structural validity is not literal evidence, access or permission to edit.
 */
export type ImportAnswerFieldV1 = ImportSessionQuestionV1["field"];
type Field = ImportAnswerFieldV1;
const FIELDS: readonly Field[] = [
  "amountMeaning",
  "amountCents",
  "installmentCount",
  "merchant",
  "installmentIndex",
  "dataCompra",
  "firstDueDate",
  "targets",
  "decision",
  "tipoDespesa",
  "categoriaMaoDeObra",
];
const MAX_LITERAL_LENGTH = 4000;
const ID = new RegExp(PRIMITIVES.idPattern);

export type ImportChatRead =
  | { kind: "SESSION" }
  | { kind: "OBSERVATIONS"; pageIndex: number }
  | { kind: "CANDIDATES"; lineId: string; pageIndex: number }
  | { kind: "PROJECTS"; pageIndex: number }
  | { kind: "PAYMENT_METHODS" }
  | { kind: "TAXONOMY" };

export type ImportTargetAnswerV1 = {
  projectId: string;
  roomId: string | null;
  amountText: string | null;
};
export const IMPORT_DECISION_ANSWER = Object.freeze({
  UNRESOLVED: "UNRESOLVED",
  CREATE: "CREATE",
  CREATE_ACCEPT_NATURAL_DUPLICATE: "CREATE_ACCEPT_NATURAL_DUPLICATE",
});
export type ImportDecisionAnswerV1 =
  | (typeof IMPORT_DECISION_ANSWER)[keyof typeof IMPORT_DECISION_ANSWER]
  | string;
type AnswerValues = {
  amountMeaning: null;
  amountCents: null;
  installmentCount: null;
  merchant: string | null;
  installmentIndex: null;
  dataCompra: null;
  firstDueDate: null;
  tipoDespesa: ImportSessionDraftLineV1["tipoDespesa"];
  categoriaMaoDeObra: ImportSessionDraftLineV1["categoriaMaoDeObra"];
  decision: ImportDecisionAnswerV1;
  targets: null | "NO_TARGETS" | ImportTargetAnswerV1[];
};
export type ImportFocusedAnswerV1 =
  | { kind: "NO_DECISION"; answer: null }
  | { kind: "VALUE"; answer: AnswerValues[Field] };

export type ImportToolArguments =
  | {
      name:
        | "import_read_session"
        | "list_payment_methods"
        | "get_category_taxonomy"
        | "import_prepare_session";
      arguments: Record<string, never>;
    }
  | {
      name: "import_read_observations" | "list_projects";
      arguments: { pageIndex: number };
    }
  | {
      name: "import_read_candidates";
      arguments: { lineId: string; pageIndex: number };
    }
  | {
      name: "import_edit_answer";
      arguments: ImportFocusedAnswerV1;
    };
type ToolName = ImportToolArguments["name"];

export class ImportChatContractError extends Error {
  constructor(
    readonly code:
      | "MODEL_OUTPUT_INVALID"
      | "TOOL_NOT_ALLOWED"
      | "LIMIT_EXCEEDED",
  ) {
    super(code);
    this.name = "ImportChatContractError";
  }
}
function invalid(): never {
  throw new ImportChatContractError("MODEL_OUTPUT_INVALID");
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const exact = (
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean =>
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
const integer = (
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): value is number =>
  typeof value === "number" &&
  Number.isSafeInteger(value) &&
  value >= min &&
  value <= max;
const id = (value: unknown): value is string =>
  typeof value === "string" && ID.exec(value)?.[0] === value;
const member = <T extends string>(
  value: unknown,
  values: readonly T[],
): value is T =>
  typeof value === "string" && values.some((candidate) => candidate === value);
function everySlot<T>(
  values: unknown[],
  matches: (value: unknown) => value is T,
): values is T[] {
  // Unlike Array.every, iteration visits holes as undefined so they cannot pass validation.
  for (const value of values) {
    if (!matches(value)) return false;
  }
  return true;
}
function target(value: unknown): value is ImportTargetAnswerV1 {
  return (
    record(value) &&
    exact(value, ["projectId", "roomId", "amountText"]) &&
    id(value.projectId) &&
    (value.roomId === null || id(value.roomId)) &&
    (value.amountText === null ||
      (typeof value.amountText === "string" &&
        value.amountText.length > 0 &&
        value.amountText.length <= MAX_LITERAL_LENGTH))
  );
}
function answerValue(field: Field, value: unknown): boolean {
  switch (field) {
    case "amountMeaning":
    case "amountCents":
    case "installmentCount":
    case "installmentIndex":
    case "dataCompra":
    case "firstDueDate":
      return value === null;
    case "merchant":
      return (
        value === null ||
        (typeof value === "string" &&
          value.length > 0 &&
          value.length <= PRIMITIVES.maxSupplierLength)
      );
    case "tipoDespesa":
      return value === null || member(value, Object.values(ExpenseType));
    case "categoriaMaoDeObra":
      return value === null || member(value, Object.values(LaborCategory));
    case "decision":
      return id(value);
    case "targets":
      return (
        value === null ||
        value === "NO_TARGETS" ||
        (Array.isArray(value) &&
          value.length > 0 &&
          value.length <= LIMITS.targetsPerPurchase &&
          everySlot(value, target) &&
          new Set(
            value.flatMap((item) =>
              item.roomId === null
                ? [item.projectId]
                : [item.projectId, item.roomId],
            ),
          ).size ===
            value.reduce(
              (count, item) => count + (item.roomId === null ? 1 : 2),
              0,
            ))
      );
  }
}
function focusedAnswer(
  field: Field,
  value: unknown,
): value is ImportFocusedAnswerV1 {
  if (!record(value)) return false;
  switch (value.kind) {
    case "NO_DECISION":
      return exact(value, ["kind", "answer"]) && value.answer === null;
    case "VALUE":
      return (
        exact(value, ["kind", "answer"]) && answerValue(field, value.answer)
      );
    default:
      return false;
  }
}

/**
 * Validates shapes only. Documentary values are not authoritative: their writer parses the
 * authenticated whole literal. Draft answers retain their literal/catalog validation boundary.
 */
export function parseImportToolArguments(
  name: string,
  args: unknown,
  focus?: Field,
): ImportToolArguments {
  switch (name) {
    case "import_read_session":
    case "list_payment_methods":
    case "get_category_taxonomy":
    case "import_prepare_session":
      if (!record(args) || !exact(args, [])) invalid();
      return { name, arguments: {} };
    case "import_read_observations":
    case "list_projects":
      if (
        !record(args) ||
        !exact(args, ["pageIndex"]) ||
        !integer(args.pageIndex)
      )
        invalid();
      return { name, arguments: { pageIndex: args.pageIndex } };
    case "import_read_candidates":
      if (
        !record(args) ||
        !exact(args, ["lineId", "pageIndex"]) ||
        !id(args.lineId) ||
        !integer(args.pageIndex)
      )
        invalid();
      return {
        name,
        arguments: { lineId: args.lineId, pageIndex: args.pageIndex },
      };
    case "import_edit_answer":
      if (!focus || !record(args) || !focusedAnswer(focus, args)) invalid();
      if (args.kind === "NO_DECISION")
        return { name, arguments: { kind: args.kind, answer: null } };
      return {
        name,
        arguments: {
          kind: args.kind,
          answer: Array.isArray(args.answer)
            ? args.answer.map((item) => ({
                projectId: item.projectId,
                roomId: item.roomId,
                amountText: item.amountText,
              }))
            : args.answer,
        },
      };
    default:
      throw new ImportChatContractError("TOOL_NOT_ALLOWED");
  }
}

const objectSchema = (
  properties: Record<string, unknown>,
): Record<string, unknown> => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const literal = (value: string) => ({ type: "string", enum: [value] });
const nullable = (schema: Record<string, unknown>) => ({
  anyOf: [schema, { type: "null" }],
});
const idSchema = { type: "string", pattern: PRIMITIVES.idPattern };
const pageSchema = {
  type: "integer",
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
};
const valueSchemas: Record<Field, Record<string, unknown>> = {
  amountMeaning: { type: "null" },
  amountCents: { type: "null" },
  merchant: nullable({
    type: "string",
    minLength: 1,
    maxLength: PRIMITIVES.maxSupplierLength,
  }),
  installmentIndex: { type: "null" },
  installmentCount: { type: "null" },
  dataCompra: { type: "null" },
  firstDueDate: { type: "null" },
  tipoDespesa: nullable({ type: "string", enum: Object.values(ExpenseType) }),
  categoriaMaoDeObra: nullable({
    type: "string",
    enum: Object.values(LaborCategory),
  }),
  decision: idSchema,
  targets: {
    anyOf: [
      { type: "null" },
      literal("NO_TARGETS"),
      {
        type: "array",
        minItems: 1,
        maxItems: LIMITS.targetsPerPurchase,
        uniqueItems: true,
        items: objectSchema({
          projectId: idSchema,
          roomId: nullable(idSchema),
          amountText: nullable({
            type: "string",
            minLength: 1,
            maxLength: MAX_LITERAL_LENGTH,
          }),
        }),
      },
    ],
  },
};
const focusedAnswerSchema = (field: Field) => ({
  anyOf: [
    objectSchema({
      kind: literal("NO_DECISION"),
      answer: { type: "null" },
    }),
    objectSchema({
      kind: literal("VALUE"),
      answer: valueSchemas[field],
    }),
  ],
});
const DEFINITIONS: Record<ToolName, ToolDef> = {
  import_read_session: {
    name: "import_read_session",
    description: "Read the authorized focused import draft.",
    parameters: objectSchema({}),
  },
  import_read_observations: {
    name: "import_read_observations",
    description: "Read an authorized page of focused observations.",
    parameters: objectSchema({ pageIndex: pageSchema }),
  },
  import_read_candidates: {
    name: "import_read_candidates",
    description:
      "Read candidates for an authorized focused line; a page is not proof of complete search.",
    parameters: objectSchema({ lineId: idSchema, pageIndex: pageSchema }),
  },
  list_projects: {
    name: "list_projects",
    description:
      "Read visible project options, not a grant of target eligibility.",
    parameters: objectSchema({ pageIndex: pageSchema }),
  },
  list_payment_methods: {
    name: "list_payment_methods",
    description: "Read only the card bound to the import session.",
    parameters: objectSchema({}),
  },
  get_category_taxonomy: {
    name: "get_category_taxonomy",
    description: "Read the expense types and labor category catalog.",
    parameters: objectSchema({}),
  },
  import_edit_answer: {
    name: "import_edit_answer",
    description:
      "Answer only the authenticated current focus; this grants no financial confirmation or write permission.",
    parameters: objectSchema({}),
  },
  import_prepare_session: {
    name: "import_prepare_session",
    description: "Deterministic review operation; never offered to the model.",
    parameters: objectSchema({}),
  },
};

/**
 * Selects definitions only AFTER the caller resolves live admission, E and exact scope.
 * Scope expansion is handled before this helper; this does not compute eligibility/actions.
 */
export function getImportToolDefinitions(
  turn: ImportChatTurnV1,
  authenticatedFocusField?: Field,
): ToolDef[] {
  switch (turn.intent) {
    case "CONTINUE":
    case "OPEN_REVIEW":
    case "READ_RESULT":
      if (turn.focus !== null || turn.scope !== null) invalid();
      return [];
    case "ANSWER":
    case "APPROVE_ATTACHMENT_SCOPE":
      break;
    default:
      return invalid();
  }
  const focusField = authenticatedFocusField ?? turn.focus?.field;
  if (!turn.focus || !member(focusField, FIELDS)) invalid();
  const names: ToolName[] = [
    "import_read_session",
    "import_read_observations",
    "list_payment_methods",
  ];
  switch (focusField) {
    case "targets":
      names.push("list_projects");
      break;
    case "tipoDespesa":
    case "categoriaMaoDeObra":
      names.push("get_category_taxonomy");
      break;
    case "decision":
      names.push("import_read_candidates");
      break;
  }
  names.push("import_edit_answer");
  return names.map((name) => {
    const definition = structuredClone(DEFINITIONS[name]);
    if (name === "import_edit_answer")
      definition.parameters = focusedAnswerSchema(focusField);
    return definition;
  });
}

export type ImportModelPage<T> = {
  pageIndex: number;
  items: T[];
  hasMore: boolean;
};
export type ImportModelLineV1 = Pick<
  ImportSessionDraftLineV1,
  | "id"
  | "titulo"
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "dataCompra"
  | "firstDueDate"
  | "targets"
  | "decision"
  | "tipoDespesa"
  | "categoriaMaoDeObra"
>;
export type ImportModelObservationV1 = { lineId: string } & Pick<
  ImportSessionObservationViewV1,
  | "id"
  | "attachmentId"
  | "reference"
  | "amountMeaning"
  | "amountCents"
  | "installmentCount"
  | "installmentIndex"
  | "dataCompra"
>;
export type ImportModelRead = {
  version: typeof IMPORT_SESSION_PROTOCOL_VERSION;
} & (
  | {
      kind: "SESSION";
      state: ImportSessionState;
      revision: number;
      focus: ImportSessionQuestionV1 | null;
      lines: ImportModelLineV1[];
    }
  | ({ kind: "OBSERVATIONS" } & ImportModelPage<ImportModelObservationV1>)
  | ({
      kind: "CANDIDATES";
      searchComplete: boolean;
    } & ImportModelPage<ImportSessionCandidateV1>)
  | ({ kind: "PROJECTS" } & ImportModelPage<{
      id: string;
      name: string;
      type: ProjectType;
    }>)
  | {
      kind: "PAYMENT_METHODS";
      card: {
        id: string;
        nickname: string | null;
        institution: string | null;
        last4: string | null;
      };
    }
  | {
      kind: "TAXONOMY";
      expenseTypes: { value: ExpenseType; label: string; synonyms: string[] }[];
      laborCategories: LaborCategory[];
    }
);

function bounded<T>(items: readonly T[], maximum: number): readonly T[] {
  if (items.length > maximum)
    throw new ImportChatContractError("LIMIT_EXCEEDED");
  return items;
}
function projectDecision(
  input: ImportSessionDecisionV1,
): ImportSessionDecisionV1 {
  switch (input.kind) {
    case "UNRESOLVED":
      return { kind: "UNRESOLVED" };
    case "CREATE":
      return {
        kind: "CREATE",
        acceptNaturalDuplicate: input.acceptNaturalDuplicate,
      };
    case "KEEP_EXISTING":
      return { kind: "KEEP_EXISTING", expenseId: input.expenseId };
    default:
      return invalid();
  }
}
function projectLine(line: ImportModelLineV1): ImportModelLineV1 {
  return {
    id: line.id,
    titulo: line.titulo,
    amountMeaning: line.amountMeaning,
    amountCents: line.amountCents,
    installmentCount: line.installmentCount,
    dataCompra: line.dataCompra,
    firstDueDate: line.firstDueDate,
    tipoDespesa: line.tipoDespesa,
    categoriaMaoDeObra: line.categoriaMaoDeObra,
    targets:
      line.targets === null
        ? null
        : bounded(line.targets, LIMITS.targetsPerPurchase).map((target) => ({
            projectId: target.projectId,
            roomId: target.roomId,
            amountCents: target.amountCents,
          })),
    decision: projectDecision(line.decision),
  };
}
function pageMetadata(input: ImportModelPage<unknown>) {
  if (!integer(input.pageIndex) || typeof input.hasMore !== "boolean")
    invalid();
  bounded(input.items, LIMITS.pageSize);
  return { pageIndex: input.pageIndex, hasMore: input.hasMore };
}

/**
 * Picks only model-visible data from ALREADY authorized, validated and scope-cut inputs.
 * The caller owns complete attachment enumeration, current ACL/revision, candidate eligibility
 * and cursor sequencing. No projection here certifies absence, a receipt or financial success.
 */
function projectQuestion(
  question: ImportSessionQuestionV1,
): ImportSessionQuestionV1 {
  const common = { id: question.id, text: question.text };
  if (!("subject" in question))
    return {
      ...common,
      field: question.field,
      lineIds: [...bounded(question.lineIds, LIMITS.editableLines)],
    };
  if (question.lineIds.length !== 1) invalid();
  const lineIds: [string] = [question.lineIds[0]];
  const base = { ...common, lineIds, answerState: question.answerState };
  if (question.field === "amountCents")
    return {
      ...base,
      field: question.field,
      subject: {
        kind: "OBSERVATION",
        observationId: question.subject.observationId,
        meaningContext: question.subject.meaningContext,
      },
    };
  return {
    ...base,
    field: question.field,
    subject: {
      kind: "OBSERVATION",
      observationId: question.subject.observationId,
      meaningContext: null,
    },
  };
}

export function projectImportModelRead<T extends ImportModelRead>(
  input: T,
): ImportModelRead {
  if (input.version !== IMPORT_SESSION_PROTOCOL_VERSION) invalid();
  const version = IMPORT_SESSION_PROTOCOL_VERSION;
  let result: ImportModelRead;
  switch (input.kind) {
    case "SESSION":
      result = {
        version,
        kind: "SESSION",
        state: input.state,
        revision: input.revision,
        focus: input.focus === null ? null : projectQuestion(input.focus),
        lines: bounded(input.lines, LIMITS.editableLines).map(projectLine),
      };
      break;
    case "OBSERVATIONS":
      result = {
        version,
        kind: "OBSERVATIONS",
        ...pageMetadata(input),
        items: input.items.map((item) => ({
          id: item.id,
          lineId: item.lineId,
          attachmentId: item.attachmentId,
          reference: item.reference,
          amountMeaning: item.amountMeaning,
          amountCents: item.amountCents,
          installmentCount: item.installmentCount,
          installmentIndex: item.installmentIndex,
          dataCompra: item.dataCompra,
        })),
      };
      break;
    case "CANDIDATES":
      result = {
        version,
        kind: "CANDIDATES",
        ...pageMetadata(input),
        searchComplete: input.searchComplete,
        items: input.items.map((item) => ({
          id: item.id,
          lineId: item.lineId,
          kind: item.kind,
          projectId: item.projectId,
          description: item.description,
          amountCents: item.amountCents,
          date: item.date,
          reason: item.reason,
          canKeepExisting: item.canKeepExisting,
        })),
      };
      break;
    case "PROJECTS":
      result = {
        version,
        kind: "PROJECTS",
        ...pageMetadata(input),
        items: input.items.map((item) => ({
          id: item.id,
          name: item.name,
          type: item.type,
        })),
      };
      break;
    case "PAYMENT_METHODS":
      result = {
        version,
        kind: "PAYMENT_METHODS",
        card: {
          id: input.card.id,
          nickname: input.card.nickname,
          institution: input.card.institution,
          last4: input.card.last4,
        },
      };
      break;
    case "TAXONOMY":
      result = {
        version,
        kind: "TAXONOMY",
        expenseTypes: input.expenseTypes.map((item) => ({
          value: item.value,
          label: item.label,
          synonyms: [...item.synonyms],
        })),
        laborCategories: [...input.laborCategories],
      };
      break;
    default:
      return invalid();
  }
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    LIMITS.jsonBytesPerDraftOrProposal
  )
    throw new ImportChatContractError("LIMIT_EXCEEDED");
  return result;
}
