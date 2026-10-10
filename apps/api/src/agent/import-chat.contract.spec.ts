import {
  ExpenseType,
  IMPORT_SESSION_LIMITS,
  LaborCategory,
  ProjectType,
  type ImportChatTurnV1,
  type ImportSessionQuestionV1,
} from "@reformaflow/domain";
import {
  getImportToolDefinitions,
  ImportChatContractError,
  parseImportToolArguments,
  projectImportModelRead,
  type ImportModelRead,
} from "./import-chat.contract";

type Field = ImportSessionQuestionV1["field"];
const evidence = { start: 0, end: 6 };
const money = { span: evidence, text: "206,96" };
const secret = "PRIVATE-SENTINEL-NEVER-TO-MODEL";
const answer = (
  field: Field,
): Extract<ImportChatTurnV1, { intent: "ANSWER" }> => ({
  version: 1,
  turnId: "123e4567-e89b-42d3-a456-426614174000",
  sessionId: "session-1",
  expectedRevision: 7,
  channel: "TEXT",
  literalAnswer: "sim",
  intent: "ANSWER",
  focus: { id: "question-1", field, lineIds: ["line-1"] },
  scope: { kind: "LINES", lineIds: ["line-1"] },
});
const baseNames = [
  "import_read_session",
  "import_read_observations",
  "list_payment_methods",
  "import_edit_answer",
];
const value = (field: Field, fieldValue: unknown) => ({
  interpretation: { kind: "VALUE", field, evidence, value: fieldValue },
});
function rejected(run: () => unknown, code: string): void {
  expect(run).toThrow(ImportChatContractError);
  expect(run).toThrow(expect.objectContaining({ code, message: code }));
}

