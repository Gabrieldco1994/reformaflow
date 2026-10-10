import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import type {
  ImportSessionCandidateV1,
  ImportSessionEditRequestV1,
  ImportSessionObservationViewV1,
  ImportSessionPageV1,
  ImportSessionRevisionRequestV1,
} from "@reformaflow/domain";
import { ApiResponseError, ApiTimeoutError } from "@/lib/api";
import {
  editImportSession,
  getImportCandidates,
  getImportObservations,
  prepareImportSession,
} from "./import-session-api";
import { workflowFixture } from "./import-workflow-fixtures";
import { viewFixture } from "./import-session-fixtures";

const observation = (): ImportSessionObservationViewV1 => ({
  id: "observation-a",
  attachmentId: "attachment-a",
  reference: "page:1/row:1",
  text: "",
  amountMeaning: "UNKNOWN",
  amountCents: null,
  installmentCount: null,
  installmentIndex: null,
  dataCompra: null,
});
const candidate = (): ImportSessionCandidateV1 => ({
  lineId: "first",
  kind: "EXPENSE",
  id: "existing-a",
  projectId: "personal",
  description: "",
  amountCents: 0,
  date: "2026-10-07",
  reason: "STRONG_IDENTITY",
  canKeepExisting: false,
});
const editRequest = (): ImportSessionEditRequestV1 => ({
  expectedRevision: 6,
  questionId: null,
  replaceLines: workflowFixture().lines,
  selectedLineIds: ["first", "twin"],
});
const revisionRequest: ImportSessionRevisionRequestV1 = { expectedRevision: 6 };
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status });
const fetchStub = vi.fn<typeof fetch>();
const cursor = "opaque.+/=&? #%";

beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal("fetch", fetchStub);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function expectRequest(path: string, method: string, body?: unknown) {
  expect(fetchStub).toHaveBeenCalledTimes(1);
  const [url, options] = fetchStub.mock.calls[0];
  const parsed = new URL(String(url), "http://localhost:3001");
  expect(parsed.pathname + parsed.search).toBe(path);
  expect(options?.method ?? "GET").toBe(method);
  expect(options?.body).toBe(
    body === undefined ? undefined : JSON.stringify(body),
  );
  expect(options?.credentials).toBe("include");
  expect(options?.headers).toEqual({
    "Content-Type": "application/json",
    ...(method === "GET" ? {} : { "x-rf-import-ui": "1" }),
  });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
}

const writes = [
  {
    name: "edit",
    method: "PATCH",
    suffix: "draft",
    request: editRequest(),
    call: (id = "session-a") => editImportSession(id, editRequest()),
  },
  {
    name: "prepare",
    method: "POST",
    suffix: "prepare",
    request: revisionRequest,
    call: (id = "session-a") => prepareImportSession(id, revisionRequest),
  },
];
const reads = [
  {
    name: "observations",
    item: observation,
    call: (next?: string | null) => getImportObservations("session-a", next),
    path: "/import-sessions/session-a/observations",
  },
  {
    name: "candidates",
    item: candidate,
    call: (next?: string | null) =>
      getImportCandidates("session-a", "first", next),
    path: "/import-sessions/session-a/candidates?lineId=first",
  },
];

