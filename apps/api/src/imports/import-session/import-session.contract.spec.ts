require("../../../../../scripts/test-db-env.cjs");

import { PrismaClient, type ImportSession, type Prisma } from "@prisma/client";
import {
  ExpenseType,
  type ExpenseScheduleV1,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import * as ts from "typescript";
import { authFor } from "../../test-utils/import-session-harness";
import {
  assertLockedImportSession,
  assertPreparedCardBatch,
  consumePreparedCardBatch,
  mintLockedImportSession,
  mintPreparedCardBatch,
  releaseLockedImportSession,
  type LockedImportSession,
  type PreparedCardBatch,
} from "./import-session.contract";

const actor = { id: "owner", tenantId: "tenant", sessionVersion: 7 };
const instant = "2026-10-07T02:00:00.000Z";
const requiredDates = [
  "consentedAt",
  "createdAt",
  "updatedAt",
  "lastUserEditAt",
  "expiresAt",
] as const;
const nullableDates = ["confirmedAt", "closedAt"] as const;

function row(): ImportSession {
  return {
    id: "session",
    tenantId: actor.tenantId,
    ownerUserId: actor.id,
    ownerProjectId: "project",
    cardId: "card",
    protocolVersion: 1,
    kind: "CREATE_CARD_PURCHASES",
    state: "CONFIRMED",
    revision: 9,
    createRequestId: "123e4567-e89b-42d3-a456-426614174000",
    createPayloadHash: "a".repeat(64),
    consentPolicyVersion: 1,
    consentedAt: new Date(instant),
    createdAt: new Date(instant),
    updatedAt: new Date(instant),
    lastUserEditAt: new Date(instant),
    expiresAt: new Date("2026-10-14T02:00:00.000Z"),
    draftJson: "{}",
    searchJson: null,
    proposalJson: null,
    proposalHash: null,
    preflightHash: null,
    challengeJson: null,
    prepareGeneration: 3,
    prepareLeaseJson: null,
    financialRequestId: null,
    confirmedRevision: 8,
    confirmedSessionVersion: 7,
    confirmedAt: new Date(instant),
    receiptJson: null,
    closedAt: new Date(instant),
  };
}

function draft(): ImportSessionStoredDraftV1 {
  return {
    version: 1,
    lines: [
      {
        id: "line",
        observationIds: ["observation"],
        titulo: "Compra",
        fornecedor: null,
        tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
        categoriaMaoDeObra: null,
        amountMeaning: "TOTAL_PURCHASE",
        amountCents: 10000,
        installmentCount: 1,
        dataCompra: "2026-10-07",
        firstDueDate: "2026-11-10",
        targets: [{ projectId: "target", roomId: null, amountCents: 10000 }],
        decision: { kind: "CREATE", acceptNaturalDuplicate: false },
      },
    ],
    selectedLineIds: ["line"],
    questions: [
      { id: "question", lineIds: ["line"], field: "targets", text: "Destino?" },
    ],
    scope: {
      observationIds: ["observation"],
      pendingAttachmentIds: ["attachment"],
    },
  };
}

function data(): Pick<
  PreparedCardBatch,
  "proposal" | "preflightHash" | "observations" | "expandedCounts"
> {
  const schedule: ExpenseScheduleV1 = {
    version: 1,
    occurrences: [
      {
        index: 0,
        parcela: null,
        valor: 10000,
        data: "2026-11-10",
        invoiceDueMonth: "2026-11",
      },
    ],
  };
  const observation = {
    id: "observation",
    artifactId: "artifact",
    documentSha256: "d".repeat(64),
    reference: "page:1",
    claimVersion: 3,
    lineId: "line",
    canonicalIndex: null,
  };
  return {
    proposal: {
      version: 1,
      kind: "CREATE_CARD_PURCHASES",
      sessionId: "session",
      revision: 8,
      proposalHash: "b".repeat(64),
      lines: [
        {
          kind: "CREATE",
          lineId: "line",
          titulo: "Compra",
          fornecedor: null,
          tipoDespesa: ExpenseType.MATERIAL_CONSTRUCAO,
          categoriaMaoDeObra: null,
          dataCompra: "2026-10-07",
          totalCents: 10000,
          schedule,
          targets: [
            { projectId: "target", roomId: null, amountCents: 10000, schedule },
          ],
        },
      ],
      deferredObservationIds: ["deferred"],
      deferredAttachmentIds: ["attachment"],
      retainUntil: "2026-10-14T02:00:00.000Z",
      createdEconomicTotalCents: 10000,
      bankCashDeltaCents: 0,
      invoiceDeltas: [{ invoiceDueMonth: "2026-11", amountCents: 10000 }],
    },
    preflightHash: "c".repeat(64),
    observations: [observation],
    expandedCounts: { cashFlowEntries: 2, financialAndCoordinationWrites: 5 },
  };
}

type BindingChange = (
  inputDraft: ImportSessionStoredDraftV1,
  inputData: ReturnType<typeof data>,
) => void;

function fixture(change?: BindingChange) {
  // Unconnected, structurally typed identities only: no transaction or SQLite lock proof.
  const tx: Prisma.TransactionClient = new PrismaClient();
  const otherTx: Prisma.TransactionClient = new PrismaClient();
  const auth = authFor(actor);
  const inputRow = row();
  const inputDraft = draft();
  const inputData = data();
  change?.(inputDraft, inputData);
  const session = mintLockedImportSession(tx, auth, inputRow, inputDraft);
  const batch = mintPreparedCardBatch(tx, auth, session, inputData);
  return { tx, otherTx, auth, inputRow, inputDraft, inputData, session, batch };
}

function expectInternalFailure(action: () => unknown): void {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect(thrown).not.toHaveProperty("code");
  expect(thrown).not.toHaveProperty("status");
  expect(thrown).toHaveProperty("message", "Invalid import execution handle");
}

describe("inactive import execution handles (in-memory only)", () => {
  it("constructs both nominal types and narrows unknown without nominal casts", () => {
    const { tx, auth, session, batch } = fixture();
    const lockedCandidate: unknown = session;
    assertLockedImportSession(tx, auth, lockedCandidate);
    const locked: LockedImportSession = lockedCandidate;
    const preparedCandidate: unknown = batch;
    assertPreparedCardBatch(tx, auth, preparedCandidate);
    const prepared: PreparedCardBatch = preparedCandidate;
    expect(locked).toBe(session);
    expect(prepared).toBe(batch);
    expect(Object.isFrozen(locked)).toBe(true);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.getOwnPropertySymbols(locked)).toHaveLength(1);
    expect(Object.getOwnPropertySymbols(prepared)).toHaveLength(1);
  });

  it("allows current revision to differ from confirmed/proposal revision", () => {
    const { session, batch, tx, auth } = fixture();
    expect(session.revision).toBe(9);
    expect(session.confirmedRevision).toBe(8);
    expect(batch.proposal.revision).toBe(8);
    expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
  });

  it.each(["locked", "prepared"] as const)(
    "refuses fabricated, spread, cloned and symbol-copied %s handles",
    (kind) => {
      const { tx, auth, session, batch } = fixture();
      const original = kind === "locked" ? session : batch;
      const assert =
        kind === "locked" ? assertLockedImportSession : assertPreparedCardBatch;
      for (const candidate of [
        undefined,
        null,
        false,
        1,
        "handle",
        [],
        {},
        { ...original },
        structuredClone(original),
        Object.create(original),
        Object.defineProperties({}, Object.getOwnPropertyDescriptors(original)),
        new Proxy(original, {}),
      ]) {
        expectInternalFailure(() => assert(tx, auth, candidate));
      }
    },
  );

  it("preserves UNAUTHENTICATED 401 for forged auth on every auth-taking helper", () => {
    const { tx, auth, session, batch, inputRow, inputDraft, inputData } =
      fixture();
    for (const forged of [{ ...auth }, structuredClone(auth)]) {
      for (const action of [
        () => mintLockedImportSession(tx, forged, inputRow, inputDraft),
        () => assertLockedImportSession(tx, forged, session),
        () => mintPreparedCardBatch(tx, forged, session, inputData),
        () => assertPreparedCardBatch(tx, forged, batch),
        () => consumePreparedCardBatch(tx, forged, batch),
      ]) {
        expect(action).toThrow(
          expect.objectContaining({ code: "UNAUTHENTICATED", status: 401 }),
        );
      }
    }
    expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
  });

  it("binds exact tx identity before mint, assert and consume", () => {
    const { otherTx, tx, auth, session, batch, inputData } = fixture();
    for (const action of [
      () => assertLockedImportSession(otherTx, auth, session),
      () => mintPreparedCardBatch(otherTx, auth, session, inputData),
      () => assertPreparedCardBatch(otherTx, auth, batch),
      () => consumePreparedCardBatch(otherTx, auth, batch),
    ]) {
      expectInternalFailure(action);
    }
    expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
  });

  it("binds exact genuine auth identity, not equal claims", () => {
    const { tx, auth, session, batch, inputData } = fixture();
    const otherAuth = authFor(actor);
    expect(otherAuth).toEqual(auth);
    expect(otherAuth).not.toBe(auth);
    for (const action of [
      () => assertLockedImportSession(tx, otherAuth, session),
      () => mintPreparedCardBatch(tx, otherAuth, session, inputData),
      () => assertPreparedCardBatch(tx, otherAuth, batch),
      () => consumePreparedCardBatch(tx, otherAuth, batch),
    ]) {
      expectInternalFailure(action);
    }
  });

  it.each(["tenantId", "ownerUserId"] as const)(
    "refuses a row with the wrong %s without exposing row data",
    (field) => {
      const { tx, auth, inputRow, inputDraft } = fixture();
      inputRow[field] = "private-other-owner-or-tenant";
      expectInternalFailure(() =>
        mintLockedImportSession(tx, auth, inputRow, inputDraft),
      );
    },
  );

  it("refuses proposal session mismatch, even under the same tx/auth", () => {
    const { tx, auth, session, inputData } = fixture();
    inputData.proposal.sessionId = "other-session";
    expectInternalFailure(() =>
      mintPreparedCardBatch(tx, auth, session, inputData),
    );
  });

  it("release is idempotent for a known handle and invalidates all its batches", () => {
    const { tx, auth, session, batch, inputData } = fixture();
    const sibling = mintPreparedCardBatch(tx, auth, session, inputData);
    releaseLockedImportSession(session);
    expect(() => releaseLockedImportSession(session)).not.toThrow();
    expectInternalFailure(() => assertLockedImportSession(tx, auth, session));
    expectInternalFailure(() =>
      mintPreparedCardBatch(tx, auth, session, inputData),
    );
    for (const candidate of [batch, sibling]) {
      expectInternalFailure(() => assertPreparedCardBatch(tx, auth, candidate));
      expectInternalFailure(() =>
        consumePreparedCardBatch(tx, auth, candidate),
      );
    }
  });

  it("unknown release fails closed and does not release the original", () => {
    const { tx, auth, session, batch } = fixture();
    expectInternalFailure(() => releaseLockedImportSession({ ...session }));
    expectInternalFailure(() =>
      releaseLockedImportSession(structuredClone(session)),
    );
    expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
  });

  it("release is bound to the original handle, not another mint of the same row", () => {
    const { tx, auth, session, batch, inputRow, inputDraft } = fixture();
    const retry = mintLockedImportSession(tx, auth, inputRow, inputDraft);
    releaseLockedImportSession(retry);
    expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
    releaseLockedImportSession(session);
    expectInternalFailure(() => assertPreparedCardBatch(tx, auth, batch));
  });

  it("old preview/retry handles stay dead when a new session handle is minted", () => {
    const { tx, auth, session, batch, inputRow, inputDraft, inputData } =
      fixture();
    releaseLockedImportSession(session);
    const retry = mintLockedImportSession(tx, auth, inputRow, inputDraft);
    const freshBatch = mintPreparedCardBatch(tx, auth, retry, inputData);
    expectInternalFailure(() => consumePreparedCardBatch(tx, auth, batch));
    expect(() => consumePreparedCardBatch(tx, auth, freshBatch)).not.toThrow();
  });

  it("consume marks the instance before effects and refuses a second use", () => {
    const { tx, auth, session, batch } = fixture();
    let effects = 0;
    consumePreparedCardBatch(tx, auth, batch);
    expectInternalFailure(() => assertPreparedCardBatch(tx, auth, batch));
    expectInternalFailure(() => {
      consumePreparedCardBatch(tx, auth, batch);
      effects += 1;
    });
    expect(effects).toBe(0);
    expect(() => assertLockedImportSession(tx, auth, session)).not.toThrow();
    expect(() => releaseLockedImportSession(session)).not.toThrow();
  });

  it("consumption is per instance, not database idempotency for the logical operation", () => {
    const { tx, auth, session, batch, inputData } = fixture();
    const sibling = mintPreparedCardBatch(tx, auth, session, inputData);
    consumePreparedCardBatch(tx, auth, batch);
    expect(() => consumePreparedCardBatch(tx, auth, sibling)).not.toThrow();
  });

  it("copies the row and deeply snapshots parsed inputs without aliases", () => {
    const { tx, auth, session, batch, inputRow, inputDraft, inputData } =
      fixture();
    const expectedDraft = structuredClone(inputDraft);
    const expectedData = structuredClone(inputData);
    inputRow.id = "changed";
    inputRow.revision = 100;
    inputRow.confirmedRevision = 99;
    inputDraft.scope.observationIds.push("changed");
    inputDraft.lines[0].observationIds.push("changed");
    inputDraft.lines[0].decision = { kind: "UNRESOLVED" };
    inputDraft.questions[0].lineIds.push("changed");
    inputDraft.selectedLineIds.pop();
    inputData.proposal.sessionId = "changed";
    inputData.proposal.lines[0].schedule.occurrences[0].valor = 1;
    inputData.proposal.invoiceDeltas[0].amountCents = 1;
    inputData.proposal.deferredObservationIds.push("changed");
    inputData.proposal.deferredAttachmentIds.push("changed");
    expect(Reflect.set(inputData.observations[0], "reference", "changed")).toBe(
      true,
    );
    expect(Reflect.set(inputData.expandedCounts, "cashFlowEntries", 999)).toBe(
      true,
    );
    expect(session.id).toBe("session");
    expect(session.revision).toBe(9);
    expect(session.confirmedRevision).toBe(8);
    expect(session.draft).toEqual(expectedDraft);
    expect(batch).toMatchObject(expectedData);
    expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
  });

  it("freezes every nested snapshot object, including arrays and schedules", () => {
    const { session, batch } = fixture();
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      expect(Object.isFrozen(value)).toBe(true);
      for (const child of Object.values(value)) visit(child);
    };
    visit(session.draft);
    visit(batch);
    expect(() => session.draft.scope.observationIds.push("changed")).toThrow(
      expect.objectContaining({ name: "TypeError" }),
    );
    expect(() => {
      batch.proposal.lines[0].schedule.occurrences[0].valor = 1;
    }).toThrow(expect.objectContaining({ name: "TypeError" }));
    expect(Reflect.set(batch.observations[0], "reference", "changed")).toBe(
      false,
    );
    expect(Reflect.set(session, "revision", 99)).toBe(false);
  });

  it.each([...requiredDates, ...nullableDates])(
    "captures %s and returns Date copies immune to setTime and input replacement",
    (field) => {
      const { tx, auth, session, batch, inputRow } = fixture();
      const original = inputRow[field];
      const exposed = session[field];
      expect(original).toBeInstanceOf(Date);
      expect(exposed).toBeInstanceOf(Date);
      const timestamp = original?.getTime();
      original?.setTime(0);
      inputRow[field] = new Date(1);
      exposed?.setTime(2);
      expect(session[field]?.getTime()).toBe(timestamp);
      expect(session[field]).not.toBe(session[field]);
      expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
    },
  );

  it.each(nullableDates)(
    "preserves nullable %s without inventing a Date",
    (field) => {
      const { tx, auth, inputRow, inputDraft } = fixture();
      inputRow[field] = null;
      const session = mintLockedImportSession(tx, auth, inputRow, inputDraft);
      inputRow[field] = new Date(instant);
      expect(session[field]).toBeNull();
    },
  );
});

