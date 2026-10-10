import {
  ExpenseType,
  IMPORT_SESSION_LIMITS as LIMITS,
  IMPORT_SESSION_PRIMITIVES as PRIMITIVES,
  IMPORT_SESSION_PROTOCOL_VERSION,
  ImportSessionAmountMeaning,
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
type Field = ImportSessionQuestionV1["field"];
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
const DATE = new RegExp(PRIMITIVES.dateOnlyPattern);

export type ImportChatRead =
  | { kind: "SESSION" }
  | { kind: "OBSERVATIONS"; pageIndex: number }
  | { kind: "CANDIDATES"; lineId: string; pageIndex: number }
  | { kind: "PROJECTS"; pageIndex: number }
  | { kind: "PAYMENT_METHODS" }
  | { kind: "TAXONOMY" };

export type ImportLiteralSpanV1 = { start: number; end: number };
export type ImportMoneyLiteralV1 = { span: ImportLiteralSpanV1; text: string };
export type ImportTargetAnswerV1 = {
  projectId: string;
  roomId: string | null;
  amount: ImportMoneyLiteralV1 | { kind: "SOURCE_TOTAL" };
};
type AnswerValues = {
  amountMeaning: ImportSessionDraftLineV1["amountMeaning"];
  amountCents: ImportMoneyLiteralV1 | null;
  installmentCount: ImportSessionDraftLineV1["installmentCount"];
  merchant: string | null;
  installmentIndex: number | null;
  dataCompra: ImportSessionDraftLineV1["dataCompra"];
  firstDueDate: ImportSessionDraftLineV1["firstDueDate"];
  tipoDespesa: ImportSessionDraftLineV1["tipoDespesa"];
  categoriaMaoDeObra: ImportSessionDraftLineV1["categoriaMaoDeObra"];
  decision: ImportSessionDecisionV1;
  targets:
    | null
    | { kind: "NO_TARGETS" }
    | { kind: "TARGETS"; items: ImportTargetAnswerV1[] };
};
export type ImportAnswerInterpretationV1 =
  | {
      [F in Field]: {
        kind: "VALUE";
        field: F;
        evidence: ImportLiteralSpanV1;
        value: AnswerValues[F];
      };
    }[Field]
  | { kind: "AMBIGUOUS" | "INVALID" | "UNSUPPORTED_NORMALIZATION" }
  | { kind: "MULTI_FIELD"; fields: Field[] };

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
      arguments: { interpretation: ImportAnswerInterpretationV1 };
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
const span = (value: unknown): value is ImportLiteralSpanV1 =>
  record(value) &&
  exact(value, ["start", "end"]) &&
  integer(value.start) &&
  integer(value.end) &&
  value.end > value.start;
const money = (value: unknown): value is ImportMoneyLiteralV1 =>
  record(value) &&
  exact(value, ["span", "text"]) &&
  span(value.span) &&
  typeof value.text === "string" &&
  value.text.length > 0 &&
  value.text.length <= MAX_LITERAL_LENGTH;

function decision(value: unknown): value is ImportSessionDecisionV1 {
  if (!record(value)) return false;
  switch (value.kind) {
    case "UNRESOLVED":
      return exact(value, ["kind"]);
    case "CREATE":
      return (
        exact(value, ["kind", "acceptNaturalDuplicate"]) &&
        typeof value.acceptNaturalDuplicate === "boolean"
      );
    case "KEEP_EXISTING":
      return exact(value, ["kind", "expenseId"]) && id(value.expenseId);
    default:
      return false;
  }
}
function target(value: unknown): value is ImportTargetAnswerV1 {
  return (
    record(value) &&
    exact(value, ["projectId", "roomId", "amount"]) &&
    id(value.projectId) &&
    (value.roomId === null || id(value.roomId)) &&
    (money(value.amount) ||
      (record(value.amount) &&
        exact(value.amount, ["kind"]) &&
        value.amount.kind === "SOURCE_TOTAL"))
  );
}
function answerValue(field: Field, value: unknown): boolean {
  switch (field) {
    case "amountMeaning":
      return member(value, Object.values(ImportSessionAmountMeaning));
    case "amountCents":
      return value === null || money(value);
    case "installmentCount":
    case "installmentIndex":
      return (
        value === null || integer(value, 1, LIMITS.installmentsPerPurchase)
      );
    case "merchant":
      return (
        value === null ||
        (typeof value === "string" &&
          value.length > 0 &&
          value.length <= PRIMITIVES.maxSupplierLength)
      );
    case "dataCompra":
    case "firstDueDate":
      return value === null || (typeof value === "string" && DATE.test(value));
    case "tipoDespesa":
      return value === null || member(value, Object.values(ExpenseType));
    case "categoriaMaoDeObra":
      return value === null || member(value, Object.values(LaborCategory));
    case "decision":
      return decision(value);
    case "targets":
      return (
        value === null ||
        (record(value) &&
          ((value.kind === "NO_TARGETS" && exact(value, ["kind"])) ||
            (value.kind === "TARGETS" &&
              exact(value, ["kind", "items"]) &&
              Array.isArray(value.items) &&
              value.items.length > 0 &&
              value.items.length <= LIMITS.targetsPerPurchase &&
              everySlot(value.items, target) &&
              new Set(value.items.map((item) => item.projectId)).size ===
                value.items.length)))
      );
  }
}
function interpretation(value: unknown): value is ImportAnswerInterpretationV1 {
  if (!record(value)) return false;
  switch (value.kind) {
    case "AMBIGUOUS":
    case "INVALID":
    case "UNSUPPORTED_NORMALIZATION":
      return exact(value, ["kind"]);
    case "MULTI_FIELD":
      return (
        exact(value, ["kind", "fields"]) &&
        Array.isArray(value.fields) &&
        value.fields.length >= 2 &&
        value.fields.length <= FIELDS.length &&
        everySlot(value.fields, (field): field is Field =>
          member(field, FIELDS),
        ) &&
        new Set(value.fields).size === value.fields.length
      );
    case "VALUE":
      return (
        exact(value, ["kind", "field", "evidence", "value"]) &&
        member(value.field, FIELDS) &&
        span(value.evidence) &&
        answerValue(value.field, value.value)
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
      if (
        !record(args) ||
        !exact(args, ["interpretation"]) ||
        !interpretation(args.interpretation)
      )
        invalid();
      return {
        name,
        arguments: { interpretation: structuredClone(args.interpretation) },
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
const spanSchema = objectSchema({
  start: pageSchema,
  end: { ...pageSchema, minimum: 1 },
});
const moneySchema = objectSchema({
  span: spanSchema,
  text: { type: "string", minLength: 1, maxLength: MAX_LITERAL_LENGTH },
});
const decisionSchema = {
  anyOf: [
    objectSchema({ kind: literal("UNRESOLVED") }),
    objectSchema({
      kind: literal("CREATE"),
      acceptNaturalDuplicate: { type: "boolean" },
    }),
    objectSchema({ kind: literal("KEEP_EXISTING"), expenseId: idSchema }),
  ],
};
const valueSchemas: Record<Field, Record<string, unknown>> = {
  amountMeaning: {
    type: "string",
    enum: Object.values(ImportSessionAmountMeaning),
  },
  amountCents: nullable(moneySchema),
  merchant: nullable({
    type: "string",
    minLength: 1,
    maxLength: PRIMITIVES.maxSupplierLength,
  }),
  installmentIndex: nullable({
    type: "integer",
    minimum: 1,
    maximum: LIMITS.installmentsPerPurchase,
  }),
  installmentCount: nullable({
    type: "integer",
    minimum: 1,
    maximum: LIMITS.installmentsPerPurchase,
  }),
  dataCompra: nullable({ type: "string", pattern: PRIMITIVES.dateOnlyPattern }),
  firstDueDate: nullable({
    type: "string",
    pattern: PRIMITIVES.dateOnlyPattern,
  }),
  tipoDespesa: nullable({ type: "string", enum: Object.values(ExpenseType) }),
  categoriaMaoDeObra: nullable({
    type: "string",
    enum: Object.values(LaborCategory),
  }),
  decision: decisionSchema,
  targets: nullable({
    anyOf: [
      objectSchema({ kind: literal("NO_TARGETS") }),
      objectSchema({
        kind: literal("TARGETS"),
        items: {
          type: "array",
          minItems: 1,
          maxItems: LIMITS.targetsPerPurchase,
          items: objectSchema({
            projectId: idSchema,
            roomId: nullable(idSchema),
            amount: {
              anyOf: [
                moneySchema,
                objectSchema({ kind: literal("SOURCE_TOTAL") }),
              ],
            },
          }),
        },
      }),
    ],
  }),
};
const interpretationSchema = {
  anyOf: [
    ...["AMBIGUOUS", "INVALID", "UNSUPPORTED_NORMALIZATION"].map((kind) =>
      objectSchema({ kind: literal(kind) }),
    ),
    objectSchema({
      kind: literal("MULTI_FIELD"),
      fields: {
        type: "array",
        minItems: 2,
        maxItems: FIELDS.length,
        uniqueItems: true,
        items: { type: "string", enum: FIELDS },
      },
    }),
    ...FIELDS.map((field) =>
      objectSchema({
        kind: literal("VALUE"),
        field: literal(field),
        evidence: spanSchema,
        value: valueSchemas[field],
      }),
    ),
  ],
};
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
      "Propose a single-field interpretation, not financial confirmation or permission to write.",
    parameters: objectSchema({ interpretation: interpretationSchema }),
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
export function getImportToolDefinitions(turn: ImportChatTurnV1): ToolDef[] {
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
  if (!turn.focus || !member(turn.focus.field, FIELDS)) invalid();
  const names: ToolName[] = [
    "import_read_session",
    "import_read_observations",
    "list_payment_methods",
  ];
  switch (turn.focus.field) {
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
  return names.map((name) => structuredClone(DEFINITIONS[name]));
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