describe("four inactive clients: production API helper and readers, fetch stub only", () => {
  it("keeps domain page types and a required candidate lineId", () => {
    expectTypeOf(getImportCandidates).parameters.toEqualTypeOf<
      [id: string, lineId: string, cursor?: string | null]
    >();
    expectTypeOf(getImportCandidates).returns.resolves.toEqualTypeOf<
      ImportSessionPageV1<ImportSessionCandidateV1>
    >();
    expectTypeOf(getImportObservations).returns.resolves.toEqualTypeOf<
      ImportSessionPageV1<ImportSessionObservationViewV1>
    >();
  });

  describe.each(writes)("$name", ({ call, method, suffix, request }) => {
    it("sends the exact request with UI admission and preserves the full view", async () => {
      const full = { ...workflowFixture(), actions: [] };
      fetchStub.mockResolvedValue(response(full));
      await expect(call()).resolves.toEqual(full);
      expectRequest(`/import-sessions/session-a/${suffix}`, method, request);
    });

    it("preserves a complete draft with null proposal, confirmation and receipt", async () => {
      const full = viewFixture({ id: "session-a" });
      fetchStub.mockResolvedValue(response(full));
      await expect(call()).resolves.toEqual(full);
    });

    it("encodes the session id even when the server rejects it", async () => {
      fetchStub.mockResolvedValue(response({ message: "Invalid id" }, 400));
      await expect(call("s/a ?#")).rejects.toBeInstanceOf(ApiResponseError);
      expectRequest(
        `/import-sessions/s%2Fa%20%3F%23/${suffix}`,
        method,
        request,
      );
    });

    it.each([
      [
        "reduced recovery view",
        () => {
          const {
            id,
            ownerProjectId,
            cardId,
            state,
            revision,
            expiresAt,
            actions,
          } = viewFixture({ id: "session-a" });
          return {
            id,
            ownerProjectId,
            cardId,
            state,
            revision,
            expiresAt,
            actions,
            attachments: [],
            lines: [],
            questions: [],
          };
        },
      ],
      [
        "missing searchComplete",
        () => {
          const { searchComplete: _, ...rest } = workflowFixture();
          return rest;
        },
      ],
      [
        "wrong requested session",
        () => {
          const full = workflowFixture();
          return {
            ...full,
            id: "other",
            proposal: { ...full.proposal, sessionId: "other" },
          };
        },
      ],
      [
        "proposal session drift",
        () => {
          const full = workflowFixture();
          return {
            ...full,
            proposal: { ...full.proposal, sessionId: "other" },
          };
        },
      ],
      [
        "proposal revision drift",
        () => {
          const full = workflowFixture();
          return { ...full, proposal: { ...full.proposal, revision: 5 } };
        },
      ],
      [
        "unknown selected line",
        () => ({ ...workflowFixture(), selectedLineIds: ["absent"] }),
      ],
      [
        "incoherent economic total",
        () => {
          const full = workflowFixture();
          return {
            ...full,
            proposal: { ...full.proposal, createdEconomicTotalCents: 1 },
          };
        },
      ],
    ] as const)(
      "rejects %s through the full reader",
      async (_name, corrupt) => {
        fetchStub.mockResolvedValue(response(corrupt()));
        await expect(call()).rejects.toMatchObject({
          name: "ImportMalformedResponseError",
        });
        expect(fetchStub).toHaveBeenCalledTimes(1);
      },
    );
  });

  describe.each(reads)("$name page", ({ call, item, path }) => {
    it.each([undefined, null])(
      "omits only an absent cursor (%s)",
      async (next) => {
        const page = { items: [], nextCursor: null };
        fetchStub.mockResolvedValue(response(page));
        await expect(call(next)).resolves.toEqual(page);
        expectRequest(path, "GET");
      },
    );

    it("encodes and preserves an opaque cursor without auto-pagination or completeness inference", async () => {
      const page = { items: [item()], nextCursor: cursor };
      fetchStub.mockResolvedValue(response(page));
      await expect(call(cursor)).resolves.toEqual(page);
      expectRequest(
        `${path}${path.includes("?") ? "&" : "?"}cursor=opaque.%2B%2F%3D%26%3F%20%23%25`,
        "GET",
      );
    });

    it("does not silently drop an invalid empty cursor", async () => {
      fetchStub.mockResolvedValue(response({ message: "Invalid cursor" }, 400));
      await expect(call("")).rejects.toBeInstanceOf(ApiResponseError);
      expectRequest(`${path}${path.includes("?") ? "&" : "?"}cursor=`, "GET");
    });

    it("accepts exactly 25 distinct entries without treating null cursor as searchComplete", async () => {
      const page = {
        items: Array.from({ length: 25 }, (_, i) => ({
          ...item(),
          id: `item-${i}`,
        })),
        nextCursor: null,
      };
      fetchStub.mockResolvedValue(response(page));
      await expect(call()).resolves.toEqual(page);
    });

    const badPages: Array<[string, () => unknown]> = [
      ["null", () => null],
      ["missing items", () => ({ nextCursor: null })],
      ["missing cursor", () => ({ items: [] })],
      ["non-array items", () => ({ items: {}, nextCursor: null })],
      ["null item", () => ({ items: [null], nextCursor: null })],
      ["empty item", () => ({ items: [{}], nextCursor: null })],
      ["numeric cursor", () => ({ items: [], nextCursor: 0 })],
      ["object cursor", () => ({ items: [], nextCursor: {} })],
      ["empty cursor", () => ({ items: [], nextCursor: "" })],
      [
        "extra private page field",
        () => ({ items: [], nextCursor: null, scope: {} }),
      ],
      [
        "invented completeness",
        () => ({ items: [], nextCursor: null, searchComplete: true }),
      ],
      [
        "extra private item field",
        () => ({
          items: [{ ...item(), evidenceJson: "{}" }],
          nextCursor: null,
        }),
      ],
      [
        "duplicate identity",
        () => ({ items: [item(), item()], nextCursor: null }),
      ],
      [
        "26 entries",
        () => ({
          items: Array.from({ length: 26 }, (_, i) => ({
            ...item(),
            id: `item-${i}`,
          })),
          nextCursor: null,
        }),
      ],
    ];
    it.each(badPages)(
      "rejects %s, never an empty-page fallback",
      async (_name, corrupt) => {
        fetchStub.mockResolvedValue(response(corrupt()));
        await expect(call()).rejects.toMatchObject({
          name: "ImportMalformedResponseError",
        });
        expect(fetchStub).toHaveBeenCalledTimes(1);
      },
    );
  });

  it("encodes GET ids and the required lineId without adding unsupported filters", async () => {
    fetchStub.mockImplementation(async () =>
      response({ items: [], nextCursor: null }),
    );
    await getImportObservations("s/a ?#");
    expectRequest("/import-sessions/s%2Fa%20%3F%23/observations", "GET");
    fetchStub.mockClear();
    await getImportCandidates("s/a ?#", "line/a +?&", cursor);
    expectRequest(
      "/import-sessions/s%2Fa%20%3F%23/candidates?lineId=line%2Fa%20%2B%3F%26&cursor=opaque.%2B%2F%3D%26%3F%20%23%25",
      "GET",
    );
  });

  it("does not silently drop an empty required lineId", async () => {
    fetchStub.mockResolvedValue(response({ message: "Invalid lineId" }, 400));
    await expect(getImportCandidates("session-a", "")).rejects.toBeInstanceOf(
      ApiResponseError,
    );
    expectRequest("/import-sessions/session-a/candidates?lineId=", "GET");
  });

  it("rejects a candidate from a different line", async () => {
    fetchStub.mockResolvedValue(
      response({
        items: [candidate(), { ...candidate(), id: "other", lineId: "twin" }],
        nextCursor: null,
      }),
    );
    await expect(
      getImportCandidates("session-a", "first"),
    ).rejects.toMatchObject({ name: "ImportMalformedResponseError" });
  });

  it("preserves documentary twins and EXPENSE/RECEIPT identities with the same id", async () => {
    const observations = {
      items: [observation(), { ...observation(), id: "twin" }],
      nextCursor: null,
    };
    fetchStub.mockResolvedValue(response(observations));
    await expect(getImportObservations("session-a")).resolves.toEqual(
      observations,
    );
    const candidates = {
      items: [
        candidate(),
        { ...candidate(), kind: "RECEIPT", reason: "NATURAL_MATCH" },
      ],
      nextCursor: null,
    };
    fetchStub.mockResolvedValue(response(candidates));
    await expect(getImportCandidates("session-a", "first")).resolves.toEqual(
      candidates,
    );
  });

  it.each([-2147483647, 0, 2147483647])(
    "preserves signed cents boundary %s",
    async (amountCents) => {
      for (const { call, item } of reads) {
        const page = { items: [{ ...item(), amountCents }], nextCursor: null };
        fetchStub.mockResolvedValue(response(page));
        await expect(call()).resolves.toEqual(page);
      }
    },
  );

  it.each([
    { installmentCount: null, installmentIndex: null },
    { installmentCount: 0, installmentIndex: 0 },
    { installmentCount: 25, installmentIndex: 24 },
    { installmentCount: -1, installmentIndex: -1 },
    { installmentCount: 9007199254740991, installmentIndex: -9007199254740991 },
  ])(
    "preserves documentary integers, not executable-purchase bounds: %j",
    async (values) => {
      const page = {
        items: [{ ...observation(), ...values }],
        nextCursor: null,
      };
      fetchStub.mockResolvedValue(response(page));
      await expect(getImportObservations("session-a")).resolves.toEqual(page);
    },
  );

  it("accepts public text/id/date boundaries and raw candidate descriptions", async () => {
    const observations = {
      items: [
        {
          ...observation(),
          id: "a".repeat(191),
          attachmentId: "b".repeat(191),
          reference: "r".repeat(192),
          text: "t".repeat(1000),
          amountMeaning: "INSTALLMENT_CHARGE",
          dataCompra: "1900-01-01",
        },
        {
          ...observation(),
          amountMeaning: "TOTAL_PURCHASE",
          dataCompra: "2199-12-31",
        },
      ],
      nextCursor: null,
    };
    fetchStub.mockResolvedValue(response(observations));
    await expect(getImportObservations("session-a")).resolves.toEqual(
      observations,
    );
    const candidates = {
      items: [
        {
          ...candidate(),
          id: "a".repeat(191),
          projectId: "p".repeat(191),
          description: "e\u0301".repeat(200),
          reason: "INSTALLMENT_MATCH",
          canKeepExisting: true,
          date: "2000-02-29",
        },
      ],
      nextCursor: null,
    };
    fetchStub.mockResolvedValue(response(candidates));
    await expect(getImportCandidates("session-a", "first")).resolves.toEqual(
      candidates,
    );
  });

  const badObservations: Array<[string, unknown]> = [
    ["id", ""],
    ["id", "a".repeat(192)],
    ["attachmentId", "bad/id"],
    ["reference", ""],
    ["reference", "r".repeat(193)],
    ["reference", "e\u0301"],
    ["text", null],
    ["text", "t".repeat(1001)],
    ["text", "e\u0301"],
    ["amountMeaning", "PURCHASE"],
    ["amountCents", "0"],
    ["amountCents", 0.1],
    ["amountCents", -2147483648],
    ["amountCents", 2147483648],
    ["installmentCount", 0.5],
    ["installmentIndex", "0"],
    ["installmentCount", 9007199254740992],
    ["installmentIndex", -9007199254740992],
    ["dataCompra", "2026-02-29"],
    ["dataCompra", "1899-12-31"],
    ["dataCompra", "2200-01-01"],
    ["dataCompra", "2026-10-07T00:00:00.000Z"],
  ];
  it.each(badObservations)(
    "rejects malformed observation %s=%j",
    async (field, value) => {
      fetchStub.mockResolvedValue(
        response({
          items: [{ ...observation(), [field]: value }],
          nextCursor: null,
        }),
      );
      await expect(getImportObservations("session-a")).rejects.toMatchObject({
        name: "ImportMalformedResponseError",
      });
    },
  );

  const badCandidates: Array<[string, unknown]> = [
    ["id", ""],
    ["id", "a".repeat(192)],
    ["lineId", null],
    ["projectId", "bad/id"],
    ["kind", "OBSERVATION"],
    ["description", null],
    ["amountCents", null],
    ["amountCents", "0"],
    ["amountCents", 0.1],
    ["amountCents", -2147483648],
    ["amountCents", 2147483648],
    ["date", "2026-02-30"],
    ["date", "1899-12-31"],
    ["date", "2200-01-01"],
    ["reason", "SIMILAR"],
    ["canKeepExisting", 1],
  ];
  it.each(badCandidates)(
    "rejects malformed candidate %s=%j",
    async (field, value) => {
      fetchStub.mockResolvedValue(
        response({
          items: [{ ...candidate(), [field]: value }],
          nextCursor: null,
        }),
      );
      await expect(
        getImportCandidates("session-a", "first"),
      ).rejects.toMatchObject({ name: "ImportMalformedResponseError" });
    },
  );

  describe.each([...writes, ...reads])(
    "$name failure propagation",
    ({ call }) => {
      it.each([400, 403, 404, 409, 429, 503])(
        "preserves HTTP %s and the error body without retry",
        async (status) => {
          const body = {
            code: status === 503 ? "CAPABILITY_DISABLED" : "REVISION_CONFLICT",
            retryable: true,
            sessionId: "session-a",
            currentRevision: 8,
            reason: null,
          };
          fetchStub.mockResolvedValue(response(body, status));
          const result = call();
          await expect(result).rejects.toBeInstanceOf(ApiResponseError);
          await expect(result).rejects.toMatchObject({
            message: `HTTP ${status}`,
            status,
            body,
          });
          expect(fetchStub).toHaveBeenCalledTimes(1);
        },
      );
      it("propagates the exact network error without retry", async () => {
        const error = new TypeError("offline");
        fetchStub.mockRejectedValue(error);
        await expect(call()).rejects.toBe(error);
        expect(fetchStub).toHaveBeenCalledTimes(1);
      });
      it("preserves the shared timeout semantics without retry", async () => {
        vi.useFakeTimers();
        fetchStub.mockImplementation(
          (_url, options) =>
            new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () =>
                reject(
                  Object.assign(new Error("aborted"), { name: "AbortError" }),
                ),
              );
            }),
        );
        const assertion =
          expect(call()).rejects.toBeInstanceOf(ApiTimeoutError);
        await Promise.all([assertion, vi.advanceTimersByTimeAsync(25_000)]);
        expect(fetchStub).toHaveBeenCalledTimes(1);
      });
      it("propagates invalid JSON without retry or fallback", async () => {
        fetchStub.mockResolvedValue(new Response("{", { status: 200 }));
        await expect(call()).rejects.toBeInstanceOf(SyntaxError);
        expect(fetchStub).toHaveBeenCalledTimes(1);
      });
    },
  );
});