describe("inactive prepared observation binding guard", () => {
  const invalidCoverage: Array<[string, BindingChange]> = [
    [
      "no selected lines",
      (draft, value) => {
        draft.selectedLineIds = [];
        value.proposal.lines = [];
        Reflect.set(value, "observations", []);
      },
    ],
    [
      "duplicate selected line",
      (draft) => {
        draft.selectedLineIds.push("line");
      },
    ],
    [
      "selected line absent from locked draft",
      (draft) => {
        draft.selectedLineIds = ["absent"];
      },
    ],
    [
      "ambiguous locked draft line",
      (draft) => {
        draft.lines.push(structuredClone(draft.lines[0]));
      },
    ],
    [
      "selected line without observations",
      (draft, value) => {
        draft.lines[0].observationIds = [];
        Reflect.set(value, "observations", []);
      },
    ],
    [
      "selected observation outside scope",
      (draft) => {
        draft.scope.observationIds = [];
      },
    ],
    [
      "duplicate observation inside selected line",
      (draft) => {
        draft.lines[0].observationIds.push("observation");
      },
    ],
    [
      "selected observation marked deferred",
      (_draft, value) => {
        value.proposal.deferredObservationIds.push("observation");
      },
    ],
    [
      "missing proposal line",
      (_draft, value) => {
        value.proposal.lines = [];
      },
    ],
    [
      "extra proposal line",
      (_draft, value) => {
        value.proposal.lines.push({
          ...value.proposal.lines[0],
          lineId: "extra",
        });
      },
    ],
    [
      "duplicate proposal line",
      (_draft, value) => {
        value.proposal.lines.push(structuredClone(value.proposal.lines[0]));
      },
    ],
    [
      "missing observation",
      (_draft, value) => {
        Reflect.set(value, "observations", []);
      },
    ],
    [
      "duplicate observation binding",
      (_draft, value) => {
        Reflect.set(value, "observations", [
          value.observations[0],
          structuredClone(value.observations[0]),
        ]);
      },
    ],
    [
      "deferred observation binding",
      (draft, value) => {
        draft.scope.observationIds.push("deferred");
        Reflect.set(value, "observations", [
          ...value.observations,
          { ...value.observations[0], id: "deferred" },
        ]);
      },
    ],
    [
      "unknown observation binding",
      (_draft, value) => {
        Reflect.set(value.observations[0], "id", "absent");
      },
    ],
    [
      "wrong binding line",
      (_draft, value) => {
        Reflect.set(value.observations[0], "lineId", "other");
      },
    ],
    [
      "missing binding line",
      (_draft, value) => {
        Reflect.deleteProperty(value.observations[0], "lineId");
      },
    ],
    [
      "missing binding index",
      (_draft, value) => {
        Reflect.deleteProperty(value.observations[0], "canonicalIndex");
      },
    ],
  ];
  it.each(invalidCoverage)(
    "rejects %s without minting a prepared handle",
    (_name, change) => {
      expectInternalFailure(() => fixture(change));
    },
  );

  it.each([
    undefined,
    -1,
    0.5,
    1,
    Number.MAX_SAFE_INTEGER + 1,
    NaN,
    Infinity,
    "0",
    false,
  ])(
    "rejects invalid source index %p (the source has one occurrence)",
    (index) =>
      expectInternalFailure(() =>
        fixture((_draft, value) => {
          Reflect.set(value.observations[0], "canonicalIndex", index);
        }),
      ),
  );
  it.each([
    ["id", ""],
    ["artifactId", "not/an/id"],
    ["documentSha256", "a".repeat(32)],
    ["documentSha256", "D".repeat(64)],
    ["reference", ""],
    ["reference", "x".repeat(193)],
    ["reference", "e\u0301"],
    ["claimVersion", -1],
    ["claimVersion", 0.1],
    ["claimVersion", Number.MAX_SAFE_INTEGER + 1],
    ["claimVersion", "3"],
  ])("rejects malformed existing %s identity/version", (field, value) => {
    expectInternalFailure(() =>
      fixture((_draft, input) => {
        Reflect.set(input.observations[0], field, value);
      }),
    );
  });

  function twoLines(
    inputDraft: ImportSessionStoredDraftV1,
    inputData: ReturnType<typeof data>,
  ) {
    inputDraft.lines.push({
      ...structuredClone(inputDraft.lines[0]),
      id: "second",
      observationIds: ["observation-2"],
    });
    inputDraft.selectedLineIds.push("second");
    inputDraft.scope.observationIds.push("observation-2");
    inputData.proposal.lines.push({
      ...structuredClone(inputData.proposal.lines[0]),
      lineId: "second",
    });
    Reflect.set(inputData, "observations", [
      ...inputData.observations,
      {
        ...inputData.observations[0],
        id: "observation-2",
        reference: "page:2",
        lineId: "second",
        canonicalIndex: 0,
      },
    ]);
  }
  it("rejects two selected lines sharing an observation", () => {
    expectInternalFailure(() =>
      fixture((draft, value) => {
        twoLines(draft, value);
        draft.lines[1].observationIds = ["observation"];
      }),
    );
  });
  it("rejects swapped bindings even when line and observation sets are individually exact", () => {
    expectInternalFailure(() =>
      fixture((draft, value) => {
        twoLines(draft, value);
        Reflect.set(value.observations[0], "lineId", "second");
        Reflect.set(value.observations[1], "lineId", "line");
      }),
    );
  });
  it("accepts shuffled bindings/proposal lines and distinguishes null from local zero", () => {
    const { tx, auth, batch } = fixture((draft, value) => {
      twoLines(draft, value);
      value.proposal.lines.reverse();
      Reflect.set(value, "observations", [...value.observations].reverse());
    });
    expect(batch.observations).toMatchObject([
      { id: "observation-2", lineId: "second", canonicalIndex: 0 },
      { id: "observation", lineId: "line", canonicalIndex: null },
    ]);
    expect(() => assertPreparedCardBatch(tx, auth, batch)).not.toThrow();
  });
  it("accepts distinct observations of the same line and local index", () => {
    const { batch } = fixture((draft, value) => {
      draft.scope.observationIds.push("observation-2");
      draft.lines[0].observationIds.push("observation-2");
      Reflect.set(value.observations[0], "canonicalIndex", 0);
      Reflect.set(value, "observations", [
        ...value.observations,
        {
          ...value.observations[0],
          id: "observation-2",
          reference: "page:2",
          lineId: "line",
          canonicalIndex: 0,
        },
      ]);
    });
    expect(batch.observations).toHaveLength(2);
    for (const observation of batch.observations)
      expect(observation).toMatchObject({ lineId: "line", canonicalIndex: 0 });
  });
  it("checks the source agenda rather than a longer target agenda", () => {
    expectInternalFailure(() =>
      fixture((_draft, value) => {
        const line = value.proposal.lines[0];
        if (line.kind !== "CREATE") throw new Error("Expected CREATE fixture");
        line.targets[0].schedule = structuredClone(line.schedule);
        line.targets[0].schedule.occurrences.push({
          ...line.schedule.occurrences[0],
          index: 1,
        });
        Reflect.set(value.observations[0], "canonicalIndex", 1);
      }),
    );
  });
  it("requires the addressed source occurrence to have the canonical index", () => {
    expectInternalFailure(() =>
      fixture((_draft, value) => {
        value.proposal.lines[0].schedule.occurrences[0].index = 1;
        Reflect.set(value.observations[0], "canonicalIndex", 0);
      }),
    );
  });
  it.each([0, 1])(
    "accepts producer-proved KEEP local index %i without interpreting the printed label",
    (index) => {
      const { batch } = fixture((draft, value) => {
        draft.lines[0].decision = {
          kind: "KEEP_EXISTING",
          expenseId: "existing-source",
        };
        const source = structuredClone(value.proposal.lines[0].schedule);
        source.occurrences[0].parcela = index === 0 ? "2/10" : "1/10";
        if (index === 1)
          source.occurrences.push({
            ...source.occurrences[0],
            index: 1,
            parcela: "2/10",
          });
        value.proposal.lines = [
          {
            kind: "KEEP_EXISTING",
            lineId: "line",
            sourceExpenseId: "existing-source",
            totalCents: 10000,
            schedule: source,
          },
        ];
        Reflect.set(value.observations[0], "canonicalIndex", index);
      });
      expect(batch.observations[0]).toMatchObject({ canonicalIndex: index });
    },
  );
  it("snapshots and freezes the new fields without changing public H8 or proposal shape", () => {
    const { tx, auth, session, inputData, batch } = fixture();
    Reflect.set(inputData.observations[0], "canonicalIndex", 0);
    const other = mintPreparedCardBatch(tx, auth, session, inputData);
    expect(other.proposal).toEqual(batch.proposal);
    expect(batch.proposal.proposalHash).toBe("b".repeat(64));
    Reflect.set(inputData.observations[0], "lineId", "changed");
    Reflect.set(inputData.observations[0], "canonicalIndex", 99);
    expect(batch.observations[0]).toMatchObject({
      lineId: "line",
      canonicalIndex: null,
    });
    expect(other.observations[0]).toMatchObject({
      lineId: "line",
      canonicalIndex: 0,
    });
    expect(Reflect.set(batch.observations[0], "lineId", "changed")).toBe(false);
    expect(Reflect.set(other.observations[0], "canonicalIndex", null)).toBe(
      false,
    );
  });
  it("validates the snapshot that is actually registered, not an earlier getter value", () => {
    const { tx, auth, session, inputData } = fixture();
    let reads = 0;
    Object.defineProperty(inputData.proposal, "sessionId", {
      enumerable: true,
      get: () => (++reads === 1 ? session.id : "changed"),
    });
    const batch = mintPreparedCardBatch(tx, auth, session, inputData);
    expect(batch.proposal.sessionId).toBe(session.id);
  });
});