describe("P08 private, inactive structural tool contract", () => {
  it.each<[Field, string[]]>([
    ["amountMeaning", baseNames],
    ["amountCents", baseNames],
    ["installmentCount", baseNames],
    ["dataCompra", baseNames],
    ["firstDueDate", baseNames],
    [
      "targets",
      [
        "import_read_session",
        "import_read_observations",
        "list_payment_methods",
        "list_projects",
        "import_edit_answer",
      ],
    ],
    [
      "tipoDespesa",
      [
        "import_read_session",
        "import_read_observations",
        "list_payment_methods",
        "get_category_taxonomy",
        "import_edit_answer",
      ],
    ],
    [
      "categoriaMaoDeObra",
      [
        "import_read_session",
        "import_read_observations",
        "list_payment_methods",
        "get_category_taxonomy",
        "import_edit_answer",
      ],
    ],
    [
      "decision",
      [
        "import_read_session",
        "import_read_observations",
        "list_payment_methods",
        "import_read_candidates",
        "import_edit_answer",
      ],
    ],
  ])(
    "offers the literal field-specific set for %s, not a generic registry",
    (field, names) => {
      const turn = answer(field);
      for (const channel of ["TEXT", "VOICE"] as const) {
        expect(
          getImportToolDefinitions({ ...turn, channel }).map(
            (tool) => tool.name,
          ),
        ).toEqual(names);
        expect(
          getImportToolDefinitions({
            ...turn,
            channel,
            intent: "APPROVE_ATTACHMENT_SCOPE",
            scope: {
              kind: "ATTACHMENT",
              attachmentId: "attachment-1",
              approvedLineIds: ["line-1"],
            },
          }).map((tool) => tool.name),
        ).toEqual(names);
      }
    },
  );

  it.each(["CONTINUE", "OPEN_REVIEW", "READ_RESULT"] as const)(
    "%s has no model tools, including prepare",
    (intent) => {
      expect(
        getImportToolDefinitions({
          ...answer("amountCents"),
          intent,
          focus: null,
          scope: null,
        }),
      ).toEqual([]);
    },
  );

  it("does not reinterpret focused sim, and returns isolated definitions", () => {
    const turn = answer("decision");
    const definitions = getImportToolDefinitions(turn);
    expect(definitions.map((tool) => tool.name)).toEqual([
      "import_read_session",
      "import_read_observations",
      "list_payment_methods",
      "import_read_candidates",
      "import_edit_answer",
    ]);
    const first = definitions[0];
    if (!first) throw new Error("Expected a read definition");
    first.parameters["additionalProperties"] = true;
    expect(
      getImportToolDefinitions(turn)[0]?.parameters["additionalProperties"],
    ).toBe(false);
  });

  it("publishes closed schemas with the exact arguments of the offered tools", () => {
    const definitions = [
      ...getImportToolDefinitions(answer("targets")),
      ...getImportToolDefinitions(answer("decision")),
      ...getImportToolDefinitions(answer("tipoDespesa")),
    ];
    const expected: Record<string, string[]> = {
      import_read_session: [],
      import_read_observations: ["pageIndex"],
      import_read_candidates: ["lineId", "pageIndex"],
      list_projects: ["pageIndex"],
      list_payment_methods: [],
      get_category_taxonomy: [],
      import_edit_answer: ["interpretation"],
    };
    for (const definition of definitions) {
      expect(definition.parameters).toMatchObject({
        type: "object",
        additionalProperties: false,
        required: expected[definition.name],
      });
      const properties = definition.parameters["properties"];
      if (
        properties === null ||
        typeof properties !== "object" ||
        Array.isArray(properties)
      )
        throw new Error("Expected object properties in the tool schema");
      expect(Object.keys(properties)).toEqual(expected[definition.name]);
    }
    const edit = definitions.find((tool) => tool.name === "import_edit_answer");
    expect(JSON.stringify(edit?.parameters)).toContain('"SOURCE_TOTAL"');
    expect(JSON.stringify(edit?.parameters)).toContain('"MULTI_FIELD"');
    expect(JSON.stringify(edit?.parameters)).not.toContain('"replaceLines"');
  });

  it.each<[string, Record<string, unknown>]>([
    ["import_read_session", {}],
    ["import_read_observations", { pageIndex: 0 }],
    ["import_read_candidates", { lineId: "line-1", pageIndex: 1 }],
    ["list_projects", { pageIndex: 0 }],
    ["list_payment_methods", {}],
    ["get_category_taxonomy", {}],
    ["import_edit_answer", { interpretation: { kind: "AMBIGUOUS" } }],
    ["import_prepare_session", {}],
  ])("accepts exactly the structural arguments of %s", (name, args) => {
    expect(parseImportToolArguments(name, args)).toEqual({
      name,
      arguments: args,
    });
    rejected(
      () => parseImportToolArguments(name, { ...args, sessionId: "other" }),
      "MODEL_OUTPUT_INVALID",
    );
    rejected(
      () => parseImportToolArguments(name, null),
      "MODEL_OUTPUT_INVALID",
    );
    rejected(() => parseImportToolArguments(name, []), "MODEL_OUTPUT_INVALID");
  });

  it.each([
    "create_expense",
    "update_expense",
    "check_price_monitor_item",
    "find_expenses",
    "constructor",
    "toString",
    "__proto__",
    "unknown",
  ])("rejects non-import tool %s explicitly", (name) =>
    rejected(() => parseImportToolArguments(name, {}), "TOOL_NOT_ALLOWED"),
  );

  it.each([
    {},
    { pageIndex: -1 },
    { pageIndex: 0.5 },
    { pageIndex: "0" },
    { pageIndex: NaN },
    { pageIndex: Infinity },
    { pageIndex: Number.MAX_SAFE_INTEGER + 1 },
    { pageIndex: 0, cursor: "private" },
    { pageIndex: 0, auth: {} },
  ])("rejects malformed page arguments: %p", (args) => {
    rejected(
      () => parseImportToolArguments("import_read_observations", args),
      "MODEL_OUTPUT_INVALID",
    );
  });

  it("does not implement paging authority or infer search completeness", () => {
    expect(parseImportToolArguments("list_projects", { pageIndex: 2 })).toEqual(
      {
        name: "list_projects",
        arguments: { pageIndex: 2 },
      },
    );
    rejected(
      () =>
        parseImportToolArguments("import_read_candidates", {
          pageIndex: 0,
          lineId: "",
        }),
      "MODEL_OUTPUT_INVALID",
    );
    rejected(
      () =>
        parseImportToolArguments("import_read_candidates", {
          pageIndex: 0,
          lineId: "x".repeat(192),
        }),
      "MODEL_OUTPUT_INVALID",
    );
  });

  it("rejects non-record arguments and trailing newlines in identifiers", () => {
    rejected(
      () => parseImportToolArguments("import_read_session", new Date()),
      "MODEL_OUTPUT_INVALID",
    );
    rejected(
      () => parseImportToolArguments("import_read_session", new Map()),
      "MODEL_OUTPUT_INVALID",
    );
    rejected(
      () =>
        parseImportToolArguments("import_read_candidates", {
          pageIndex: 0,
          lineId: "line-1\n",
        }),
      "MODEL_OUTPUT_INVALID",
    );
  });

  it.each<[Field, unknown]>([
    ["amountMeaning", "TOTAL_PURCHASE"],
    ["amountMeaning", "UNKNOWN"],
    ["amountCents", money],
    ["amountCents", null],
    ["installmentCount", 24],
    ["installmentCount", null],
    ["dataCompra", "2026-10-08"],
    ["firstDueDate", null],
    ["tipoDespesa", ExpenseType.OUTROS],
    ["categoriaMaoDeObra", Object.values(LaborCategory)[0]],
    ["targets", null],
    ["targets", { kind: "NO_TARGETS" }],
    [
      "targets",
      {
        kind: "TARGETS",
        items: [
          { projectId: "p1", roomId: null, amount: money },
          {
            projectId: "p2",
            roomId: "room-2",
            amount: { kind: "SOURCE_TOTAL" },
          },
        ],
      },
    ],
    ["decision", { kind: "UNRESOLVED" }],
    ["decision", { kind: "CREATE", acceptNaturalDuplicate: false }],
    ["decision", { kind: "KEEP_EXISTING", expenseId: "expense-1" }],
  ])(
    "retains the structural VALUE for %s without applying it",
    (field, fieldValue) => {
      const args = value(field, fieldValue);
      expect(parseImportToolArguments("import_edit_answer", args)).toEqual({
        name: "import_edit_answer",
        arguments: args,
      });
    },
  );

  it.each([
    { kind: "INVALID" },
    { kind: "UNSUPPORTED_NORMALIZATION" },
    { kind: "MULTI_FIELD", fields: ["amountCents", "dataCompra"] },
  ])(
    "accepts non-value interpretation %p without a mutation",
    (interpretation) => {
      expect(
        parseImportToolArguments("import_edit_answer", { interpretation }),
      ).toEqual({
        name: "import_edit_answer",
        arguments: { interpretation },
      });
    },
  );

  it.each([
    value("amountCents", 20696),
    value("amountCents", { ...money, amountCents: 20696 }),
    value("amountCents", {
      span: { ...evidence, auth: "forged" },
      text: "206,96",
    }),
    value("amountCents", { span: { start: -1, end: 2 }, text: "20" }),
    value("amountCents", { span: { start: 2, end: 2 }, text: "20" }),
    value("installmentCount", 0),
    value("installmentCount", 25),
    value("installmentCount", 1.5),
    value("amountMeaning", "GUESS"),
    value("tipoDespesa", "GUESS"),
    value("categoriaMaoDeObra", "GUESS"),
    value("dataCompra", "08/10/2026"),
    value("targets", { kind: "TARGETS", items: [] }),
    value("targets", {
      kind: "TARGETS",
      items: [
        { projectId: "p1", roomId: null, amount: money },
        { projectId: "p1", roomId: "room-2", amount: money },
      ],
    }),
    value("targets", {
      kind: "TARGETS",
      items: [
        {
          projectId: "p1",
          roomId: null,
          amount: { kind: "SOURCE_TOTAL", value: 4 },
        },
      ],
    }),
    value("decision", { kind: "CREATE", acceptNaturalDuplicate: "true" }),
    value("decision", {
      kind: "KEEP_EXISTING",
      expenseId: "e1",
      confirmed: true,
    }),
    { interpretation: { kind: "AMBIGUOUS", value: "guess" } },
    {
      interpretation: {
        kind: "MULTI_FIELD",
        fields: ["amountCents", "amountCents"],
      },
    },
    { interpretation: { kind: "MULTI_FIELD", fields: ["amountCents"] } },
    {
      interpretation: {
        kind: "MULTI_FIELD",
        fields: ["amountCents", "fornecedor"],
      },
    },
    {
      interpretation: {
        kind: "VALUE",
        field: "fornecedor",
        evidence,
        value: "shop",
      },
    },
    { interpretation: { kind: "VALUE", field: "amountCents", value: money } },
  ])(
    "rejects invalid nested shapes without a success-shaped fallback: %p",
    (args) => {
      rejected(
        () => parseImportToolArguments("import_edit_answer", args),
        "MODEL_OUTPUT_INVALID",
      );
    },
  );

  it("leaves literal evidence, monetary meaning and opt-in authorization to the future answer boundary", () => {
    const args = value("amountCents", {
      span: { start: 900, end: 999 },
      text: "zero ou menos dez",
    });
    expect(parseImportToolArguments("import_edit_answer", args)).toEqual({
      name: "import_edit_answer",
      arguments: args,
    });
    const optIn = value("decision", {
      kind: "CREATE",
      acceptNaturalDuplicate: true,
    });
    expect(parseImportToolArguments("import_edit_answer", optIn)).toEqual({
      name: "import_edit_answer",
      arguments: optIn,
    });
  });
});

