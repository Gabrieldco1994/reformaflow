import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  ImportObservation,
  ImportSession,
  ImportSessionArtifact,
} from "@prisma/client";
import type {
  ImportSessionAmountMeaning,
  ImportSessionObservationViewV1,
  ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  computeImportOrdinals,
  fileContentHash,
} from "../../credit-card/parsers/dedupe-key";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
} from "./import-session.errors";
import {
  parseStoredImportObservationEvidence,
  projectImportObservation,
} from "./import-session.observation";

// This is the approved private facts envelope, not a reference implementation.
interface StoredImportObservationEvidenceV1 {
  version: 1;
  reference: string;
  text: string;
  amountMeaning: ImportSessionAmountMeaning;
  amountCents: number | null;
  installmentCount: number | null;
  installmentIndex: number | null;
  dataCompra: string | null;
  identity: {
    merchant: string | null;
    externalId: string | null;
    fitId: string | null;
    ordinal: number | null;
    fileContentHash: string | null;
  };
}
type ParseEvidence = (raw: string) => StoredImportObservationEvidenceV1;
type ProjectObservation = (
  session: Pick<ImportSession, "id" | "tenantId" | "ownerProjectId">,
  scope: ImportSessionStoredDraftV1["scope"],
  row: ImportObservation,
  attachment: ImportSessionArtifact,
) => ImportSessionObservationViewV1;
interface ObservationExports {
  parseStoredImportObservationEvidence: ParseEvidence;
  projectImportObservation: ProjectObservation;
}

function loadObservation(): ObservationExports {
  const path = join(__dirname, "import-session.observation.ts");
  expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
  expect(typeof parseStoredImportObservationEvidence).toBe("function");
  expect(typeof projectImportObservation).toBe("function");
  return {
    parseStoredImportObservationEvidence,
    projectImportObservation,
  };
}

const ORIGINAL_BYTES = Buffer.from(
  "synthetic complete frozen extraction",
  "utf8",
);
const DOCUMENT_MARKER = "qa-private-document-content";
const CREATED_AT = new Date("2026-10-01T05:00:00.000Z");
const SESSION = {
  id: "qa-mother",
  tenantId: "qa-tenant",
  ownerProjectId: "qa-pessoal",
};

function evidence(): StoredImportObservationEvidenceV1 {
  return {
    version: 1,
    reference: "page:1/row:7",
    text: DOCUMENT_MARKER,
    amountMeaning: "INSTALLMENT_CHARGE",
    amountCents: 20696,
    installmentCount: 3,
    installmentIndex: 2,
    dataCompra: "2026-09-20",
    identity: {
      merchant: "Frozen Merchant",
      externalId: "qa-external-original",
      fitId: "qa-fit-original",
      ordinal: 1,
      fileContentHash: fileContentHash([ORIGINAL_BYTES]),
    },
  };
}

function projectionFixture(facts = evidence()) {
  const row: ImportObservation = {
    id: "qa-observation",
    tenantId: SESSION.tenantId,
    ownerProjectId: SESSION.ownerProjectId,
    artifactId: "qa-artifact",
    reference: facts.reference,
    evidenceJson: JSON.stringify(facts),
    claimVersion: 0,
    canonicalProjectId: null,
    canonicalExpenseId: null,
    canonicalReceiptId: null,
    canonicalIndex: null,
    claimSessionId: null,
    claimReceiptJson: null,
    claimedAt: null,
    createdAt: new Date(CREATED_AT),
  };
  const attachment: ImportSessionArtifact = {
    id: "qa-ref",
    tenantId: SESSION.tenantId,
    ownerProjectId: SESSION.ownerProjectId,
    sessionId: SESSION.id,
    artifactId: row.artifactId,
    position: 0,
    fileName: "synthetic.csv",
    declaredMime: "text/csv",
    declaredBytes: ORIGINAL_BYTES.length,
    state: "ATTACHED",
    temporaryStorageKey: null,
    reservedBytes: 0,
    uploadGeneration: 2,
    uploadSessionVersion: null,
    uploadTokenExpiresAt: null,
    uploadLeaseExpiresAt: null,
    verifiedAt: new Date(CREATED_AT),
    releasedAt: null,
    temporaryPurgePending: false,
    createdAt: new Date(CREATED_AT),
    updatedAt: new Date(CREATED_AT),
  };
  const scope: ImportSessionStoredDraftV1["scope"] = {
    observationIds: [row.id],
    pendingAttachmentIds: [],
  };
  return { session: { ...SESSION }, scope, row, attachment };
}

