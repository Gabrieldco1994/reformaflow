require("../../../../../scripts/test-db-env.cjs");

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ImportObservation, ImportSessionArtifact } from "@prisma/client";
import type {
  ImportSessionAmountMeaning,
  ImportSessionObservationViewV1,
  ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  computeImportOrdinals,
  dedupeKeyNatural,
  fileContentHash,
} from "../../credit-card/parsers/dedupe-key";
import {
  ImportSessionCorruptStateError,
  ImportSessionError,
  importSessionWire,
} from "./import-session.errors";

interface Evidence {
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
const session = {
  id: "session",
  tenantId: "tenant",
  ownerProjectId: "pessoal",
};
interface Api {
  parseStoredImportObservationEvidence(raw: string): Evidence;
  projectImportObservation(
    owner: typeof session,
    scope: ImportSessionStoredDraftV1["scope"],
    row: ImportObservation,
    attachment: ImportSessionArtifact,
  ): ImportSessionObservationViewV1;
}
function api(): Api {
  const path = join(__dirname, "import-session.observation.ts");
  expect({ path, exists: existsSync(path) }).toEqual({ path, exists: true });
  const module: Api = require("./import-session.observation");
  expect(typeof module.parseStoredImportObservationEvidence).toBe("function");
  expect(typeof module.projectImportObservation).toBe("function");
  return module;
}
function evidence(): Evidence {
  return {
    version: 1,
    reference: "row-2",
    text: "Original printed purchase",
    amountMeaning: "INSTALLMENT_CHARGE",
    amountCents: 6984,
    installmentCount: 10,
    installmentIndex: 2,
    dataCompra: "2026-10-05",
    identity: {
      merchant: "Original merchant",
      externalId: null,
      fitId: null,
      ordinal: 1,
      fileContentHash: "a".repeat(32),
    },
  };
}
function fixture() {
  const now = new Date("2026-10-06T15:00:00.000Z");
  const row: ImportObservation = {
    id: "observation",
    tenantId: "tenant",
    ownerProjectId: "pessoal",
    artifactId: "artifact",
    reference: "row-2",
    evidenceJson: JSON.stringify(evidence()),
    claimVersion: 0,
    canonicalProjectId: null,
    canonicalExpenseId: null,
    canonicalReceiptId: null,
    canonicalIndex: null,
    claimSessionId: null,
    claimReceiptJson: null,
    claimedAt: null,
    createdAt: now,
  };
  const attachment: ImportSessionArtifact = {
    id: "attachment",
    tenantId: "tenant",
    ownerProjectId: "pessoal",
    sessionId: "session",
    artifactId: "artifact",
    position: 0,
    fileName: "synthetic.csv",
    declaredMime: "text/csv",
    declaredBytes: 100,
    state: "ATTACHED",
    temporaryStorageKey: null,
    reservedBytes: 100,
    uploadGeneration: 1,
    uploadSessionVersion: null,
    uploadTokenExpiresAt: null,
    uploadLeaseExpiresAt: null,
    verifiedAt: now,
    releasedAt: null,
    temporaryPurgePending: false,
    createdAt: now,
    updatedAt: now,
  };
  return {
    row,
    attachment,
    scope: { observationIds: ["observation"], pendingAttachmentIds: [] },
  };
}

describe("shared private observation evidence", () => {
  it("CONTROL: existing canonical extraction ordinals keep literal twins distinct and use 32-hex file hashes", () => {
    const facts = [0, 1].map(() => ({
      date: new Date("2026-10-05T00:00:00.000Z"),
      merchant: "Original merchant",
      amountCents: 6984,
    }));
    expect(computeImportOrdinals(facts)).toEqual([0, 1]);
    expect(fileContentHash([Buffer.from("synthetic twins")])).toMatch(
      /^[0-9a-f]{32}$/,
    );
  });
  it("exports both actual pure functions", () => {
    api();
  });

  it("parses the exact private version and projects only the public DB-bound allowlist", () => {
    const {
      parseStoredImportObservationEvidence: parse,
      projectImportObservation: project,
    } = api();
    const f = fixture();
    expect(parse(f.row.evidenceJson)).toEqual(evidence());
    expect(project(session, f.scope, f.row, f.attachment)).toEqual({
      id: "observation",
      attachmentId: "attachment",
      reference: "row-2",
      text: "Original printed purchase",
      amountMeaning: "INSTALLMENT_CHARGE",
      amountCents: 6984,
      installmentCount: 10,
      installmentIndex: 2,
      dataCompra: "2026-10-05",
    });
  });

  it.each([-2147483647, -1, 0, 1, 2147483647])(
    "preserves signed documentary amount %i",
    (amountCents) => {
      const { parseStoredImportObservationEvidence: parse } = api();
      const value = { ...evidence(), amountCents };
      expect(parse(JSON.stringify(value))).toEqual(value);
    },
  );
  it.each([-1, 0, 25, Number.MAX_SAFE_INTEGER])(
    "preserves safe documentary count/index %i without CREATE limits",
    (count) => {
      const { parseStoredImportObservationEvidence: parse } = api();
      const value = {
        ...evidence(),
        installmentCount: count,
        installmentIndex: count,
      };
      expect(parse(JSON.stringify(value))).toEqual(value);
    },
  );
  it("preserves UNKNOWN and typed null identities without guessing title, date, ordinal or totals", () => {
    const {
      parseStoredImportObservationEvidence: parse,
      projectImportObservation: project,
    } = api();
    const value: Evidence = {
      version: 1,
      reference: "row-2",
      text: "",
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
    const f = fixture();
    f.row.evidenceJson = JSON.stringify(value);
    expect(parse(f.row.evidenceJson)).toEqual(value);
    expect(project(session, f.scope, f.row, f.attachment)).toMatchObject({
      text: "",
      amountMeaning: "UNKNOWN",
      amountCents: null,
      installmentCount: null,
      installmentIndex: null,
      dataCompra: null,
    });
  });

  it.each([
    "",
    "null",
    "[]",
    "{",
    '{"version":1}',
    '{"private":"EVIDENCE_SENTINEL"}',
  ])(
    "rejects malformed/placeholder %p as sanitized evidence_json corruption",
    (raw) => {
      const { parseStoredImportObservationEvidence: parse } = api();
      expect(() => parse(raw)).toThrow(
        expect.objectContaining({
          name: "ImportSessionCorruptStateError",
          field: "evidence_json",
          message: "import session state is corrupted",
        }),
      );
    },
  );

  const invalid: Array<[string, (value: Evidence) => void]> = [
    [
      "extra decision",
      (value) => {
        Object.assign(value, { decision: { kind: "CREATE" } });
      },
    ],
    [
      "injected observation ID",
      (value) => {
        Object.assign(value, { id: "fake" });
      },
    ],
    [
      "injected attachment ID",
      (value) => {
        Object.assign(value, { attachmentId: "fake" });
      },
    ],
    [
      "wrong version",
      (value) => {
        Object.assign(value, { version: 2 });
      },
    ],
    [
      "missing identity",
      (value) => {
        Reflect.deleteProperty(value, "identity");
      },
    ],
    [
      "missing required fact",
      (value) => {
        Reflect.deleteProperty(value, "amountCents");
      },
    ],
    [
      "extra identity field",
      (value) => {
        Object.assign(value.identity, { tenantId: "foreign" });
      },
    ],
    [
      "blank reference",
      (value) => {
        value.reference = "";
      },
    ],
    [
      "overlong reference",
      (value) => {
        value.reference = "r".repeat(193);
      },
    ],
    [
      "overlong text",
      (value) => {
        value.text = "t".repeat(1001);
      },
    ],
    [
      "non-NFC text",
      (value) => {
        value.text = "e\u0301";
      },
    ],
    [
      "fractional cents",
      (value) => {
        value.amountCents = 0.5;
      },
    ],
    [
      "overflow cents",
      (value) => {
        value.amountCents = 2147483648;
      },
    ],
    [
      "underflow cents",
      (value) => {
        value.amountCents = -2147483648;
      },
    ],
    [
      "unsafe count",
      (value) => {
        value.installmentCount = Number.MAX_SAFE_INTEGER + 1;
      },
    ],
    [
      "fractional index",
      (value) => {
        value.installmentIndex = 1.5;
      },
    ],
    [
      "invalid date",
      (value) => {
        value.dataCompra = "2026-02-30";
      },
    ],
    [
      "timestamp instead of date",
      (value) => {
        value.dataCompra = "2026-10-05T00:00:00.000Z";
      },
    ],
    [
      "out-of-range year",
      (value) => {
        value.dataCompra = "2200-01-01";
      },
    ],
    [
      "overlong merchant",
      (value) => {
        value.identity.merchant = "m".repeat(161);
      },
    ],
    [
      "overlong external identity",
      (value) => {
        value.identity.externalId = "e".repeat(193);
      },
    ],
    [
      "overlong fit identity",
      (value) => {
        value.identity.fitId = "f".repeat(193);
      },
    ],
    [
      "negative canonical ordinal",
      (value) => {
        value.identity.ordinal = -1;
      },
    ],
    [
      "fractional canonical ordinal",
      (value) => {
        value.identity.ordinal = 0.5;
      },
    ],
    [
      "raw artifact SHA",
      (value) => {
        value.identity.fileContentHash = "a".repeat(64);
      },
    ],
    [
      "uppercase canonical hash",
      (value) => {
        value.identity.fileContentHash = "A".repeat(32);
      },
    ],
  ];
  it.each(invalid)("rejects %s without coercion or echo", (_label, mutate) => {
    const { parseStoredImportObservationEvidence: parse } = api();
    const value = evidence();
    mutate(value);
    expect(() => parse(JSON.stringify(value))).toThrow(
      ImportSessionCorruptStateError,
    );
  });

  it("rejects the raw public DTO as private evidence", () => {
    const { parseStoredImportObservationEvidence: parse } = api();
    const value = evidence();
    const { identity: _identity, version: _version, ...facts } = value;
    expect(() =>
      parse(
        JSON.stringify({
          id: "observation",
          attachmentId: "attachment",
          ...facts,
        }),
      ),
    ).toThrow(ImportSessionCorruptStateError);
  });

  it("enforces reference agreement only after authorized membership", () => {
    const { projectImportObservation: project } = api();
    const f = fixture();
    f.row.evidenceJson = JSON.stringify({
      ...evidence(),
      reference: "different-original-row",
    });
    expect(() => project(session, f.scope, f.row, f.attachment)).toThrow(
      expect.objectContaining({ field: "evidence_json" }),
    );
  });

  const unauthorized: Array<[string, (f: ReturnType<typeof fixture>) => void]> =
    [
      [
        "invalid observation ID",
        (f) => {
          f.row.id = "";
          f.scope.observationIds = [""];
        },
      ],
      [
        "invalid attachment ID",
        (f) => {
          f.attachment.id = "";
        },
      ],
      [
        "scope miss",
        (f) => {
          f.scope.observationIds = [];
        },
      ],
      [
        "other observation tenant",
        (f) => {
          f.row.tenantId = "other";
        },
      ],
      [
        "other observation anchor",
        (f) => {
          f.row.ownerProjectId = "other";
        },
      ],
      [
        "other reference session",
        (f) => {
          f.attachment.sessionId = "other";
        },
      ],
      [
        "other reference tenant",
        (f) => {
          f.attachment.tenantId = "other";
        },
      ],
      [
        "other reference anchor",
        (f) => {
          f.attachment.ownerProjectId = "other";
        },
      ],
      [
        "different artifact",
        (f) => {
          f.attachment.artifactId = "other";
        },
      ],
      [
        "missing artifact",
        (f) => {
          f.attachment.artifactId = null;
        },
      ],
      [
        "FAILED ref",
        (f) => {
          f.attachment.state = "FAILED";
        },
      ],
      [
        "UPLOADED ref",
        (f) => {
          f.attachment.state = "UPLOADED";
        },
      ],
      [
        "RELEASED ref",
        (f) => {
          f.attachment.state = "RELEASED";
        },
      ],
    ];
  it.each(unauthorized)(
    "%s gives the same opaque NOT_FOUND before evidence parsing",
    (_label, mutate) => {
      const { projectImportObservation: project } = api();
      const f = fixture();
      mutate(f);
      f.row.evidenceJson = '{"private":"EVIDENCE_SENTINEL"}';
      try {
        project(session, f.scope, f.row, f.attachment);
        throw new Error("Expected membership denial");
      } catch (error) {
        expect(error).toBeInstanceOf(ImportSessionError);
        if (!(error instanceof ImportSessionError)) throw error;
        expect(JSON.stringify(importSessionWire(error))).toBe(
          '{"code":"NOT_FOUND","retryable":false,"sessionId":null,"currentRevision":null,"reason":null}',
        );
      }
    },
  );

  it("keeps the extraction ordinal after selection/edits, so twins retain distinct canonical keys", () => {
    const {
      parseStoredImportObservationEvidence: parse,
      projectImportObservation: project,
    } = api();
    const f = fixture();
    const original = parse(f.row.evidenceJson);
    const sibling = parse(
      JSON.stringify({
        ...evidence(),
        reference: "row-1",
        identity: { ...evidence().identity, ordinal: 0 },
      }),
    );
    const key = (value: Evidence) => {
      const { merchant, ordinal } = value.identity;
      if (
        merchant === null ||
        ordinal === null ||
        value.amountCents === null ||
        value.dataCompra === null
      )
        throw new Error("Literal fixture has canonical facts");
      return dedupeKeyNatural({
        tenantId: "tenant",
        projectId: "pessoal",
        date: new Date(`${value.dataCompra}T00:00:00.000Z`),
        merchant,
        ordinal,
        amountCents: value.amountCents,
      });
    };
    expect(key(original)).not.toBe(key(sibling));
    Object.assign(f.scope, {
      editableDraft: { titulo: "Edited", amountCents: 1, decision: "CREATE" },
    });
    expect(project(session, f.scope, f.row, f.attachment).amountCents).toBe(
      6984,
    );
    expect(parse(f.row.evidenceJson).identity).toEqual(original.identity);
    expect(key(parse(f.row.evidenceJson))).toBe(key(original));
  });
});
