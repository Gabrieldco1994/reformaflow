import { beforeEach, describe, expect, it, vi } from "vitest";
import { uploadImportSessionAttachment } from "./import-session-api";
import {
  ImportWorkflowResponseError,
  readImportWorkflowView,
} from "./import-session-workflow-read";

const api = vi.hoisted(() => ({
  putBytes: vi.fn(),
}));
vi.mock("@/lib/api", () => ({
  api: {
    putBytes: api.putBytes,
  },
  ApiResponseError: class ApiResponseError extends Error {},
}));

const sourceAttachment = {
  id: "source",
  fileName: "original.csv",
  declaredBytes: 3,
  state: "ATTACHED",
  materializedInSession: true,
  canAnalyze: false,
};
const view = {
  version: 1,
  id: "session",
  ownerProjectId: "project",
  cardId: "card",
  state: "DRAFT",
  revision: 2,
  expiresAt: "2026-10-16T21:00:00.000Z",
  attachments: [sourceAttachment],
  lines: [],
  selectedLineIds: [],
  questions: [],
  declaredFacts: [],
  reviewBlockers: [],
  searchComplete: false,
  proposal: null,
  confirmation: null,
  receipt: null,
  actions: ["UPLOAD", "CANCEL"],
};

describe("readImportWorkflowView analysisOutcome contract", () => {
  it("accepts historical views without adding analysisOutcome", () => {
    const result = readImportWorkflowView(view);

    expect(result).toEqual(view);
    expect(Object.hasOwn(result, "analysisOutcome")).toBe(false);
  });

  it.each([null, "NO_ELIGIBLE_PURCHASES"])(
    "accepts and preserves analysisOutcome %s",
    (analysisOutcome) => {
      const response = { ...view, analysisOutcome };

      expect(readImportWorkflowView(response)).toEqual(response);
    },
  );

  it.each([
    undefined,
    "",
    "UNKNOWN",
    "no_eligible_purchases",
    0,
    false,
    [],
    {},
    { kind: "NO_ELIGIBLE_PURCHASES" },
  ])("rejects invalid analysisOutcome %j", (analysisOutcome) => {
    expect(() => readImportWorkflowView({ ...view, analysisOutcome })).toThrow(
      ImportWorkflowResponseError,
    );
  });

  it("still rejects unknown keys with a valid analysisOutcome", () => {
    expect(() =>
      readImportWorkflowView({
        ...view,
        analysisOutcome: "NO_ELIGIBLE_PURCHASES",
        unexpected: true,
      }),
    ).toThrow(ImportWorkflowResponseError);
  });

  it("still validates required fields with a valid analysisOutcome", () => {
    expect(() =>
      readImportWorkflowView({
        ...view,
        analysisOutcome: null,
        searchComplete: null,
      }),
    ).toThrow(ImportWorkflowResponseError);
  });
});

describe("uploadImportSessionAttachment response validation", () => {
  beforeEach(() => api.putBytes.mockReset());

  it("accepts a normal attached upload view", async () => {
    api.putBytes.mockResolvedValue({
      ...view,
      attachments: [
        sourceAttachment,
        {
          id: "requested",
          fileName: "renamed.csv",
          declaredBytes: 3,
          state: "ATTACHED",
          materializedInSession: false,
          canAnalyze: false,
        },
      ],
    });

    await expect(
      uploadImportSessionAttachment("session", "requested", new Blob(["csv"])),
    ).resolves.toEqual({
      ...view,
      attachments: [
        sourceAttachment,
        {
          id: "requested",
          fileName: "renamed.csv",
          declaredBytes: 3,
          state: "ATTACHED",
          materializedInSession: false,
          canAnalyze: false,
        },
      ],
    });
  });

  it("accepts explicit deduplication for the requested attachment and returns its view", async () => {
    api.putBytes.mockResolvedValue({
      kind: "DEDUPLICATED",
      attachmentId: "requested",
      view,
    });

    await expect(
      uploadImportSessionAttachment("session", "requested", new Blob(["csv"])),
    ).resolves.toEqual({
      kind: "DEDUPLICATED",
      attachmentId: "requested",
      view,
    });
  });

  it.each([
    [
      "a different attachment ID",
      { kind: "DEDUPLICATED", attachmentId: "other", view },
    ],
    [
      "a response view for another session",
      {
        kind: "DEDUPLICATED",
        attachmentId: "requested",
        view: { ...view, id: "other-session" },
      },
    ],
    ["a missing view", { kind: "DEDUPLICATED", attachmentId: "requested" }],
    [
      "a malformed projected view",
      {
        kind: "DEDUPLICATED",
        attachmentId: "requested",
        view: { ...view, unexpected: true },
      },
    ],
    [
      "an unrecognized response shape",
      { kind: "DEDUPLICATED", attachmentId: "requested", view, extra: true },
    ],
  ])("rejects %s", async (_description, response) => {
    api.putBytes.mockResolvedValue(response);

    await expect(
      uploadImportSessionAttachment("session", "requested", new Blob(["csv"])),
    ).rejects.toThrow();
  });
});