function publicView(
  facts = evidence(),
  id = "qa-observation",
  attachmentId = "qa-ref",
): ImportSessionObservationViewV1 {
  return {
    id,
    attachmentId,
    reference: facts.reference,
    text: facts.text,
    amountMeaning: facts.amountMeaning,
    amountCents: facts.amountCents,
    installmentCount: facts.installmentCount,
    installmentIndex: facts.installmentIndex,
    dataCompra: facts.dataCompra,
  };
}

function expectCorrupt(action: () => unknown): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(ImportSessionCorruptStateError);
  expect(failure).toMatchObject({ field: "evidence_json" });
  if (!(failure instanceof ImportSessionCorruptStateError)) {
    throw new Error("Expected sanitized evidence_json corruption");
  }
  expect(failure.message).toBe(
    new ImportSessionCorruptStateError("evidence_json").message,
  );
  expect(failure.message).not.toContain(DOCUMENT_MARKER);
  expect(JSON.stringify(failure)).not.toContain(DOCUMENT_MARKER);
  expect(failure).not.toHaveProperty("cause");
}

function expectAuthorityFailure(action: () => unknown): void {
  let failure: unknown;
  try {
    action();
  } catch (error) {
    failure = error;
  }
  expect(
    failure instanceof ImportSessionError ||
      failure instanceof ImportSessionCorruptStateError,
  ).toBe(true);
}