describe("inactive runtime issuer boundaries", () => {
  it("admits only the literal A/W matrix when present; final composition must require both concrete consumers", () => {
    const src = resolve(__dirname, "../..");
    const contractPath = "imports/import-session/import-session.contract.ts";
    const allowed: Record<string, readonly string[]> = {
      mintLockedImportSession: [
        "imports/import-session/import-session-workflow.service.ts",
      ],
      assertLockedImportSession: [
        "imports/import-session/card-purchase-batch.adapter.ts",
      ],
      releaseLockedImportSession: [
        "imports/import-session/import-session-workflow.service.ts",
      ],
      mintPreparedCardBatch: [
        "imports/import-session/card-purchase-batch.adapter.ts",
      ],
      assertPreparedCardBatch: [
        "imports/import-session/import-session-workflow.service.ts",
      ],
      consumePreparedCardBatch: [
        "imports/import-session/card-purchase-batch.adapter.ts",
      ],
    };
    const walk = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? walk(path) : [path];
      });
    const production = walk(src).filter(
      (path) =>
        path.endsWith(".ts") &&
        !/\.(spec|test|d)\.ts$/.test(path) &&
        !relative(src, path).startsWith("test-utils/") &&
        relative(src, path) !== contractPath,
    );
    const present = new Set(production.map((path) => relative(src, path)));
    for (const [name, paths] of Object.entries(allowed)) {
      const consumers = production
        .filter((path) =>
          new RegExp(`\\b${name}\\b`).test(readFileSync(path, "utf8")),
        )
        .map((path) => relative(src, path))
        .sort();
      expect(consumers).toEqual(paths.filter((path) => present.has(path)));
    }
    const runtimeImports: string[] = [];
    const callers: Record<string, Set<string>> = {};
    const imports: Record<string, Set<string>> = {};
    for (const path of production) {
      const file = ts.createSourceFile(
        path,
        readFileSync(path, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : "";
          if (Object.prototype.hasOwnProperty.call(allowed, name))
            (callers[name] ??= new Set()).add(relative(src, path));
        }
        if (
          ts.isStringLiteral(node) &&
          /import-session\.contract$/.test(node.text)
        ) {
          const parent = node.parent;
          const clause = ts.isImportDeclaration(parent)
            ? parent.importClause
            : undefined;
          const bindings = clause?.namedBindings;
          const erased =
            clause?.isTypeOnly ||
            (bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((item) => item.isTypeOnly));
          if (!erased) {
            runtimeImports.push(relative(src, path));
            expect(clause?.name).toBeUndefined();
            expect(bindings && ts.isNamedImports(bindings)).toBe(true);
            if (bindings && ts.isNamedImports(bindings)) {
              for (const item of bindings.elements.filter(
                (item) => !item.isTypeOnly,
              )) {
                expect(item.propertyName).toBeUndefined();
                (imports[item.name.text] ??= new Set()).add(
                  relative(src, path),
                );
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
    expect([...new Set(runtimeImports)].sort()).toEqual(
      [
        "imports/import-session/card-purchase-batch.adapter.ts",
        "imports/import-session/import-session-workflow.service.ts",
      ].filter((path) => present.has(path)),
    );
    for (const [name, paths] of Object.entries(allowed)) {
      const expected = paths.filter((path) => present.has(path));
      expect([...(callers[name] ?? [])].sort()).toEqual(expected);
      expect([...(imports[name] ?? [])].sort()).toEqual(expected);
    }
    expect(
      Object.keys(imports).filter(
        (name) => !Object.prototype.hasOwnProperty.call(allowed, name),
      ),
    ).toEqual([]);
  });

  it("publishes the full private preparation union and verifier-only types, with no runtime search implementation", () => {
    const file = join(__dirname, "shared-types.contract-check.ts");
    const input = `
      import type { CardPurchasePreparation, StoredImportSearchV1, SearchStage } from "./card-purchase-batch.port";
      import type { UiImportFinancialActionVerifier, UiImportFinancialActionScope, SelectedImportObservation } from "./import-session.contract";
      type Assert<T extends true> = T;
      type Equal<A, B> = [A, B] extends [B, A] ? true : false;
      type Ready = Extract<CardPurchasePreparation, { kind: "READY" }>;
      type Incomplete = Exclude<CardPurchasePreparation, Ready>;
      type Kinds = Assert<Equal<CardPurchasePreparation["kind"], "READY" | "NEEDS_INPUT" | "REVIEW_REQUIRED">>;
      type FullReady = Assert<Equal<Ready["search"], StoredImportSearchV1 & { complete: true }>>;
      type FullIncomplete = Assert<Equal<Incomplete["search"], StoredImportSearchV1>>;
      type Stages = Assert<Equal<SearchStage, "DOCUMENT_IDENTITY" | "CROSS_ORIGIN" | "CARD_IDENTITY">>;
      type Recipe = Assert<Equal<StoredImportSearchV1["coverage"]["recipe"], "CARD_PURCHASE_V1">>;
      type VerifierOnly = Assert<Equal<keyof UiImportFinancialActionVerifier, "verifyFinancialAction">>;
      type VoidReturn = Assert<Equal<ReturnType<UiImportFinancialActionVerifier["verifyFinancialAction"]>, void>>;
      type Binding = Assert<Equal<Pick<SelectedImportObservation, "lineId" | "canonicalIndex">,
        { readonly lineId: string; readonly canonicalIndex: number | null }>>;
      declare let observation: SelectedImportObservation;
      // @ts-expect-error the line binding is required
      const missingLine: SelectedImportObservation = {} as Omit<SelectedImportObservation, "lineId">;
      // @ts-expect-error null is explicit; absence is not a whole-purchase binding
      const missingIndex: SelectedImportObservation = {} as Omit<SelectedImportObservation, "canonicalIndex">;
      // @ts-expect-error the producer cannot mutate a prepared line binding
      observation.lineId = "changed";
      // @ts-expect-error the producer cannot mutate a prepared occurrence binding
      observation.canonicalIndex = 1;
      declare const ready: Ready;
      const incomplete: Incomplete = { kind: "NEEDS_INPUT", draft: ready.draft, search: ready.search };
      // @ts-expect-error incomplete preparation cannot smuggle even a genuine batch
      const withBatch: Incomplete = { ...incomplete, batch: ready.batch };
      // @ts-expect-error a merely boolean complete is not certified READY
      const partialReady: Ready = { ...ready, search: incomplete.search };
      // @ts-expect-error a batch is opaque, not a structural object
      const fakeReady: Ready = { ...ready, batch: {} };
      declare let scope: UiImportFinancialActionScope;
      // @ts-expect-error scope is immutable
      scope.sessionId = "changed";
    `;
    const options: ts.CompilerOptions = {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      experimentalDecorators: true,
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    host.readFile = (name) => (name === file ? input : read(name));
    host.fileExists = (name) => name === file || exists(name);
    const program = ts.createProgram([file], options, host);
    expect(
      ts
        .getPreEmitDiagnostics(program)
        .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n")),
    ).toEqual([]);
  });
});
