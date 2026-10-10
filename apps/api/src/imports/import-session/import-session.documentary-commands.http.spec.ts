import {
  ImportSessionAmountMeaning,
  type ImportSessionStoredDraftV1,
} from "@reformaflow/domain";
import {
  documentaryPayloadHash,
  parseContinueAnsweringCommand,
  parseDeclarationCommand,
  parseDeferCommand,
} from "./import-session-documentary.commands";
import { validateStoredDraft } from "./import-session.validation";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { ImportSessionController } from "./import-session.controller";
import { terminalDraftJson } from "./import-session.projection";

const REQUEST_A = "11111111-1111-4111-8111-111111111111";
const REQUEST_B = "22222222-2222-4222-8222-222222222222";

describe("documentary command boundary", () => {
  it.each([
    ["literalAnswer", "100,00"],
    ["field", "amountCents"],
    ["lineId", "line-1"],
    ["observationId", "observation-1"],
    ["meaningContext", ImportSessionAmountMeaning.TOTAL_PURCHASE],
    ["tenantId", "tenant-b"],
    ["normalizedDeclaration", { value: 10000 }],
    ["extra", true],
  ])("rejects caller authority in %s", (key, value) => {
    expect(() =>
      parseDeclarationCommand({
        version: 1,
        requestId: REQUEST_A,
        expectedRevision: 1,
        questionId: "question-1",
        answer: { kind: "KNOWN", value: 10000 },
        [key]: value,
      }),
    ).toThrow();
  });

  it("hashes canonical content but not the idempotency key", () => {
    const first = parseDeclarationCommand({
      version: 1,
      requestId: REQUEST_A,
      expectedRevision: 3,
      questionId: "question-1",
      answer: { kind: "KNOWN", value: 10001 },
    });
    const replay = parseDeclarationCommand({
      ...first,
      requestId: REQUEST_B,
    });
    expect(documentaryPayloadHash("session-1", "DECLARE", first)).toBe(
      documentaryPayloadHash("session-1", "DECLARE", replay),
    );
  });

  it("uses a bounded private receipt ledger with no answer or target ids", () => {
    const receipt = {
      version: 1 as const,
      requestId: REQUEST_A,
      operation: "DEFER" as const,
      outcome: "APPLIED" as const,
      revision: 2,
    };
    const draft: ImportSessionStoredDraftV1 = {
      version: 1,
      lines: [],
      selectedLineIds: [],
      questions: [],
      scope: { observationIds: [], pendingAttachmentIds: [] },
      commandLedger: {
        version: 1,
        items: [
          {
            requestId: REQUEST_A,
            operation: "DEFER",
            payloadHash: "a".repeat(64),
            expectedRevision: 1,
            result: receipt,
            actorUserId: "actor-1",
            recordedAt: "2026-10-09T14:32:30.988Z",
          },
        ],
      },
    };
    expect(validateStoredDraft(draft)).toEqual(draft);
    expect(JSON.stringify(draft.commandLedger)).not.toContain("line-1");
    expect(JSON.stringify(draft.commandLedger)).not.toContain("10001");
    const scrubbed = JSON.parse(
      terminalDraftJson(JSON.stringify(draft)),
    ) as ImportSessionStoredDraftV1;
    expect(scrubbed.commandLedger).toEqual(draft.commandLedger);
    expect(scrubbed.lines).toEqual([]);
    expect(scrubbed.questions).toEqual([]);
    expect(scrubbed.scope).toEqual({
      observationIds: [],
      pendingAttachmentIds: [],
    });
  });

  it("strictly parses defer without accepting a full line", () => {
    expect(
      parseDeferCommand({
        version: 1,
        requestId: REQUEST_A,
        expectedRevision: 1,
        lineId: "line-1",
      }),
    ).toMatchObject({ lineId: "line-1" });
    expect(() =>
      parseDeferCommand({
        version: 1,
        requestId: REQUEST_A,
        expectedRevision: 1,
        lineId: "line-1",
        line: {},
      }),
    ).toThrow();
  });

  it("strictly parses continue answering without accepting browser-selected lines", () => {
    expect(
      parseContinueAnsweringCommand({
        version: 1,
        requestId: REQUEST_A,
        expectedRevision: 30,
      }),
    ).toEqual({
      version: 1,
      requestId: REQUEST_A,
      expectedRevision: 30,
    });
    for (const extra of [
      { lineIds: ["line-1"] },
      { selectedLineIds: ["line-1"] },
      { deferredObservationIds: ["observation-1"] },
      { purpose: "ANSWER_PENDING" },
    ]) {
      expect(() =>
        parseContinueAnsweringCommand({
          version: 1,
          requestId: REQUEST_A,
          expectedRevision: 30,
          ...extra,
        }),
      ).toThrow();
    }
  });

  it("does not register the browser-generic PATCH draft mutation", () => {
    const routes = Object.getOwnPropertyNames(
      ImportSessionController.prototype,
    ).flatMap((name) => {
      const handler = Reflect.get(
        ImportSessionController.prototype,
        name,
      ) as unknown;
      if (typeof handler !== "function") return [];
      return [
        [
          Reflect.getMetadata(METHOD_METADATA, handler),
          Reflect.getMetadata(PATH_METADATA, handler),
        ],
      ];
    });
    expect(routes).not.toContainEqual([RequestMethod.PATCH, ":id/draft"]);
    expect(routes).not.toContainEqual([RequestMethod.POST, ":id/prepare"]);
    expect(routes).toContainEqual([
      RequestMethod.POST,
      ":id/current-lot/prepare",
    ]);
    expect(routes).toContainEqual([
      RequestMethod.POST,
      ":id/current-lot/continue",
    ]);
  });
});