describe("P08-Q1 sparse array structural rejection", () => {
  it.each([
    {
      label: "TARGETS.items",
      slots: new Array<unknown>(1),
      args: (items: unknown[]) => value("targets", { kind: "TARGETS", items }),
    },
    {
      label: "MULTI_FIELD.fields",
      slots: [, "amountCents"],
      args: (fields: unknown[]) => ({
        interpretation: { kind: "MULTI_FIELD", fields },
      }),
    },
  ])(
    "rejects the exact sparse $label input without filling or dropping holes",
    ({ slots, args }) => {
      const length = slots.length;
      expect(Object.prototype.hasOwnProperty.call(slots, 0)).toBe(false);
      rejected(
        () => parseImportToolArguments("import_edit_answer", args(slots)),
        "MODEL_OUTPUT_INVALID",
      );
      expect(slots.length).toBe(length);
      expect(Object.prototype.hasOwnProperty.call(slots, 0)).toBe(false);
    },
  );

  it.each([
    value("targets", { kind: "TARGETS", items: [null] }),
    { interpretation: { kind: "MULTI_FIELD", fields: [null, "amountCents"] } },
  ])("still rejects explicit null slots: %p", (args) => {
    rejected(
      () => parseImportToolArguments("import_edit_answer", args),
      "MODEL_OUTPUT_INVALID",
    );
  });

  it.each([
    value("targets", {
      kind: "TARGETS",
      items: [
        { projectId: "p2", roomId: null, amount: money },
        { projectId: "p1", roomId: null, amount: money },
      ],
    }),
    {
      interpretation: {
        kind: "MULTI_FIELD",
        fields: ["dataCompra", "amountCents"],
      },
    },
  ])("preserves valid dense slots and their order: %p", (args) => {
    expect(parseImportToolArguments("import_edit_answer", args)).toEqual({
      name: "import_edit_answer",
      arguments: args,
    });
  });
});