describe("independent turn-9 original observation facts", () => {
  it("controls: complete-extraction ordinals are 0/1 and canonical file hash is 32 lowercase hex", () => {
    const completeExtraction = [
      {
        date: new Date("2026-09-20T00:00:00.000Z"),
        merchant: "Frozen Merchant",
        amountCents: 20696,
      },
      {
        date: new Date("2026-09-20T00:00:00.000Z"),
        merchant: "Frozen Merchant",
        amountCents: 20696,
      },
    ];
    expect(computeImportOrdinals(completeExtraction)).toEqual([0, 1]);
    expect(fileContentHash([ORIGINAL_BYTES])).toMatch(/^[0-9a-f]{32}$/);
  });

  it("exports the actual parser and projector", () => {
    const api = loadObservation();
    expect(typeof api.parseStoredImportObservationEvidence).toBe("function");
    expect(typeof api.projectImportObservation).toBe("function");
  });

  it("preserves original merchant at the approved 160-character boundary", () => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    const facts = evidence();
    facts.identity.merchant = "m".repeat(160);
    expect(parse(JSON.stringify(facts))).toEqual(facts);
  });

  it("rejects original merchant at 161 characters rather than truncating it", () => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    const facts = evidence();
    facts.identity.merchant = "m".repeat(161);
    expectCorrupt(() => parse(JSON.stringify(facts)));
  });

  it("roundtrips the exact private envelope; printed index 2 stays 2 and cents are not multiplied", () => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    const facts = evidence();
    expect(parse(JSON.stringify(facts))).toEqual(facts);
    expect(facts.amountCents).toBe(20696);
    expect(facts.installmentIndex).toBe(2);
  });

  it.each([-2147483647, -20696, -1, 0, 1, 20696, 2147483647, null])(
    "preserves signed cents %s as evidence, not CREATE eligibility",
    (amountCents) => {
      const { parseStoredImportObservationEvidence: parse } = loadObservation();
      const facts = { ...evidence(), amountCents };
      expect(parse(JSON.stringify(facts))).toEqual(facts);
    },
  );

  it.each([
    [25, 25],
    [3, 5],
    [0, 0],
    [-1, -2],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    [Number.MIN_SAFE_INTEGER, Number.MIN_SAFE_INTEGER],
    [null, null],
  ])(
    "preserves documentary count/index %s/%s without applying CREATE's 24 cap",
    (installmentCount, installmentIndex) => {
      const { parseStoredImportObservationEvidence: parse } = loadObservation();
      const facts = { ...evidence(), installmentCount, installmentIndex };
      expect(parse(JSON.stringify(facts))).toEqual(facts);
    },
  );

  it("UNKNOWN/null facts stay unknown instead of dateToday/zero/derived totals", () => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    const facts: StoredImportObservationEvidenceV1 = {
      ...evidence(),
      amountMeaning: "UNKNOWN",
      amountCents: null,
      installmentCount: null,
      installmentIndex: null,
      dataCompra: null,
      identity: {
        merchant: null,
        externalId: null,
        fitId: null,
        ordinal: null,
        fileContentHash: null,
      },
    };
    expect(parse(JSON.stringify(facts))).toEqual(facts);
  });

  it.each(["1900-01-01", "2000-02-29", "2024-02-29", "2199-12-31"])(
    "preserves valid public date boundary %s",
    (dataCompra) => {
      const { parseStoredImportObservationEvidence: parse } = loadObservation();
      const facts = { ...evidence(), dataCompra };
      expect(parse(JSON.stringify(facts))).toEqual(facts);
    },
  );

  it.each([
    ["reference", "r"],
    ["reference", "r".repeat(192)],
    ["text", ""],
    ["text", "t".repeat(1000)],
  ] as const)(
    "accepts the public %s text boundary without truncation",
    (field, value) => {
      const { parseStoredImportObservationEvidence: parse } = loadObservation();
      const facts = { ...evidence(), [field]: value };
      expect(parse(JSON.stringify(facts))).toEqual(facts);
    },
  );

  const malformed: Array<[string, string]> = [
    ["malformed JSON", `{"version":1,"text":"${DOCUMENT_MARKER}"`],
    ["empty JSON", ""],
    ["null", "null"],
    ["array", "[]"],
    ["scalar", "7"],
    ["bootstrap placeholder", '{"version":1}'],
  ];
  it.each(malformed)(
    "rejects %s with sanitized evidence_json corruption",
    (_name, raw) => {
      const { parseStoredImportObservationEvidence: parse } = loadObservation();
      expectCorrupt(() => parse(raw));
    },
  );

  it.each([
    "version",
    "reference",
    "text",
    "amountMeaning",
    "amountCents",
    "installmentCount",
    "installmentIndex",
    "dataCompra",
    "identity",
  ])("requires envelope field %s, including nullable fields", (key) => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    const incomplete = Object.fromEntries(
      Object.entries(evidence()).filter(([field]) => field !== key),
    );
    expectCorrupt(() => parse(JSON.stringify(incomplete)));
  });

  it.each(["merchant", "externalId", "fitId", "ordinal", "fileContentHash"])(
    "requires private identity field %s even when unknown",
    (key) => {
      const { parseStoredImportObservationEvidence: parse } = loadObservation();
      const facts = evidence();
      const incomplete = {
        ...facts,
        identity: Object.fromEntries(
          Object.entries(facts.identity).filter(([field]) => field !== key),
        ),
      };
      expectCorrupt(() => parse(JSON.stringify(incomplete)));
    },
  );

  it.each([
    ["version", 2],
    ["version", "1"],
    ["reference", ""],
    ["reference", "r".repeat(193)],
    ["reference", 7],
    ["text", "t".repeat(1001)],
    ["text", null],
    ["text", 7],
    ["amountMeaning", "CREATE"],
    ["amountMeaning", null],
    ["amountCents", -2147483648],
    ["amountCents", 2147483648],
    ["amountCents", 206.96],
    ["amountCents", "20696"],
    ["amountCents", true],
    ["installmentCount", 1.5],
    ["installmentCount", "25"],
    ["installmentCount", Number.MAX_SAFE_INTEGER + 1],
    ["installmentIndex", 1.5],
    ["installmentIndex", false],
    ["installmentIndex", Number.MIN_SAFE_INTEGER - 1],
    ["dataCompra", "1899-12-31"],
    ["dataCompra", "2200-01-01"],
    ["dataCompra", "1900-02-29"],
    ["dataCompra", "2026-02-29"],
    ["dataCompra", "2026-04-31"],
    ["dataCompra", "2026-13-01"],
    ["dataCompra", "2026-01-00"],
    ["dataCompra", "2026-9-20"],
    ["dataCompra", "2026-09-20T00:00:00.000Z"],
    ["dataCompra", 20260920],
    ["identity", null],
    ["identity", []],
  ])("rejects incompatible %s=%s instead of coercion/default", (key, value) => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    expectCorrupt(() => parse(JSON.stringify({ ...evidence(), [key]: value })));
  });

  it.each([
    ["merchant", 12],
    ["externalId", false],
    ["fitId", {}],
    ["ordinal", 1.5],
    ["ordinal", "1"],
    ["ordinal", Number.MAX_SAFE_INTEGER + 1],
    ["fileContentHash", "a".repeat(64)],
    ["fileContentHash", "A".repeat(32)],
    ["fileContentHash", "g".repeat(32)],
    ["fileContentHash", "a".repeat(31)],
    ["fileContentHash", 123],
  ])(
    "rejects incompatible identity %s without reconstructing it",
    (key, value) => {
      const { parseStoredImportObservationEvidence: parse } = loadObservation();
      const facts = evidence();
      expectCorrupt(() =>
        parse(
          JSON.stringify({
            ...facts,
            identity: { ...facts.identity, [key]: value },
          }),
        ),
      );
    },
  );

  it.each([
    "id",
    "attachmentId",
    "sessionId",
    "artifactId",
    "decision",
    "selectedLineIds",
    "proposalHash",
  ])("refuses extra authority/decision envelope key %s", (key) => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    expectCorrupt(() =>
      parse(JSON.stringify({ ...evidence(), [key]: "forged" })),
    );
  });

  it("rejects a public DTO directly and when wrapped with version 1", () => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    expectCorrupt(() => parse(JSON.stringify(publicView())));
    expectCorrupt(() => parse(JSON.stringify({ version: 1, ...publicView() })));
  });

  it("refuses extra nested identity keys", () => {
    const { parseStoredImportObservationEvidence: parse } = loadObservation();
    const facts = evidence();
    expectCorrupt(() =>
      parse(
        JSON.stringify({
          ...facts,
          identity: { ...facts.identity, decision: "CREATE" },
        }),
      ),
    );
  });

  it("projects only public fields using DB observation/ref identities, not artifact identity", () => {
    const { projectImportObservation: project } = loadObservation();
    const input = projectionFixture();
    const before = structuredClone(input);
    expect(
      project(input.session, input.scope, input.row, input.attachment),
    ).toEqual(publicView());
    expect(input).toEqual(before);
  });

  it("carries UNKNOWN/negative/zero/>24 factual values through public projection", () => {
    const { projectImportObservation: project } = loadObservation();
    for (const amountCents of [null, -20696, 0]) {
      const facts: StoredImportObservationEvidenceV1 = {
        ...evidence(),
        amountMeaning: "UNKNOWN",
        amountCents,
        installmentCount: 25,
        installmentIndex: 27,
        dataCompra: null,
      };
      const input = projectionFixture(facts);
      expect(
        project(input.session, input.scope, input.row, input.attachment),
      ).toEqual(publicView(facts));
    }
  });

  it("preserves complete-extraction twin ordinal/identity after a partial selection and human edits", () => {
    const {
      parseStoredImportObservationEvidence: parse,
      projectImportObservation: project,
    } = loadObservation();
    const frozenExtraction = [0, 1].map(() => ({
      date: new Date("2026-09-20T00:00:00.000Z"),
      merchant: "Frozen Merchant",
      amountCents: 20696,
    }));
    const ordinals = computeImportOrdinals(frozenExtraction);
    const twins = ordinals.map((ordinal) => {
      const facts = evidence();
      facts.reference = `page:1/row:${ordinal + 7}`;
      facts.identity.ordinal = ordinal;
      return facts;
    });
    const second = projectionFixture(twins[1]);
    second.row.id = "qa-observation-twin-1";
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [
        {
          id: "qa-edited-line",
          observationIds: [second.row.id],
          titulo: "Different human title",
          fornecedor: "Different human merchant",
          tipoDespesa: null,
          categoriaMaoDeObra: null,
          amountMeaning: "TOTAL_PURCHASE",
          amountCents: 999999,
          installmentCount: 1,
          dataCompra: "2027-01-01",
          firstDueDate: "2027-02-01",
          targets: [],
          decision: { kind: "CREATE", acceptNaturalDuplicate: true },
        },
      ],
      selectedLineIds: ["qa-edited-line"],
      questions: [],
      scope: {
        observationIds: ["qa-observation-twin-0", second.row.id],
        pendingAttachmentIds: [],
      },
    };
    const parsed = twins.map((facts) => parse(JSON.stringify(facts)));
    expect(parsed.map((facts) => facts.identity.ordinal)).toEqual([0, 1]);
    expect(parse(second.row.evidenceJson).identity).toEqual(twins[1].identity);
    expect(
      project(second.session, draft.scope, second.row, second.attachment),
    ).toEqual(publicView(twins[1], second.row.id));
    draft.selectedLineIds = [];
    draft.lines[0].fornecedor = "Another correction";
    expect(parse(second.row.evidenceJson)).toEqual(twins[1]);
    expect(
      project(second.session, draft.scope, second.row, second.attachment),
    ).toEqual(publicView(twins[1], second.row.id));
  });

  it("does not expose third-party claims, receipts or canonical financial IDs", () => {
    const { projectImportObservation: project } = loadObservation();
    const input = projectionFixture();
    input.row.claimSessionId = "other-session";
    input.row.claimReceiptJson = '{"secret":"foreign-receipt"}';
    input.row.canonicalProjectId = "foreign-project";
    input.row.canonicalExpenseId = "foreign-expense";
    input.row.canonicalReceiptId = "foreign-receipt";
    input.row.claimVersion = 4;
    expect(
      project(input.session, input.scope, input.row, input.attachment),
    ).toEqual(publicView());
  });

  it("rejects evidence reference differing from authoritative DB reference", () => {
    const { projectImportObservation: project } = loadObservation();
    const input = projectionFixture();
    input.row.reference = "page:9/row:99";
    expectCorrupt(() =>
      project(input.session, input.scope, input.row, input.attachment),
    );
  });

  it("applies the strict parser before returning corrupt stored facts", () => {
    const { projectImportObservation: project } = loadObservation();
    const input = projectionFixture();
    input.row.evidenceJson = '{"version":1}';
    expectCorrupt(() =>
      project(input.session, input.scope, input.row, input.attachment),
    );
  });

  type ProjectionInput = ReturnType<typeof projectionFixture>;
  const invalidAuthority: Array<[string, (input: ProjectionInput) => void]> = [
    [
      "missing scope membership",
      (input) => {
        input.scope.observationIds = [];
      },
    ],
    [
      "row outside selected scope",
      (input) => {
        input.row.id = "foreign-observation";
      },
    ],
    [
      "foreign observation tenant",
      (input) => {
        input.row.tenantId = "foreign-tenant";
      },
    ],
    [
      "foreign observation anchor",
      (input) => {
        input.row.ownerProjectId = "foreign-anchor";
      },
    ],
    [
      "foreign attachment tenant",
      (input) => {
        input.attachment.tenantId = "foreign-tenant";
      },
    ],
    [
      "foreign attachment anchor",
      (input) => {
        input.attachment.ownerProjectId = "foreign-anchor";
      },
    ],
    [
      "foreign attachment session",
      (input) => {
        input.attachment.sessionId = "foreign-session";
      },
    ],
    [
      "observation/artifact mismatch",
      (input) => {
        input.row.artifactId = "foreign-artifact";
      },
    ],
    [
      "attachment without artifact",
      (input) => {
        input.attachment.artifactId = null;
      },
    ],
    [
      "RESERVED ref",
      (input) => {
        input.attachment.state = "RESERVED";
      },
    ],
    [
      "UPLOADED ref",
      (input) => {
        input.attachment.state = "UPLOADED";
      },
    ],
    [
      "FAILED ref",
      (input) => {
        input.attachment.state = "FAILED";
      },
    ],
    [
      "RELEASED ref",
      (input) => {
        input.attachment.state = "RELEASED";
      },
    ],
  ];
  it.each(invalidAuthority)(
    "rejects %s before public return; typed facts do not grant ACL",
    (_name, mutate) => {
      const { projectImportObservation: project } = loadObservation();
      const input = projectionFixture();
      mutate(input);
      const before = structuredClone(input);
      expectAuthorityFailure(() =>
        project(input.session, input.scope, input.row, input.attachment),
      );
      expect(input).toEqual(before);
    },
  );
});