describe("P08 allowlist projection of already-authorized inputs (not authorization)", () => {
  const line = {
    id: "line-1",
    titulo: "Compra",
    amountMeaning: "TOTAL_PURCHASE" as const,
    amountCents: 20696,
    installmentCount: null,
    dataCompra: "2026-10-08",
    firstDueDate: null,
    tipoDespesa: ExpenseType.OUTROS,
    categoriaMaoDeObra: null,
    targets: [
      {
        projectId: "project-1",
        roomId: null,
        amountCents: 20696,
        grant: secret,
      },
    ],
    decision: {
      kind: "CREATE" as const,
      acceptNaturalDuplicate: false,
      nonce: secret,
    },
    observationIds: [secret],
    fornecedor: secret,
    scope: secret,
  };
  const session = {
    version: 1 as const,
    kind: "SESSION" as const,
    state: "NEEDS_INPUT" as const,
    revision: 7,
    focus: {
      id: "q1",
      field: "amountCents" as const,
      lineIds: ["line-1"],
      text: "Valor?",
      token: secret,
    },
    lines: [line],
    proposal: secret,
    receipt: secret,
    confirmation: secret,
    selectedLineIds: [secret],
    auth: secret,
  };

  it("checks the exact JSON UTF-8 byte boundary, not character count or truncation", () => {
    const empty = {
      version: 1 as const,
      kind: "TAXONOMY" as const,
      expenseTypes: [{ value: ExpenseType.OUTROS, label: "", synonyms: [] }],
      laborCategories: [],
    };
    const available =
      1048576 - Buffer.byteLength(JSON.stringify(empty), "utf8");
    const full = {
      ...empty,
      expenseTypes: [
        {
          value: ExpenseType.OUTROS,
          label: "x".repeat(available),
          synonyms: [],
        },
      ],
    };
    expect(
      Buffer.byteLength(JSON.stringify(projectImportModelRead(full)), "utf8"),
    ).toBe(1048576);
    rejected(
      () =>
        projectImportModelRead({
          ...empty,
          expenseTypes: [
            {
              value: ExpenseType.OUTROS,
              label: "x".repeat(available - 1) + "\u00e9",
              synonyms: [],
            },
          ],
        }),
      "LIMIT_EXCEEDED",
    );
  });

  it("picks the exact session shape recursively without spreading private members", () => {
    const projected = projectImportModelRead(session);
    expect(projected).toEqual({
      version: 1,
      kind: "SESSION",
      state: "NEEDS_INPUT",
      revision: 7,
      focus: {
        id: "q1",
        field: "amountCents",
        lineIds: ["line-1"],
        text: "Valor?",
      },
      lines: [
        {
          id: "line-1",
          titulo: "Compra",
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 20696,
          installmentCount: null,
          dataCompra: "2026-10-08",
          firstDueDate: null,
          tipoDespesa: ExpenseType.OUTROS,
          categoriaMaoDeObra: null,
          targets: [
            { projectId: "project-1", roomId: null, amountCents: 20696 },
          ],
          decision: { kind: "CREATE", acceptNaturalDuplicate: false },
        },
      ],
    });
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect(projected).not.toBe(session);
    if (projected.kind !== "SESSION" || !projected.focus)
      throw new Error("Expected session focus");
    projected.focus.lineIds.push("local-change");
    expect(session.focus.lineIds).toEqual(["line-1"]);
    expect(projectImportModelRead({ ...session, focus: null })).toMatchObject({
      focus: null,
    });
  });

  it("picks observation and candidate pages, keeping explicit completeness independent of hasMore", () => {
    const observation = {
      id: "o1",
      attachmentId: "a1",
      lineId: "line-1",
      reference: "page-1",
      amountMeaning: "INSTALLMENT_CHARGE" as const,
      amountCents: -50,
      installmentCount: 3,
      installmentIndex: 1,
      dataCompra: null,
    };
    const candidate = {
      id: "e1",
      lineId: "line-1",
      kind: "EXPENSE" as const,
      projectId: "p1",
      description: "Compra",
      amountCents: 20696,
      date: "2026-10-08",
      reason: "NATURAL_MATCH" as const,
      canKeepExisting: true,
    };
    const observations = {
      version: 1 as const,
      kind: "OBSERVATIONS" as const,
      pageIndex: 0,
      hasMore: true,
      items: [{ ...observation, rawText: secret, evidence: secret }],
      cursor: secret,
    };
    expect(projectImportModelRead(observations)).toEqual({
      version: 1,
      kind: "OBSERVATIONS",
      pageIndex: 0,
      hasMore: true,
      items: [observation],
    });
    expect(
      projectImportModelRead({
        version: 1,
        kind: "CANDIDATES",
        pageIndex: 0,
        hasMore: false,
        searchComplete: false,
        items: [{ ...candidate, receipt: secret }],
      }),
    ).toEqual({
      version: 1,
      kind: "CANDIDATES",
      pageIndex: 0,
      hasMore: false,
      searchComplete: false,
      items: [candidate],
    });
    expect(
      projectImportModelRead({
        version: 1,
        kind: "CANDIDATES",
        pageIndex: 0,
        hasMore: false,
        searchComplete: false,
        items: [],
      }),
    ).toMatchObject({ searchComplete: false, items: [] });
  });

  it("picks catalogs and the session card, not generic accounts or authority", () => {
    const project = { id: "p1", name: "Reforma", type: ProjectType.REFORMA };
    const projects = {
      version: 1 as const,
      kind: "PROJECTS" as const,
      pageIndex: 0,
      hasMore: false,
      items: [{ ...project, tenantId: secret, eligible: true }],
      cursor: secret,
    };
    expect(projectImportModelRead(projects)).toEqual({
      version: 1,
      kind: "PROJECTS",
      pageIndex: 0,
      hasMore: false,
      items: [project],
    });
    const card = {
      id: "card-1",
      nickname: null,
      institution: "Bank",
      last4: "1234",
    };
    const payment = {
      version: 1 as const,
      kind: "PAYMENT_METHODS" as const,
      card: { ...card, tenantId: secret },
      accounts: [secret],
    };
    expect(projectImportModelRead(payment)).toEqual({
      version: 1,
      kind: "PAYMENT_METHODS",
      card,
    });
    const expenseType = {
      value: ExpenseType.OUTROS,
      label: "Outros",
      synonyms: ["outro"],
    };
    const taxonomy = {
      version: 1 as const,
      kind: "TAXONOMY" as const,
      expenseTypes: [{ ...expenseType, policy: secret }],
      laborCategories: Object.values(LaborCategory),
    };
    expect(projectImportModelRead(taxonomy)).toEqual({
      version: 1,
      kind: "TAXONOMY",
      expenseTypes: [expenseType],
      laborCategories: Object.values(LaborCategory),
    });
    expect(
      JSON.stringify([
        projectImportModelRead(projects),
        projectImportModelRead(payment),
        projectImportModelRead(taxonomy),
      ]),
    ).not.toContain(secret);
  });

  it("enforces line/page/JSON limits exactly, never silently truncates", () => {
    expect(
      projectImportModelRead({
        ...session,
        lines: Array.from({ length: 100 }, (_, index) => ({
          ...line,
          id: `line-${index}`,
        })),
      }),
    ).toMatchObject({
      lines: expect.arrayContaining([
        expect.objectContaining({ id: "line-99" }),
      ]),
    });
    rejected(
      () =>
        projectImportModelRead({ ...session, lines: Array(101).fill(line) }),
      "LIMIT_EXCEEDED",
    );
    const page: ImportModelRead = {
      version: 1,
      kind: "PROJECTS",
      pageIndex: 0,
      hasMore: false,
      items: Array.from({ length: 25 }, (_, index) => ({
        id: `p${index}`,
        name: "P",
        type: ProjectType.CASA,
      })),
    };
    expect(projectImportModelRead(page)).toEqual(page);
    rejected(
      () =>
        projectImportModelRead({
          ...page,
          items: [...page.items, page.items[0]!],
        }),
      "LIMIT_EXCEEDED",
    );
    rejected(
      () =>
        projectImportModelRead({
          version: 1,
          kind: "TAXONOMY",
          expenseTypes: [
            {
              value: ExpenseType.OUTROS,
              label: "Outros",
              synonyms: [
                "x".repeat(IMPORT_SESSION_LIMITS.jsonBytesPerDraftOrProposal),
              ],
            },
          ],
          laborCategories: [],
        }),
      "LIMIT_EXCEEDED",
    );
  });
});
